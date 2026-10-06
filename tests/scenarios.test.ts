import { describe, expect, it } from 'vitest';
import { classifyTransfer, computeLeaveDeadline, evaluateCandidate } from '../shared/evaluator';
import { recommend, similarGroup, stabilize } from '../shared/recommender';
import { normalizeBimsArrivalItem, parseMinutes, parseSeat, seatLabel } from '../shared/normalizer';
import { matchDownstreamVehicle, matchSameStopVehicle } from '../shared/vehicle';
import { crowdDisplay } from '../shared/crowd';
import { DEFAULT_SETTINGS, type ItineraryEvaluation } from '../shared/types';
import { M, NOW, S0, at, board, directCand, lookupOf, obs, transferCand } from './helpers';

const ctx = (boards: ReturnType<typeof board>[], extra: Partial<Parameters<typeof evaluateCandidate>[1]> = {}) => ({ now: NOW, settings: S0, lookup: lookupOf(boards), ...extra });
const rel = (t: number | null | undefined) => (t == null ? null : (t - NOW) / M);

describe('T01 첫 버스 놓침', () => {
  it('준비+보행 5분, 여유 1분 → 3분 차량 제외, 9분 차량 선택', () => {
    // 건물 출입 2분 + 보행 3분 = 5분
    const c = directCand({ firstWalkMin: 3, rideMin: 20, finalWalkMin: 2 });
    const e = evaluateCandidate(c, ctx([board('X', 'O1', [3, 9])]));
    expect(rel(e.firstReadyAt)).toBe(5);
    expect(rel(e.firstVehicle?.etaAt)).toBe(9);
    expect(rel(e.firstBoardingEstimate?.nominalAt)).toBe(9);
    expect(e.leaveAdvice.kind).not.toBe('none');
  });
});

describe('T02 첫 주행시간 누락 방지', () => {
  const c = transferCand({ firstWalkMin: 0, ride1Min: 18, transferWalkMin: 3, ride2Min: 10, finalWalkMin: 2 });
  it('환승 준비 25분, 여유 포함 27분, 12·24분 차량 연결 불가, 이후 미확인 → 미확정', () => {
    const e = evaluateCandidate(c, ctx([board('A', 'O1', [4]), board('B', 'T1', [12, 24])], { journey: { phase: 'at_stop' } }));
    expect(rel(e.firstBoardingEstimate?.nominalAt)).toBe(4);
    expect(rel(e.transferReadyEstimate?.nominalAt)).toBe(25);
    expect(rel(e.transferRequiredAt)).toBe(27);
    expect(e.secondVehicle).toBeNull();
    expect(e.feasibility).toBe('unobserved_next');
    expect(e.destinationEstimate).toBeNull();
    expect(e.totalSec).toBeNull();
  });
});

describe('T03 대기와 여유 구분', () => {
  it('두 번째 차량 30분 → 환승 대기 5분, 계산상 여유 3분', () => {
    const c = transferCand({ firstWalkMin: 0, ride1Min: 18, transferWalkMin: 3, ride2Min: 10, finalWalkMin: 2 });
    const e = evaluateCandidate(c, ctx([board('A', 'O1', [4]), board('B', 'T1', [12, 24, 30])], { journey: { phase: 'at_stop' } }));
    expect(e.transferWaitSec! / M).toBe(5);
    expect(e.transferSlackSec! / M).toBe(3);
    expect(e.transferWaitSec).not.toBe(e.transferSlackSec);
  });
});

describe('T04 정상 환승과 최종 도착', () => {
  it('환승 준비 21, 여유 포함 23, 대기 5, 여유 3, 최종 41분', () => {
    const c = transferCand({ firstWalkMin: 0, ride1Min: 12, transferWalkMin: 2, ride2Min: 11, finalWalkMin: 4 });
    const e = evaluateCandidate(c, ctx([board('A', 'O1', [7]), board('B', 'T1', [26])], { journey: { phase: 'at_stop' } }));
    expect(rel(e.transferReadyEstimate?.nominalAt)).toBe(21);
    expect(rel(e.transferRequiredAt)).toBe(23);
    expect(e.transferWaitSec! / M).toBe(5);
    expect(e.transferSlackSec! / M).toBe(3);
    expect(rel(e.destinationEstimate?.nominalAt)).toBe(41);
    expect(e.totalSec! / M).toBe(41); // 여유를 총 시간에 두 번 더하지 않음
    expect(e.feasibility).toBe('comfortable');
  });
});

