// 평소 경로 우선: 비슷한 도착 그룹 안에서만 1순위, 그룹 밖이면 첫 대안, 연결 불가면 1순위 금지
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREFERRED_BY_TRIP } from '../shared/preferences';
import { recommend, similarGroup } from '../shared/recommender';
import type { ItineraryEvaluation } from '../shared/types';
import { board, directCand, transferCand, at, lookupOf, NOW, S0 } from './helpers';
import { evaluateCandidate } from '../shared/evaluator';

const ctx = (boards: ReturnType<typeof board>[], extra: Partial<Parameters<typeof evaluateCandidate>[1]> = {}) => ({ now: NOW, settings: S0, lookup: lookupOf(boards), ...extra });

const root = path.resolve(import.meta.dirname, '..');
const fwd = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.generated.json'), 'utf8'));
const rev = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.reverse.generated.json'), 'utf8'));

describe('평소 경로 식별·정류장 검증', () => {
  it('돌아올 때(forward): 29 13706→06712, 43 06712→09199 (동래시장 같은 ARS = 같은 정류장 환승)', () => {
    const id = PREFERRED_BY_TRIP.forward.candidateId;
    const c = fwd.candidates.find((x: { id: string }) => x.id === id);
    expect(c).toBeTruthy();
    expect(c.routes).toEqual(['29', '43']);
    expect(c.legs[0].board.ars).toBe('13706');
    expect(c.legs[0].alight.ars).toBe('06712');
    expect(c.legs[1].board.ars).toBe('06712');
    expect(c.legs[1].alight.ars).toBe('09199');
    expect(c.transferWalk.sameStop).toBe(true);
    expect(c.transferWalk.sameNameDifferentArs).toBe(false);
    expect(c.legs[0].board.routeStopSequence).toBeLessThan(c.legs[0].alight.routeStopSequence);
    expect(c.legs[1].board.routeStopSequence).toBeLessThan(c.legs[1].alight.routeStopSequence);
  });

  it('갈 때(reverse): 43 09198→06707, 29 06707→13707 (안락에서 29를 일찍 탐, 같은 정류장 환승)', () => {
    const id = PREFERRED_BY_TRIP.reverse.candidateId;
    const c = rev.candidates.find((x: { id: string }) => x.id === id);
    expect(c).toBeTruthy();
    expect(c.routes).toEqual(['43', '29']);
    expect(c.legs[0].board.ars).toBe('09198');
    expect(c.legs[0].alight.ars).toBe('06707');
    expect(c.legs[1].board.ars).toBe('06707');
    expect(c.legs[1].alight.ars).toBe('13707');
    expect(c.transferWalk.sameStop).toBe(true);
    // 29 승차가 낙민(06709 seq50)보다 앞선 안락(06707 seq49)
    expect(c.legs[1].board.routeStopSequence).toBe(49);
    expect(c.legs[1].board.routeStopSequence).toBeLessThan(50);
  });

  it('반대 방향 정류장을 섞지 않는다(09199≠09198, 13706≠13707, 06712≠06711)', () => {
    const f = fwd.candidates.find((x: { id: string }) => x.id === PREFERRED_BY_TRIP.forward.candidateId);
    const r = rev.candidates.find((x: { id: string }) => x.id === PREFERRED_BY_TRIP.reverse.candidateId);
    expect(f.legs[1].alight.ars).toBe('09199');
    expect(r.legs[0].board.ars).toBe('09198');
    expect(f.legs[0].board.ars).toBe('13706');
    expect(r.legs[1].alight.ars).toBe('13707');
    expect(f.legs[0].alight.ars).toBe('06712');
  });
});

