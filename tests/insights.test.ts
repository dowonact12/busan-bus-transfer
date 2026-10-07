// 자리 힌트 · 배차 몰림 · 플랜 B (관측값만 사용)
import { describe, expect, it } from 'vitest';
import { detectBunching, detectMiss, gapToAheadMin, isRushHour, planB, seatHint, secondBusOutcome, targetOf } from '../shared/insights';
import { evaluateCandidate } from '../shared/evaluator';
import type { ArrivalBoard } from '../shared/types';
import { at, board, directCand, lookupOf, NOW, obs, S0, transferCand } from './helpers';

// NOW = 1_790_000_000 → 2026-09-22(화) 05:53 KST (출퇴근 시간 아님)
const unknownSeat = { kind: 'unknown', reason: '공급자 미제공 코드' } as const;
const fresh = (b: ArrivalBoard, t: number): ArrivalBoard => ({ ...b, fetchedAt: t, observations: b.observations.map((x) => ({ ...x, fetchedAt: t, expiryAt: t + 120 })) });
const o = (min: number, extra = {}) => ({ etaAt: at(min), remainingStops: null, seats: unknownSeat, order: 1, vehicleReference: null, ...extra });

describe('자리 힌트', () => {
  it('NOW는 출퇴근 시간이 아님(테스트 전제), 평일 08시는 출퇴근', () => {
    expect(isRushHour(NOW)).toBe(false);
    expect(isRushHour(Date.UTC(2026, 9, 7, 8 - 9, 10) / 1000)).toBe(true); // 수 08:10 KST
    expect(isRushHour(Date.UTC(2026, 9, 10, 8 - 9, 10) / 1000)).toBe(false); // 토
  });

  it('기점 3정거장째 + 앞차 바로 뒤 → 널널할 듯 (추정)', () => {
    const h = seatHint({ obs: o(5, { order: 2 }), boardSeq: 4, aheadEtaAt: at(2), now: NOW });
    expect(h).toMatchObject({ level: '널널할 듯', tag: '추정' });
    expect(h.reason).toBe('기점에서 3정거장째 + 앞차랑 3분 차이');
  });

  it('기점에서 멀고 앞차랑 12분 이상 → 붐빌 듯', () => {
    const h = seatHint({ obs: o(14, { order: 2 }), boardSeq: 60, aheadEtaAt: at(2), now: NOW });
    expect(h.level).toBe('붐빌 듯');
    expect(h.reason).toBe('기점에서 59정거장째 + 앞차랑 12분 차이');
  });

  it('순환 노선: 회차지점 뒤 정류장은 회차지점부터 셈 (29번 거제역 74 → 연제초교 91 = 17정거장째)', () => {
    const h = seatHint({ obs: o(7), boardSeq: 91, turnIdx: 74, now: NOW });
    expect(h.reason).toBe('회차지점에서 17정거장째');
    expect(h.level).toBe('보통');
  });

  it('첫 차: 지나간 앞차 위치 × 정거장당 분 + 이 차 도착까지로 간격 추정', () => {
    // 이 차: 4정거장 전, 6분 → 1.5분/정거장. 앞차는 정류장(16) 지나 6정거장 앞(22) → 9분 전에 지남 → 간격 ≈ 15분
    const g = gapToAheadMin({ obs: o(6, { remainingStops: 4 }), boardSeq: 16, vehicles: [{ stopIdx: 22, carno: 'A', lat: null, lon: null, gpsAt: null, lowFloor: null }, { stopIdx: 12, carno: 'B', lat: null, lon: null, gpsAt: null, lowFloor: null }], now: NOW });
    expect(g).toBe(15);
  });

  it('공급자 잔여좌석이 유효하면 그걸 우선하고 실시간 표시', () => {
    expect(seatHint({ obs: o(5, { seats: { kind: 'count', count: 12 } }), boardSeq: 80, now: NOW })).toMatchObject({ level: '널널할 듯', tag: '실시간', seatCount: 12 });
    expect(seatHint({ obs: o(5, { seats: { kind: 'count', count: 1 } }), boardSeq: 2, now: NOW })).toMatchObject({ level: '붐빌 듯', tag: '실시간' });
  });

  it('근거가 없으면 보통 + 근거 부족 표시(지어내지 않음)', () => {
    expect(seatHint({ obs: o(5), boardSeq: null, now: NOW })).toMatchObject({ level: '보통', reason: '근거 정보가 부족해요', tag: '추정' });
  });
});