describe('T05 출발 마감의 부호', () => {
  it('이른 도착 10분, 출입 2, 보행 4, 여유 1 → 3분 후', () => {
    expect((computeLeaveDeadline(at(10), 2 * M, 4 * M, 1 * M) - NOW) / M).toBe(3);
  });
  it('평가 경로에서도 3분 후, 5분으로 늦추지 않음', () => {
    const c = directCand({ firstWalkMin: 4, rideMin: 10, finalWalkMin: 1 });
    const e = evaluateCandidate(c, ctx([board('X', 'O1', [10])]));
    expect(rel(e.recommendedLeaveAt)).toBe(3);
    expect(e.leaveAdvice).toMatchObject({ kind: 'leave_in', minutes: 3 });
  });
});

describe('T06 동명 정류장', () => {
  it('이름 같고 ARS 다르면 별도 지점 — 0분 환승 금지, 동선 확인 경고', () => {
    const c = transferCand({ firstWalkMin: 0, ride1Min: 10, transferWalkMin: 2, ride2Min: 5, finalWalkMin: 1, tArs: ['06173', '06708'], names: ['안락동우체국.동해선안락역', '안락동우체국.동해선안락역'] });
    expect(c.transferWalk!.sameStop).toBe(false);
    const e = evaluateCandidate(c, ctx([board('A', 'O1', [2]), board('B', '06708', [20])], { journey: { phase: 'at_stop' } }));
    expect(rel(e.transferReadyEstimate?.nominalAt)).toBe(14); // 12 + 보행 2 (0 아님)
    expect(e.warnings.some((w) => w.includes('같은 이름이지만 다른 정류장'))).toBe(true);
  });
  it('ARS는 문자열로 앞자리 0 보존', () => {
    const o = normalizeBimsArrivalItem({ lineno: '43', min1: '3' }, { stopArs: '06708', fetchedAt: NOW, origin: 'test' });
    expect(o[0].stopArs).toBe('06708');
  });
});

describe('T07 단위와 특수 상태', () => {
  it("min1='5' → 약 300초, min2='운행대기' → 차량 생성 안 함", () => {
    const o = normalizeBimsArrivalItem({ lineno: '36', min1: '5', min2: '운행대기' }, { stopArs: '13051', fetchedAt: NOW, origin: 'test' });
    expect(o[0].etaAt! - NOW).toBe(300);
    expect(o[1].etaAt).toBeNull();
    expect(o[1].observationStatus).toBe('waiting');
    expect(Number.isNaN(o[1].etaAt as unknown as number)).toBe(false);
    expect(parseMinutes('0', NOW).etaAt).toBe(NOW);
    // 운행대기만 있으면 평가도 '운행대기' 상태
    const c = directCand({ firstWalkMin: 1, rideMin: 10, finalWalkMin: 1, r: '36', board: '13051' });
    const e = evaluateCandidate(c, ctx([{ stopArs: '13051', routeNo: '36', observations: [o[1]], fetchedAt: NOW, status: 'ok', origin: 'test' }]));
    expect(e.feasibility).toBe('waiting');
    expect(e.destinationEstimate).toBeNull();
  });
});

describe('T08 결측 좌석', () => {
  it('-1, null → 확인 불가 / 0 → 빈좌석 없음(만차 아님) / 5 → 5석', () => {
    expect(parseSeat('-1').kind).toBe('unknown');
    expect(parseSeat(null).kind).toBe('unknown');
    expect(parseSeat('0')).toEqual({ kind: 'count', count: 0 });
    expect(parseSeat('5')).toEqual({ kind: 'count', count: 5 });
    expect(seatLabel(parseSeat('0'))).not.toContain('만차입니다');
    expect(seatLabel(parseSeat('0'))).toContain('만차 여부는 알 수 없음');
    expect(seatLabel(parseSeat('-1'))).toBe('잔여좌석 확인 불가');
  });
});