describe('평소 경로 추천 순위', () => {
  const usual = transferCand({ id: 'USUAL', r1: '29', r2: '43', firstWalkMin: 0, ride1Min: 12, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 1, sameStop: true, tArs: ['T1', 'T1'] });
  const other = transferCand({ id: 'OTHER', r1: '36', r2: '43', firstWalkMin: 0, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 1, sameStop: true, tArs: ['T1', 'T1'] });
  const direct = directCand({ id: 'DIRECT', r: 'X', firstWalkMin: 0, rideMin: 30, finalWalkMin: 1 });

  it('비슷한 도착 그룹 안에 있으면 평소 경로를 1순위로 (환승·도보가 조금 더 많아도)', () => {
    // 둘 다 도착 32분대(3분 창). OTHER는 도보가 짧아 기본 비교에서 이김
    const walky = transferCand({ id: 'USUAL', r1: '29', r2: '43', firstWalkMin: 5, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 1, sameStop: true, tArs: ['T1', 'T1'] });
    const lean = transferCand({ id: 'OTHER', r1: '36', r2: '43', firstWalkMin: 0, ride1Min: 10, transferWalkMin: 1, ride2Min: 10, finalWalkMin: 1, sameStop: true, tArs: ['T1', 'T1'] });
    const boards = [board('36', 'O1', [0]), board('29', 'O1', [0]), board('43', 'T1', [21])];
    const plain = recommend([walky, lean], ctx(boards, { journey: { phase: 'at_stop' } }));
    expect(plain.recommended?.candidateId).toBe('OTHER');
    expect(plain.similarGroupIds).toEqual(expect.arrayContaining(['USUAL', 'OTHER']));
    const withPref = recommend([walky, lean], ctx(boards, { journey: { phase: 'at_stop' } }), { preferredCandidateId: 'USUAL' });
    expect(withPref.recommended?.candidateId).toBe('USUAL');
    expect(withPref.recommendedIsPreferred).toBe(true);
    expect(withPref.reason).toContain('평소');
  });

  it('평소 경로가 그룹 밖(4분 이상 늦음)이면 1순위가 아니고 첫 대안에 평소 타는 길', () => {
    // DIRECT 빠른 도착, USUAL은 훨씬 늦음
    const boards = [
      board('X', 'O1', [0]),
      board('29', 'O1', [8]), board('43', 'T1', [35]),
    ];
    const r = recommend([usual, direct], ctx(boards, { journey: { phase: 'at_stop' } }), { preferredCandidateId: 'USUAL' });
    expect(r.recommended?.candidateId).toBe('DIRECT');
    expect(r.recommendedIsPreferred).toBe(false);
    expect(r.alternatives[0]?.evaluation.candidateId).toBe('USUAL');
    expect(r.alternatives[0]?.diffLabels[0]).toBe('평소 타는 길');
  });

  it('평소 경로가 연결 불가면 1순위로 올리지 않는다', () => {
    // USUAL: 환승 버스가 승차 가능 시각보다 이름 → infeasible. OTHER(직통)는 여유
    const boards = [
      board('29', 'O1', [0]), board('43', 'T1', [2]), // ride1=12분이라 환승 도착 ~12, 버스는 2분에 지나감
      board('X', 'O1', [3]),
    ];
    const r = recommend([usual, direct], ctx(boards, { journey: { phase: 'at_stop' } }), { preferredCandidateId: 'USUAL' });
    const u = r.all.find((e) => e.candidateId === 'USUAL')!;
    expect(['infeasible', 'unobserved_next', 'no_realtime']).toContain(u.feasibility);
    expect(r.recommended?.candidateId).toBe('DIRECT');
    expect(r.recommendedIsPreferred).toBe(false);
  });

  it('평소 ID가 후보 목록에 없어도 추천은 정상 동작', () => {
    const r = recommend([direct], ctx([board('X', 'O1', [3])], { journey: { phase: 'at_stop' } }), { preferredCandidateId: 'MISSING' });
    expect(r.recommended?.candidateId).toBe('DIRECT');
    expect(r.recommendedIsPreferred).toBe(false);
    expect(r.preferredCandidateId).toBe('MISSING');
  });

  it('3분 창 경계: T_min+3분까지만 그룹', () => {
    const mk = (id: string, min: number) => ({ candidateId: id, constituentRoutes: ['A'], destinationEstimate: { nominalAt: at(min) } }) as unknown as ItineraryEvaluation;
    const g = similarGroup([mk('fast', 40), mk('usual', 43), mk('late', 44)], 180);
    expect(g.group.map((e) => e.candidateId)).toEqual(['fast', 'usual']);
  });
});
