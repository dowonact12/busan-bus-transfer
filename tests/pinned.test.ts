// 평소 경로 고정 + 3분 이상 빠를 때만 추천 한 줄 + 한 줄 행동
import { describe, expect, it } from 'vitest';
import { betterRouteLabel, confidentlyEarlier, destPlace, doorTime, EST_NO_RANGE_MARGIN_SEC, mainLayout, nearestSeen, pinnedAction, stripDots } from '../shared/pinned';
import { planB } from '../shared/insights';
import { recommend } from '../shared/recommender';
import { evaluateCandidate } from '../shared/evaluator';
import { at, board, directCand, lookupOf, NOW, obs, S0, transferCand } from './helpers';

const USUAL = transferCand({ id: 'USUAL', r1: '29', r2: '43', firstWalkMin: 2, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 2 });
const FAST = (rideMin: number) => directCand({ id: 'FAST', r: '36', firstWalkMin: 2, rideMin, finalWalkMin: 2, board: 'O2' });
const run = (boards: ReturnType<typeof board>[], fastRide: number) => {
  const ctx = { now: NOW, settings: S0, lookup: lookupOf(boards) };
  return recommend([USUAL, FAST(fastRide)], ctx, { preferredCandidateId: 'USUAL' });
};
// USUAL: 29 at O1 6분 → T1 16분, 43 at T1 22분 → 도착 22+10+2 = 34분
const usualOk = [board('29', 'O1', [6]), board('29', 'T1', [16]), board('43', 'T1', [22])];

describe('맨 위 고정', () => {
  it('평소 경로는 연결이 안 돼도 맨 위(pinned), 상태는 그대로', () => {
    const rec = run([board('29', 'O1', [6]), board('29', 'T1', [16]), board('43', 'T1', [17]), board('36', 'O2', [6])], 20);
    const l = mainLayout(rec, 'USUAL');
    expect(l.pinned!.candidateId).toBe('USUAL');
    expect(l.pinnedIsPreferred).toBe(true);
    expect(['comfortable', 'tight']).not.toContain(l.pinned!.feasibility);
    // 평소 경로가 도착을 장담 못 하면 연결되는 추천을 한 줄로
    expect(l.better!.evaluation.candidateId).toBe('FAST');
    expect(l.better!.savedSec).toBeNull();
  });

  it('추천이 3분 이상 빨리 도착할 때만 보여 줌(경계 포함)', () => {
    // FAST 도착 = 6 + ride + 2. USUAL 34분 → ride 23 → 31분(3분 빠름) 표시, ride 24 → 32분(2분) 숨김
    expect(mainLayout(run([...usualOk, board('36', 'O2', [6])], 23), 'USUAL').better).toMatchObject({ savedSec: 180 });
    expect(mainLayout(run([...usualOk, board('36', 'O2', [6])], 24), 'USUAL').better).toBeNull();
    expect(mainLayout(run([...usualOk, board('36', 'O2', [6])], 10), 'USUAL').better!.savedSec).toBe(16 * 60);
  });

  it('추천이 평소 경로 자신이거나 연결 안 되면 숨김', () => {
    expect(mainLayout(run([...usualOk, board('36', 'O2', [])], 10), 'USUAL').better).toBeNull();
    expect(mainLayout(null, 'USUAL')).toEqual({ pinned: null, pinnedIsPreferred: false, better: null });
  });

  it('평소 경로가 후보에 없으면 추천을 대신 올림', () => {
    const rec = run([...usualOk, board('36', 'O2', [6])], 10);
    const l = mainLayout(rec, 'MISSING');
    expect(l.pinnedIsPreferred).toBe(false);
    expect(l.pinned!.candidateId).toBe(rec.recommended!.candidateId);
  });
});