describe('T09 데이터가 오래됨', () => {
  it('stale 기준 초과 + 갱신 실패 → 과거 도착을 줄여 안내하지 않음, 갱신 필요', () => {
    const c = directCand({ firstWalkMin: 1, rideMin: 10, finalWalkMin: 1 });
    const old = board('X', 'O1', [8, 15], { fetchedAt: NOW - 200, status: 'error' });
    const e = evaluateCandidate(c, ctx([old]));
    expect(e.feasibility).toBe('stale');
    expect(e.destinationEstimate).toBeNull();
    expect(e.leaveAdvice.kind).toBe('none');
    const r = recommend([c], ctx([old]));
    expect(r.recommended).toBeNull();
    expect(r.notices.join()).toContain('새로고침');
  });
  it('60~120초는 주의 표시, 출발 카운트다운 대신 보수적 안내', () => {
    const c = directCand({ firstWalkMin: 1, rideMin: 10, finalWalkMin: 1 });
    const e = evaluateCandidate(c, ctx([board('X', 'O1', [12], { fetchedAt: NOW - 90 })]));
    expect(e.warnings.join()).toContain('오래된 정보');
    expect(e.leaveAdvice.kind).toBe('conservative_now');
  });
});

describe('T10 두 대 이후 관측 공백', () => {
  const c = transferCand({ firstWalkMin: 0, ride1Min: 15, transferWalkMin: 2, ride2Min: 5, finalWalkMin: 1 });
  it('장래 차량을 생성하지 않음', () => {
    const e = evaluateCandidate(c, ctx([board('A', 'O1', [3]), board('B', 'T1', [5, 12])], { journey: { phase: 'at_stop' } }));
    expect(e.feasibility).toBe('unobserved_next');
    expect(e.secondVehicle).toBeNull();
    expect(e.transferBoardingEstimate).toBeNull();
  });
  it('배차 추정을 켜고 근거(배차)가 있으면 추정 표시·별도 순위', () => {
    const boards = [board('A', 'O1', [3]), board('B', 'T1', [5, 12], { headwaySec: 10 * M })];
    const s = { ...S0, allowHeadwayEstimate: true };
    const e = evaluateCandidate(c, ctx(boards, { settings: s, journey: { phase: 'at_stop' } }));
    expect(e.tier).toBe('estimate');
    expect(e.transferBoardingEstimate?.evidenceKind).toBe('headway_estimate');
    expect(e.transferBoardingEstimate?.assumptions.join()).toContain('배차');
    const d = directCand({ id: 'D', firstWalkMin: 0, rideMin: 40, finalWalkMin: 1 });
    const r = recommend([c, d], { ...ctx([...boards, board('X', 'O1', [2])], { settings: s, journey: { phase: 'at_stop' } }) });
    expect(r.recommended?.candidateId).toBe('D'); // 추정 후보를 확정 1위로 올리지 않음
    expect(r.alternatives.find((a) => a.evaluation.candidateId === 'T')?.diffLabels).toContain('배차 추정');
  });
});

describe('T11 시간대 통계와 현재 인파', () => {
  it('평소 통계는 지금 정류장 혼잡으로 표시하지 않고 승차 판단에 쓰지 않음', () => {
    const d = crowdDisplay({ kind: 'people_area', source: '부산 생활인구', scopeId: '연산5동', scopeKind: 'admin_dong', observedAt: null, fetchedAt: NOW, temporalKind: 'historical_typical', value: 1200, unit: '명', level: null, missingReason: null }, 'people_area', NOW);
    expect(d.isCurrent).toBe(false);
    expect(d.label).toContain('지금 상황 아님');
    expect(d.label).not.toContain('정류장');
    expect(d.usableForBoardingDecision).toBe(false);
    expect(crowdDisplay(null, 'people_area', NOW).label).toContain('확인 불가');
  });
});

describe('T12 이미 탑승함', () => {
  it('A 탑승 확정 후 다른 출발 정류장의 더 빠른 B는 제외', () => {
    const a1 = transferCand({ id: 'A-via-T1', r1: 'A', firstWalkMin: 0, ride1Min: 10, transferWalkMin: 1, ride2Min: 5, finalWalkMin: 1 });
    const b = directCand({ id: 'B-fast', r: 'Bx', board: 'O2', firstWalkMin: 0, rideMin: 5, finalWalkMin: 1 });
    const boards = [board('B', 'T1', [14]), board('Bx', 'O2', [1])];
    const r = recommend([a1, b], ctx(boards, { journey: { phase: 'on_first_bus', boarded: { routeNo: 'A', boardArs: 'O1', vehicleReference: null, vehicleConfirmed: false, boardedAt: NOW - 60 } } }));
    expect(r.recommended?.candidateId).toBe('A-via-T1');
    expect(r.all.find((e) => e.candidateId === 'B-fast')?.feasibility).toBe('not_applicable');
    expect(r.alternatives.map((x) => x.evaluation.candidateId)).not.toContain('B-fast');
  });
});