describe('배차 몰림', () => {
  it('3분 안이나 2정거장 안이면 몰림, 아니면 없음', () => {
    expect(detectBunching(board('43', 'S', [4, 6]))).toMatchObject({ gapSec: 120 });
    const stops: ArrivalBoard = { ...board('43', 'S', []), observations: [obs('43', 'S', 4, { remainingStops: 3 }), obs('43', 'S', 9, { remainingStops: 5, order: 2 })] };
    expect(detectBunching(stops)).toMatchObject({ stopGap: 2 });
    expect(detectBunching(board('43', 'S', [4, 15]))).toBeNull();
    expect(detectBunching(board('43', 'S', [4]))).toBeNull();
  });

  it('뒤차를 타도 환승되는지: 앞차 빼고 다시 평가', () => {
    const c = transferCand({ firstWalkMin: 2, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 2 });
    const boards = [board('A', 'O1', [6, 8]), board('A', 'T1', [16, 18]), board('B', 'T1', [22, 40])];
    const ctx = { now: NOW, settings: S0, lookup: lookupOf(boards) };
    const base = evaluateCandidate(c, ctx);
    const b = detectBunching(boards[0])!;
    const r = secondBusOutcome(c, ctx, b.first, base);
    expect(r.ok).toBe(true);
    expect(r.evaluation.firstVehicle!.etaAt).toBe(at(8));
    expect(r.text).toContain('뒤차 타도 환승 돼요');
    // 환승 버스가 뒤차에 못 맞추는 경우
    const tight = [board('A', 'O1', [6, 8]), board('A', 'T1', [16, 18]), board('B', 'T1', [20])];
    const ctx2 = { now: NOW, settings: S0, lookup: lookupOf(tight) };
    const r2 = secondBusOutcome(c, ctx2, detectBunching(tight[0])!.first, evaluateCandidate(c, ctx2));
    expect(r2.ok).toBe(false);
  });
});

describe('플랜 B', () => {
  const c = directCand({ id: 'D43', r: '43', firstWalkMin: 6, rideMin: 20, finalWalkMin: 3, board: 'S' });
  const alt = directCand({ id: 'ALT', r: '36', firstWalkMin: 6, rideMin: 18, finalWalkMin: 3, board: 'S2' });

  it('놓치면 같은 노선의 다음 관측 차량 + 새 도착, 3분 안쪽 다른 경로 제안', () => {
    // 아까: 43번 차량 A가 10분 뒤 → 목표
    const before = [board('43', 'S', [10, 25])];
    before[0].observations[0].vehicleReference = 'A'; before[0].observations[1].vehicleReference = 'B';
    const ev0 = evaluateCandidate(c, { now: NOW, settings: S0, lookup: lookupOf(before) });
    const target = targetOf(ev0, c, NOW)!;
    expect(target.vehicleRef).toBe('A');
    // 5분 뒤: A는 아직 4분 뒤 도착 예측이지만 걸어서 못 감 → 평가는 B로 넘어감
    const now = NOW + 300;
    const raw = [board('43', 'S', [9, 25]), board('36', 'S2', [15])];
    raw[0].observations[0].vehicleReference = 'A'; raw[0].observations[1].vehicleReference = 'B';
    const after = raw.map((b) => fresh(b, now));
    const lk = lookupOf(after);
    const ev = evaluateCandidate(c, { now, settings: S0, lookup: lk });
    expect(ev.firstVehicle!.vehicleReference).toBe('B');
    const miss = detectMiss(target, ev, after[0], now);
    expect(miss).toBe('leave_passed');
    const altEv = evaluateCandidate(alt, { now, settings: S0, lookup: lk });
    const p = planB(target, miss!, ev, [ev, altEv]);
    expect(p.next).toMatchObject({ vehicleRef: 'B', etaAt: at(25) });
    expect(p.newArrivalAt).toBe(at(25) + 20 * 60 + 3 * 60);
    expect(p.alternative).toMatchObject({ candidateId: 'ALT' });
    expect(p.alternative!.diffSec).toBeLessThan(0); // 더 빠름
  });

  it('차가 정류장 예측에서 사라지면 bus_left, 다음 차 관측이 없으면 next=null (다음 차 정보 아직 없음)', () => {
    const target = { candidateId: 'D43', routeNo: '43', boardArs: 'S', vehicleRef: 'A', etaAt: at(3), leaveBy: null, seenAt: NOW };
    const empty = [fresh(board('43', 'S', []), NOW + 240)];
    const ev = evaluateCandidate(c, { now: NOW + 240, settings: S0, lookup: lookupOf(empty) });
    expect(detectMiss(target, ev, empty[0], NOW + 240)).toBe('bus_left');
    const p = planB(target, 'bus_left', ev, [ev]);
    expect(p.next).toBeNull();
    expect(p.newArrivalAt).toBeNull();
    expect(p.alternative).toBeNull();
  });

  it('같은 차를 계속 노리면 놓친 게 아님 / 3분보다 늦은 대안은 안 보여줌', () => {
    const b = [board('43', 'S', [10])]; b[0].observations[0].vehicleReference = 'A';
    const ev = evaluateCandidate(c, { now: NOW, settings: S0, lookup: lookupOf(b) });
    expect(detectMiss(targetOf(ev, c, NOW), ev, b[0], NOW)).toBeNull();
    const late = evaluateCandidate(alt, { now: NOW, settings: S0, lookup: lookupOf([board('36', 'S2', [40])]) });
    const p = planB(targetOf(ev, c, NOW)!, 'leave_passed', ev, [ev, late]);
    expect(p.alternative).toBeNull();
  });
});