describe('한 줄 행동', () => {
  const ev = (mins: number[], extra = {}) => evaluateCandidate(USUAL, { now: NOW, settings: S0, lookup: lookupOf([{ ...board('29', 'O1', []), observations: mins.map((m, i) => obs('29', 'O1', m, { order: i + 1, remainingStops: m, ...extra })) }, board('29', 'T1', [30]), board('43', 'T1', [40])]) });
  // S0: 건물 2분 + 걷기 2분, 여유 1분 → 마감 = 도착 − 5분
  it('지금 / n분 뒤 / 천천히(8분 이상 남으면 정거장 수)', () => {
    expect(pinnedAction(ev([5]), USUAL, NOW, S0)).toMatchObject({ kind: 'now', text: '지금 나가요!' });
    expect(pinnedAction(ev([9]), USUAL, NOW, S0)).toMatchObject({ kind: 'in', text: '4분 뒤에 나가요', leaveAt: at(4) });
    expect(pinnedAction(ev([20]), USUAL, NOW, S0)).toMatchObject({ kind: 'relax', text: '천천히, 아직 20정거장 전', leaveAt: at(15) });
  });
  it('관측된 차가 없으면 솔직하게', () => {
    expect(pinnedAction(ev([]), USUAL, NOW, S0)).toMatchObject({ kind: 'unknown', text: '29번 오는 차가 아직 안 보여요' });
  });
  it('보이는 차가 있지만 못 탈 만큼 가까우면 \'빠듯\'(없다고 하지 않음)', () => {
    // 3분 뒤 도착 · 마감(도착−5분) 이미 지남 → 평가는 그 차를 건너뜀
    const e = ev([3]);
    const board1 = { ...board('29', 'O1', []), observations: [obs('29', 'O1', 3, { order: 1, remainingStops: 2 })] };
    const seen = nearestSeen(board1.observations, NOW);
    expect(e.firstVehicle).toBeNull();
    expect(pinnedAction(e, USUAL, NOW, S0, 8, seen)).toMatchObject({ kind: 'tight_miss', text: '이번 29번은 빠듯해요', stopsAway: 2 });
    expect(stripDots(e, USUAL, NOW, seen)[0].bus!.text).toBe('2정거장 전 · 빠듯');
    expect(nearestSeen([], NOW)).toBeNull();
  });
  it('3점 띠: 출발·환승·도착과 다가오는 버스', () => {
    const d = stripDots(ev([9]), USUAL, NOW);
    expect(d.map((x) => x.role)).toEqual(['출발', '환승', '도착']);
    expect(d[0].bus).toEqual({ routeNo: '29', text: '9정거장 전' });
    expect(d[1].bus!.routeNo).toBe('43');
    expect(d[2].bus).toBeNull();
  });
});

describe('문 앞 도착 vs 정류장 하차(같은 숫자 두 개로 헷갈리지 않게)', () => {
  const fmt = (t: number | null | undefined) => `${Math.round(((t ?? 0) - NOW) / 60)}m`;
  it('큰 숫자는 목적지 이름(가는 길=집, 오는 길=회사), 도착 점은 하차', () => {
    expect(destPlace('forward')).toBe('집');
    expect(destPlace('reverse')).toBe('회사');
    const e = evaluateCandidate(USUAL, { now: NOW, settings: S0, lookup: lookupOf(usualOk) });
    const d = stripDots(e, USUAL, NOW, null, S0);
    expect(d[2].times[0].label).toBe('하차');
    // 하차(정류장) + 마지막 걷기 2분 = 문 앞 도착(큰 숫자)
    expect(d[2].times[0].at! + 120).toBe(e.destinationEstimate!.nominalAt);
    expect(doorTime(e, fmt)).toBe('34m');
    expect(doorTime({ ...e, tier: 'estimate' }, fmt)).toBe('~34m');
    expect(doorTime(null, fmt)).toBeNull();
    expect(doorTime({ ...e, destinationEstimate: null }, fmt)).toBeNull();
  });
  it('추천 줄·놓쳤을 때 줄도 문 앞끼리 비교', () => {
    const rec = run([...usualOk, board('36', 'O2', [6])], 10);
    const l = mainLayout(rec, 'USUAL');
    // FAST 문 앞 6+10+2=18분, 평소 문 앞 34분 → 16분 빠름(정류장 하차끼리가 아님)
    expect(doorTime(l.better!.evaluation, fmt)).toBe('18m');
    expect(l.better!.savedSec).toBe(l.pinned!.destinationEstimate!.nominalAt! - l.better!.evaluation.destinationEstimate!.nominalAt!);
    const pb = planB({ candidateId: 'USUAL', routeNo: '29', boardArs: 'O1', vehicleRef: null, etaAt: NOW, leaveBy: null, seenAt: NOW }, 'bus_left', l.pinned!, rec!.all);
    expect(pb.newArrivalAt).toBe(l.pinned!.destinationEstimate!.nominalAt);
    expect(pb.alternative!.arrivalAt).toBe(l.better!.evaluation.destinationEstimate!.nominalAt);
  });
});