describe('T13 분기·순환·앞뒤 차량 교체', () => {
  it('같은 번호 다른 노선ID(방향/변형)는 다른 서비스', () => {
    const prev = obs('36', '13051', 7, { vehicleReference: '4402', lineId: '5200036000', remainingStops: 2 });
    const other = obs('36', '13051', 5, { vehicleReference: '4402', lineId: '5200036100', remainingStops: 1 });
    expect(matchSameStopVehicle(prev, [other]).status).toBe('unmatched');
  });
  it('갱신 후 순번이 바뀌어도 순번이 아니라 차량번호+노선+남은 정류장으로 정황 일치(확정 아님)', () => {
    const prev = obs('36', '13051', 7, { vehicleReference: '4402', lineId: '5200036000', remainingStops: 2, order: 2 });
    const now1 = obs('36', '13051', 4, { vehicleReference: '4408', lineId: '5200036000', remainingStops: 1, order: 2 });
    const now2 = obs('36', '13051', 5, { vehicleReference: '4402', lineId: '5200036000', remainingStops: 1, order: 1 });
    const m = matchSameStopVehicle(prev, [now1, now2]);
    expect(m.status).toBe('consistent');
    expect(m.match?.vehicleReference).toBe('4402');
    expect(m.status).not.toBe('confirmed' as never);
  });
  it('차량번호 4자리가 같아도 남은 정류장이 맞지 않으면 하류 일치로 보지 않음', () => {
    const atBoard = obs('36', '13051', 7, { vehicleReference: '4402', lineId: '5200036000', remainingStops: 2 });
    const wrong = obs('36', '06706', 30, { vehicleReference: '4402', lineId: '5200036000', remainingStops: 25 });
    const right = obs('36', '06706', 18, { vehicleReference: '4402', lineId: '5200036000', remainingStops: 10 });
    expect(matchDownstreamVehicle(atBoard, [wrong], 8).status).toBe('unmatched');
    expect(matchDownstreamVehicle(atBoard, [right], 8).status).toBe('consistent');
  });
  it('차량번호가 같은 후보가 둘이면 모호', () => {
    const prev = obs('36', '13051', 9, { vehicleReference: '4402', remainingStops: 5 });
    const x = obs('36', '13051', 5, { vehicleReference: '4402', remainingStops: 3 });
    const y = obs('36', '13051', 7, { vehicleReference: '4402', remainingStops: 4 });
    expect(matchSameStopVehicle(prev, [x, y]).status).toBe('ambiguous');
  });
});

describe('T14 직통 대안', () => {
  it('직통 40분, 환승 42분 → 직통 추천', () => {
    const d = directCand({ id: 'D', firstWalkMin: 0, rideMin: 39, finalWalkMin: 1 }); // 0 + 39 + 1 = 40 (at_stop, 즉시 승차)
    const t = transferCand({ id: 'T', firstWalkMin: 0, ride1Min: 20, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 1 });
    const boards = [board('X', 'O1', [0]), board('A', 'O1', [0]), board('B', 'T1', [31])];
    const r = recommend([d, t], ctx(boards, { journey: { phase: 'at_stop' } }));
    const dest = (id: string) => rel(r.all.find((e) => e.candidateId === id)!.destinationEstimate!.nominalAt);
    expect(dest('D')).toBe(40);
    expect(dest('T')).toBe(42);
    expect(r.recommended?.candidateId).toBe('D');
    expect(r.reason).toContain('갈아탈 필요가 없어요');
  });
  it('40·42·44분 → 3분 그룹은 40·42만 (연쇄 확장 없음)', () => {
    const mk = (id: string, min: number) => ({ candidateId: id, constituentRoutes: ['A', 'B'], destinationEstimate: { nominalAt: at(min) } }) as unknown as ItineraryEvaluation;
    const g = similarGroup([mk('a', 40), mk('b', 42), mk('c', 44)], 180);
    expect(g.group.map((e) => e.candidateId)).toEqual(['a', 'b']);
  });
});

describe('T15 막차', () => {
  it('마지막 확인 차량 이후 정보 없음 → 가상 차량 생성 안 함, 운행 확인 필요', () => {
    const c = directCand({ firstWalkMin: 5, rideMin: 10, finalWalkMin: 1 });
    const boards = [board('X', 'O1', [2], { headwaySec: 15 * M, lastBusPassed: true })];
    const e = evaluateCandidate(c, ctx(boards, { settings: { ...S0, allowHeadwayEstimate: true } }));
    expect(e.feasibility).toBe('unobserved_next');
    expect(e.firstBoardingEstimate).toBeNull();
    const empty = evaluateCandidate(c, ctx([board('X', 'O1', [])]));
    expect(empty.feasibility).toBe('no_realtime');
    expect(empty.warnings.join()).toContain('운행 종료로 단정하지 않음');
  });
});

