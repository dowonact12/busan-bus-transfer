// 평소 경로 고정 + 3분 이상 빠를 때만 추천 한 줄 + 한 줄 행동
import { describe, expect, it } from 'vitest';
import { mainLayout, pinnedAction, stripDots } from '../shared/pinned';
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
  it('3점 띠: 출발·환승·도착과 다가오는 버스', () => {
    const d = stripDots(ev([9]), USUAL, NOW);
    expect(d.map((x) => x.role)).toEqual(['출발', '환승', '도착']);
    expect(d[0].bus).toEqual({ routeNo: '29', text: '9정거장 전' });
    expect(d[1].bus!.routeNo).toBe('43');
    expect(d[2].bus).toBeNull();
  });
});
