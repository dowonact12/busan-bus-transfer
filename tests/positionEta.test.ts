// BIMS 도착 목록(다음 2대) 밖 차량: GPS 위치 × 관측 정거장당 속도 → '위치 기반 추정'
import { describe, expect, it } from 'vitest';
import type { RouteVehicles } from '../shared/api';
import { evaluateCandidate } from '../shared/evaluator';
import { detectBunching } from '../shared/insights';
import { stopTimeText, stripDots } from '../shared/pinned';
import { augmentBoards, observedPace, PACE_DEFAULT_SEC, positionObservations } from '../shared/positionEta';
import type { ArrivalBoard } from '../shared/types';
import { at, board, lookupOf, NOW, obs, S0, transferCand } from './helpers';

const SEQ = 50; // 환승 정류장의 43번 노선 순번
const rv = (cars: [string, number, number?][], extra: Partial<RouteVehicles> = {}): RouteVehicles => ({
  routeNo: '43', lineId: 'L43', fetchedAt: NOW, origin: 'live', status: 'ok', turnIdx: null,
  vehicles: cars.map(([carno, stopIdx, gpsAgo]) => ({ carno, stopIdx, lat: null, lon: null, gpsAt: NOW - (gpsAgo ?? 10), lowFloor: null })), ...extra,
});
// BIMS가 준 2대: 6정거장 7분, 12정거장 21분 → 정거장당 70초·105초 → 중앙값 87.5 → 88초
const listed43 = (): ArrivalBoard => ({ ...board('43', 'T1', []), observations: [
  obs('43', 'T1', 7, { order: 1, remainingStops: 6, vehicleReference: '부산70자2030' }),
  obs('43', 'T1', 21, { order: 2, remainingStops: 12, vehicleReference: '부산70자2110' }),
] });

describe('정거장당 속도', () => {
  it('같은 노선 BIMS 예측의 중앙값(60~150초로 제한), 없으면 기본값', () => {
    expect(observedPace([listed43()], '43')).toEqual({ sec: 88, samples: 2 });
    expect(observedPace([listed43()], '29')).toEqual({ sec: PACE_DEFAULT_SEC, samples: 0 });
    const slow = { ...board('43', 'T1', []), observations: [obs('43', 'T1', 60, { remainingStops: 10 })] };
    expect(observedPace([slow], '43').sec).toBe(150);
  });
});

describe('위치 기반 추정 관측', () => {
  const pace = { sec: 88, samples: 2 };
  it('BIMS 목록에 없는 상류 차량만, 가까운 순, 범위·라벨 포함', () => {
    // 2030(44→6정거장)·2110(38→12)은 BIMS에 있음 → 제외. 2116(34→16)·2113(22→28) 추가. 3206(55)는 이미 지나감
    const out = positionObservations(listed43(), SEQ, rv([['부산70자2030', 44], ['부산70자2110', 38], ['부산70자2116', 34], ['부산70자2113', 22], ['부산70자3206', 55]]), pace, NOW);
    expect(out.map((o) => [o.vehicleReference, o.remainingStops])).toEqual([['부산70자2116', 16], ['부산70자2113', 28]]);
    const o = out[0];
    expect(o.estimate).toBe('position');
    expect(o.etaAt).toBe(NOW + Math.round(16 * 88 * 0.9));
    expect(o.etaLowAt).toBe(NOW + Math.round(16 * 88 * 0.7));
    expect(o.etaHighAt).toBe(NOW + Math.round(16 * 88 * 1.25) + 120);
    expect(o.rawArrivalState).toBe('위치 16정거장 전');
  });
  it('기점 대기·GPS 오래 멈춤·45정거장 넘음·BIMS 목록보다 가까운 차는 제외', () => {
    const out = positionObservations(listed43(), SEQ, rv([['A0001', 1], ['A0002', 30, 400], ['A0003', 3], ['A0004', 45], ['A0005', 40]]), pace, NOW);
    // A0001 기점(순번 1), A0002 GPS 400초 전, A0003 47정거장(>45), A0004 5정거장(BIMS 가장 먼 차 12정거장보다 가까움 → BIMS를 믿음), A0005 10정거장(역시 가까움)
    expect(out).toEqual([]);
  });
  it('위치 자료가 오래됐거나 예시면 추정하지 않음', () => {
    expect(positionObservations(listed43(), SEQ, rv([['A1', 20]], { fetchedAt: NOW - 400 }), pace, NOW)).toEqual([]);
    expect(positionObservations(listed43(), SEQ, rv([['A1', 20]], { origin: 'sample' }), pace, NOW)).toEqual([]);
    expect(positionObservations({ ...listed43(), status: 'error' }, SEQ, rv([['A1', 20]]), pace, NOW)).toEqual([]);
  });
});

// 29번(A) 6분 뒤 O1 → 10분 주행 → 16분 T1 도착, 환승 1분 + 여유 2분 → 19분 이후 43번 필요
const C = (() => { const c = transferCand({ id: 'U', r1: '29', r2: '43', firstWalkMin: 2, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 2 }); c.legs[1].board.routeStopSequence = SEQ; return c; })();
const ctx = (boards: ArrivalBoard[]) => ({ now: NOW, settings: S0, lookup: lookupOf(boards) });