describe('T17 예측 근거 혼합', () => {
  it('첫 도착 실시간 / 첫 주행 정적 / 둘째 배차 추정 → 구간별 근거 분리, 단일 실시간 배지 아님', () => {
    const c = transferCand({ firstWalkMin: 0, ride1Min: 15, transferWalkMin: 2, ride2Min: 5, finalWalkMin: 1 });
    const boards = [board('A', 'O1', [3]), board('B', 'T1', [4], { headwaySec: 12 * M })];
    const e = evaluateCandidate(c, ctx(boards, { settings: { ...S0, allowHeadwayEstimate: true }, journey: { phase: 'at_stop' } }));
    const kinds = Object.fromEntries(e.evidence.map((x) => [x.segment, x.evidenceKind]));
    expect(kinds.first_arrival).toBe('realtime_prediction');
    expect(kinds.first_ride).toBe('static_duration');
    expect(kinds.second_arrival).toBe('headway_estimate');
    expect(new Set(e.evidence.map((x) => x.evidenceKind)).size).toBeGreaterThan(1);
    expect(e.destinationEstimate?.evidenceKind).toBe('headway_estimate');
  });
  it('촉박 환승 + 다음 차량 미관측 → 성공 시 도착과 놓쳤을 때 미확정 구분, 좁은 상한 없음', () => {
    const s = { ...DEFAULT_SETTINGS }; // 범위 있는 기본 설정
    const c = transferCand({ firstWalkMin: 0, ride1Min: 15, transferWalkMin: 2, ride2Min: 5, finalWalkMin: 1, ride1Range: [12, 20] });
    const e = evaluateCandidate(c, { now: NOW, settings: s, lookup: lookupOf([board('A', 'O1', [3]), board('B', 'T1', [23])]), journey: { phase: 'at_stop' } });
    expect(e.feasibility).toBe('tight');
    expect(e.destinationConditional).toBe(true);
    expect(e.destinationEstimate?.nominalAt).not.toBeNull();
    expect(e.destinationEstimate?.latestAt).toBeNull();
    expect(e.destinationIfMissed).toBeNull();
    expect(e.warnings.join()).toContain('놓치면 다음 차량 미확인');
  });
  it('촉박 환승 + 다음 차량 관측 → 놓쳤을 때 도착 별도 계산', () => {
    const c = transferCand({ firstWalkMin: 0, ride1Min: 15, transferWalkMin: 2, ride2Min: 5, finalWalkMin: 1, ride1Range: [12, 20] });
    const e = evaluateCandidate(c, { now: NOW, settings: DEFAULT_SETTINGS, lookup: lookupOf([board('A', 'O1', [3]), board('B', 'T1', [23, 35])]), journey: { phase: 'at_stop' } });
    expect(e.feasibility).toBe('tight');
    expect(rel(e.destinationIfMissed?.nominalAt)).toBe(41);
  });
});

describe('7.8 환승 상태 분류 / 7.9 안정성', () => {
  it('분류 경계', () => {
    expect(classifyTransfer(at(20), at(22), at(24), at(26), 2 * M)).toBe('comfortable');
    expect(classifyTransfer(at(20), at(22), at(18), at(21), 2 * M)).toBe('infeasible');
    expect(classifyTransfer(at(20), at(22), at(22), at(25), 2 * M)).toBe('tight');
  });
  it('의미 있는 개선이 연속 2회일 때만 추천 변경', () => {
    const d1 = directCand({ id: 'D1', firstWalkMin: 0, rideMin: 30, finalWalkMin: 0 });
    const d2 = directCand({ id: 'D2', r: 'Y', firstWalkMin: 0, rideMin: 30, finalWalkMin: 0 });
    const run = (m1: number, m2: number) => recommend([d1, d2], ctx([board('X', 'O1', [m1]), board('Y', 'O1', [m2])], { journey: { phase: 'at_stop' } }));
    let st = stabilize({ currentId: null, challengerId: null, streak: 0 }, run(5, 6));
    expect(st.displayId).toBe('D1');
    st = stabilize(st.state, run(9, 5));
    expect(st.displayId).toBe('D1');
    st = stabilize(st.state, run(9, 5));
    expect(st.displayId).toBe('D2');
  });
});