describe('추천 줄: 확실히 빠를 때만 + 같은 번호면 정류장 이름', () => {
  const fake = (id: string, tier: 'observed' | 'estimate', min: number, latestMin: number | null = null, rangeKind: 'provider' | 'assumed' | 'none' = 'assumed') => ({
    candidateId: id, tier, feasibility: 'comfortable',
    destinationEstimate: { nominalAt: at(min), earliestAt: at(min), latestAt: latestMin == null ? null : at(latestMin), evidenceKind: 'position_estimate', rangeKind, origin: 'live', basedOnObservations: [], assumptions: [] },
  }) as unknown as import('../shared/types').ItineraryEvaluation;
  const lay = (pref: ReturnType<typeof fake>, other: ReturnType<typeof fake>) => mainLayout({ recommended: other, all: [pref, other] } as never, pref.candidateId);

  it('둘 다 실시간(또는 둘 다 추정)이면 문 앞 3분+ 빠르면 표시', () => {
    expect(lay(fake('U', 'observed', 40), fake('R', 'observed', 37)).better).toMatchObject({ savedSec: 180 });
    expect(lay(fake('U', 'observed', 40), fake('R', 'observed', 38)).better).toBeNull();
    expect(lay(fake('U', 'estimate', 40), fake('R', 'estimate', 37, 45)).better).not.toBeNull();
  });
  it('추천만 추정(~)이고 평소는 실시간: 늦은 쪽도 평소보다 빨라야', () => {
    const U = fake('U', 'observed', 43);
    expect(lay(U, fake('R', 'estimate', 38, 44)).better).toBeNull(); // 실제 화면 사례: ~11:38(늦으면 11:44) vs 11:43 → 숨김
    expect(lay(U, fake('R', 'estimate', 38, 43)).better).toBeNull(); // 같으면 숨김(더 빠르다 할 수 없음)
    expect(lay(U, fake('R', 'estimate', 36, 42)).better).toMatchObject({ savedSec: 7 * 60 });
  });
  it('범위가 없으면 5분+ 빨라야', () => {
    const U = fake('U', 'observed', 43);
    expect(EST_NO_RANGE_MARGIN_SEC).toBe(300);
    expect(lay(U, fake('R', 'estimate', 39)).better).toBeNull(); // 4분
    expect(lay(U, fake('R', 'estimate', 38)).better).not.toBeNull(); // 5분
    expect(lay(U, fake('R', 'estimate', 39, 39)).better).toBeNull(); // 늦은 쪽 = 그대로 → 범위 없음
    expect(lay(U, fake('R', 'estimate', 39, 41, 'none')).better).toBeNull();
    expect(confidentlyEarlier(fake('R', 'estimate', 38), U, at(43))).toBe(true);
  });
  it('확신 못 하는 더 빠른 길은 건너뛰고, 확실한 다음 길을 보여 줌', () => {
    const U = fake('U', 'observed', 43), R1 = fake('R1', 'estimate', 37, 46), R2 = fake('R2', 'observed', 39);
    const l = mainLayout({ recommended: R1, all: [U, R1, R2] } as never, 'U');
    expect(l.better!.evaluation.candidateId).toBe('R2');
  });
  it('버스 번호가 같으면 다른 정류장 이름을 붙임', () => {
    const U = transferCand({ id: 'U', r1: '29', r2: '43', firstWalkMin: 2, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 2 });
    const otherBoard = { ...U, id: 'B', legs: [{ ...U.legs[0], board: { ...U.legs[0].board, ars: 'O9', name: '연산교차로' } }, U.legs[1]] };
    expect(betterRouteLabel(otherBoard, U)).toBe('연산교차로에서 29→43번');
    const otherTransfer = transferCand({ id: 'B2', r1: '29', r2: '43', firstWalkMin: 2, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 2, tArs: ['T5', 'T5'], names: ['수안역', '수안역'] });
    expect(betterRouteLabel(otherTransfer, U)).toBe('29→43번(수안역 환승)');
    expect(betterRouteLabel(FAST(10), U)).toBe('36번'); // 번호가 다르면 그대로
    expect(betterRouteLabel(U, null)).toBe('29→43번');
  });
});