describe('평가에 반영', () => {
  const early43 = (): ArrivalBoard => ({ ...board('43', 'T1', []), observations: [
    obs('43', 'T1', 7, { order: 1, remainingStops: 6, vehicleReference: '2030' }), obs('43', 'T1', 12, { order: 2, remainingStops: 9, vehicleReference: '2110' }),
  ] });
  const base = () => [board('29', 'O1', [6]), early43()];

  it('BIMS 2대가 모두 먼저 지나가면: 위치 없음 → 미확인, GPS 차 있으면 위치 기반 추정으로 연결', () => {
    expect(evaluateCandidate(C, ctx(base())).feasibility).toBe('unobserved_next');
    const aug = augmentBoards(base(), [C], { '43': rv([['2116', SEQ - 20]]) }, NOW);
    const ev = evaluateCandidate(C, ctx(aug));
    expect(ev.secondVehicle?.estimate).toBe('position');
    expect(ev.transferBoardingEstimate?.evidenceKind).toBe('position_estimate');
    expect(['comfortable', 'tight']).toContain(ev.feasibility);
    expect(ev.tier).toBe('estimate');
    expect(ev.destinationConditional).toBe(true);
    expect(ev.evidence.some((e) => e.segment === 'second_arrival' && e.evidenceKind === 'position_estimate' && e.note.includes('위치 기반 추정'))).toBe(true);
  });
  it('BIMS 차가 탈 수 있으면 그 차가 우선(위치 추정은 그 뒤 차만)', () => {
    const b = [board('29', 'O1', [6]), { ...board('43', 'T1', []), observations: [obs('43', 'T1', 25, { remainingStops: 14, vehicleReference: '2030' })] }];
    const ev = evaluateCandidate(C, ctx(augmentBoards(b, [C], { '43': rv([['2116', SEQ - 25]]) }, NOW)));
    expect(ev.secondVehicle?.vehicleReference).toBe('2030');
    expect(ev.transferBoardingEstimate?.evidenceKind).toBe('realtime_prediction');
  });
  it('하차(하류) 보드나 위치 없는 노선은 건드리지 않음', () => {
    const b = [board('29', 'O1', [6]), board('29', 'T1', [16])];
    expect(augmentBoards(b, [C], { '29': rv([['X', 2]], { routeNo: '29' }) }, NOW)).toEqual(b);
  });
  it('배차 몰림은 BIMS 차끼리만(위치 추정 제외)', () => {
    const b: ArrivalBoard = { ...board('43', 'T1', []), observations: [obs('43', 'T1', 7, { remainingStops: 6 }), { ...obs('43', 'T1', 8, { remainingStops: 7 }), estimate: 'position' }] };
    expect(detectBunching(b)).toBeNull();
  });
});

describe('정류장 시각(출발·환승·도착)', () => {
  it('실시간은 그대로, 추정은 ~, 모르면 —', () => {
    const aug = augmentBoards([board('29', 'O1', [6]), { ...board('43', 'T1', []), observations: [obs('43', 'T1', 7, { remainingStops: 6, vehicleReference: '2030' })] }], [C], { '43': rv([['2116', SEQ - 20]]) }, NOW);
    const ev = evaluateCandidate(C, ctx(aug));
    const d = stripDots(ev, C, NOW, null, S0);
    const fmt = (t: number) => `${Math.round((t - NOW) / 60)}m`;
    expect(d[0].times.map((t) => stopTimeText(t, fmt))).toEqual(['6m']); // 29번 출발 정류장 실시간
    expect(d[1].times.map((t) => t.label)).toEqual(['내림', '43번']);
    expect(stopTimeText(d[1].times[0], fmt)).toBe('~16m'); // 주행 정적 추정
    expect(d[1].times[1].est).toBe(true); // 43번 위치 기반
    expect(d[1].bus!.text).toBe('환승지 20정거장 전');
    // 도착 정류장 = 도착 예상 − 마지막 걷기(2분)
    expect(d[2].times[0].at).toBe(ev.destinationEstimate!.nominalAt! - 120);
    expect(stopTimeText(d[2].times[0], fmt).startsWith('~')).toBe(true);
    // 환승 차가 안 보이면 —
    const ev2 = evaluateCandidate(C, ctx([board('29', 'O1', [6]), board('43', 'T1', [7])]));
    const d2 = stripDots(ev2, C, NOW, null, S0);
    expect(stopTimeText(d2[1].times[1], fmt)).toBe('—');
    expect(stopTimeText(d2[2].times[0], fmt)).toBe('—');
    expect(at(0)).toBe(NOW);
  });
});

describe('다음 차 위치(시각 없이)', () => {
  it('기점~정류장 사이 목록 밖 차가 없으면 출발 전, 기점에 서 있으면 대기 중, 있으면 모름', async () => {
    const { nextBusWhere } = await import('../shared/positionEta');
    const b = { ...board('43', 'T1', []), observations: [obs('43', 'T1', 5, { remainingStops: 5, vehicleReference: '2761' })] };
    expect(nextBusWhere(b, 16, rv([['2761', 11], ['5719', 119]]), NOW)).toBe('not_departed');
    expect(nextBusWhere(b, 16, rv([['2761', 11], ['9999', 1]]), NOW)).toBe('at_origin');
    expect(nextBusWhere(b, 16, rv([['2761', 11], ['8888', 6]]), NOW)).toBeNull();
    expect(nextBusWhere(b, 16, rv([['2761', 11]], { fetchedAt: NOW - 400 }), NOW)).toBeNull();
    const { whereText } = await import('../shared/pinned');
    expect(whereText('not_departed')).toBe('다음 차 기점 출발 전');
  });
});
