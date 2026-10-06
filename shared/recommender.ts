// Recommender — 후보 정렬과 추천 이유 (문서 6장). 숨겨진 단일 가중치 없이 단계적 비교.
import { evaluateCandidate, type EvalContext } from './evaluator';
import type { CandidateRoute, ItineraryEvaluation, Sec } from './types';

export interface Alternative {
  evaluation: ItineraryEvaluation;
  diffLabels: string[];
  risk: boolean;
}

export interface Recommendation {
  evaluatedAt: Sec;
  recommended: ItineraryEvaluation | null;
  recommendedIsTight: boolean;
  reason: string | null;
  alternatives: Alternative[];
  similarGroupIds: string[];
  tMin: Sec | null;
  notices: string[];
  others: ItineraryEvaluation[]; // 나머지(미확정·연결 불가 등) — 상세 목록용
  all: ItineraryEvaluation[];
}

const transfersOf = (e: ItineraryEvaluation) => e.constituentRoutes.length - 1;
const destOf = (e: ItineraryEvaluation) => e.destinationEstimate!.nominalAt!;
const routeSig = (e: ItineraryEvaluation) => e.constituentRoutes.join('>');

/** 그룹 내 비교: 환승 횟수 → 실외 대기 → 도보 → 도착시각 → 고정 ID */
export function compareInGroup(a: ItineraryEvaluation, b: ItineraryEvaluation): number {
  return (
    transfersOf(a) - transfersOf(b) ||
    (a.outdoorWaitSec ?? 0) - (b.outdoorWaitSec ?? 0) ||
    a.walkSec - b.walkSec ||
    destOf(a) - destOf(b) ||
    (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0)
  );
}

/** T_min 기준 고정 창(연쇄 확장 없음) */
export function similarGroup(evals: ItineraryEvaluation[], windowSec: number): { tMin: Sec | null; group: ItineraryEvaluation[] } {
  if (evals.length === 0) return { tMin: null, group: [] };
  const tMin = Math.min(...evals.map(destOf));
  return { tMin, group: evals.filter((e) => destOf(e) <= tMin + windowSec) };
}

const mins = (sec: number) => Math.round(sec / 60);

export function diffLabels(alt: ItineraryEvaluation, rec: ItineraryEvaluation | null): string[] {
  const out: string[] = [];
  if (alt.tier === 'estimate') out.push('배차 추정');
  if (!rec || !rec.destinationEstimate || !alt.destinationEstimate) return out;
  const d = mins(destOf(alt) - destOf(rec));
  if (d < 0) out.push(`예상 ${-d}분 빠름`);
  else if (d > 0) out.push(`예상 ${d}분 늦음`);
  else out.push('도착 비슷');
  const t = transfersOf(alt) - transfersOf(rec);
  if (transfersOf(alt) === 0 && t < 0) out.push('환승 없음');
  else if (t > 0) out.push('환승 1회 추가');
  const w = mins(alt.walkSec - rec.walkSec);
  if (w >= 1) out.push(`도보 ${w}분 추가`);
  else if (w <= -1) out.push(`도보 ${-w}분 적음`);
  if (alt.feasibility === 'tight') out.push('환승 촉박');
  const ow = mins((alt.outdoorWaitSec ?? 0) - (rec.outdoorWaitSec ?? 0));
  if (ow >= 3) out.push(`밖에서 ${ow}분 더 대기`);
  return out;
}

function reasonFor(rec: ItineraryEvaluation, group: ItineraryEvaluation[], evaluable: ItineraryEvaluation[]): string {
  const others = group.filter((e) => e.candidateId !== rec.candidateId);
  const fastest = evaluable.reduce((a, b) => (destOf(a) <= destOf(b) ? a : b));
  if (others.length === 0) return fastest.candidateId === rec.candidateId ? '확인된 후보 중 가장 빨리 도착할 것으로 예상돼요.' : '여유 있는 후보 중 가장 빨리 도착할 것으로 예상돼요.';
  if (others.some((o) => transfersOf(o) > transfersOf(rec))) return transfersOf(rec) === 0 ? '비슷하게 도착하는 환승 경로보다 갈아탈 필요가 없어요.' : '비슷하게 도착하는 다른 경로보다 환승이 적어요.';
  if (others.some((o) => (o.outdoorWaitSec ?? 0) > (rec.outdoorWaitSec ?? 0) + 30)) return '비슷하게 도착하는 다른 경로보다 밖에서 기다리는 시간이 짧아요.';
  if (others.some((o) => o.walkSec > rec.walkSec + 30)) return '비슷하게 도착하는 다른 경로보다 덜 걸어요.';
  return '비슷하게 도착하는 경로 중 가장 빨라요.';
}

export function recommend(candidates: CandidateRoute[], ctx: EvalContext): Recommendation {
  const all = candidates.map((c) => evaluateCandidate(c, ctx));
  const notices: string[] = [];
  // 1) 진행 상태와 맞지 않는 후보 제거, 2) 연결 불가·확실히 놓치는 후보 제거
  const applicable = all.filter((e) => e.feasibility !== 'not_applicable');
  const evaluable = applicable.filter((e) => (e.feasibility === 'comfortable' || e.feasibility === 'tight') && e.destinationEstimate?.nominalAt != null);
  // 3) 관측 기반 vs 배차 추정 분리
  const observed = evaluable.filter((e) => e.tier === 'observed');
  const estimated = evaluable.filter((e) => e.tier === 'estimate');
  const comfortable = observed.filter((e) => e.feasibility === 'comfortable');
  const tight = observed.filter((e) => e.feasibility === 'tight');

  if (applicable.length > 0 && applicable.every((e) => e.feasibility === 'stale')) notices.push('도착 정보가 오래됐어요. 새로고침이 필요해요.');
  if (applicable.length > 0 && applicable.every((e) => e.feasibility === 'no_realtime')) notices.push('실시간 도착 정보가 없어 추천할 수 없어요. 정적 경로만 표시해요.');

  let recommended: ItineraryEvaluation | null = null;
  let recommendedIsTight = false;
  let group: ItineraryEvaluation[] = [];
  let tMin: Sec | null = null;
  const pool = comfortable.length > 0 ? comfortable : tight;
  if (comfortable.length === 0 && tight.length > 0) {
    notices.push('여유 있게 환승할 수 있는 경로가 없어요. 아래는 촉박한 선택이에요.');
    recommendedIsTight = true;
  }
  if (pool.length > 0) {
    const g = similarGroup(pool, ctx.settings.similarWindowSec);
    tMin = g.tMin;
    group = [...g.group].sort(compareInGroup);
    recommended = group[0];
  } else if (estimated.length > 0) {
    notices.push('실제 관측된 차량으로 만든 경로가 없어요. 배차 추정 경로만 있어요.');
  }

  // 대안: 의미가 다른 것 최대 2개. 같은 노선 조합 중복 제외. 촉박·추정은 위험 표시.
  const alternatives: Alternative[] = [];
  const usedSig = new Set<string>(recommended ? [routeSig(recommended)] : []);
  const take = (e: ItineraryEvaluation | undefined) => {
    if (!e || alternatives.length >= 2 || usedSig.has(routeSig(e)) || e.candidateId === recommended?.candidateId) return;
    usedSig.add(routeSig(e));
    alternatives.push({ evaluation: e, diffLabels: diffLabels(e, recommended), risk: e.feasibility === 'tight' || e.tier === 'estimate' });
  };
  const byDest = (xs: ItineraryEvaluation[]) => [...xs].sort((a, b) => destOf(a) - destOf(b) || compareInGroup(a, b));
  // 추천보다 빠른 촉박 후보 → 다른 환승 수(직통/환승) → 나머지 빠른 순 → 배차 추정
  if (recommended) {
    take(byDest(tight).find((e) => destOf(e) < destOf(recommended!)));
    take(byDest(observed).find((e) => transfersOf(e) !== transfersOf(recommended!)));
  }
  for (const e of byDest(observed)) take(e);
  for (const e of byDest(estimated)) take(e);

  const shown = new Set([recommended?.candidateId, ...alternatives.map((a) => a.evaluation.candidateId)]);
  const others = applicable.filter((e) => !shown.has(e.candidateId));
  return {
    evaluatedAt: ctx.now, recommended, recommendedIsTight,
    reason: recommended ? reasonFor(recommended, group, pool) : null,
    alternatives, similarGroupIds: group.map((e) => e.candidateId), tMin, notices, others, all,
  };
}

/** 7.9 순위 안정성: 의미 있는 개선(기본 2분 이상)이 연속 2회 관측될 때만 추천 변경. 놓침·불가는 즉시. */
export interface StabilityState { currentId: string | null; challengerId: string | null; streak: number }
export function stabilize(prev: StabilityState, rec: Recommendation, minGainSec = 120): { state: StabilityState; displayId: string | null; switched: boolean } {
  const newId = rec.recommended?.candidateId ?? null;
  if (!prev.currentId || !newId) return { state: { currentId: newId, challengerId: null, streak: 0 }, displayId: newId, switched: prev.currentId !== newId };
  if (newId === prev.currentId) return { state: { ...prev, challengerId: null, streak: 0 }, displayId: newId, switched: false };
  const cur = rec.all.find((e) => e.candidateId === prev.currentId);
  const curOk = cur && (cur.feasibility === 'comfortable' || (cur.feasibility === 'tight' && rec.recommendedIsTight)) && cur.destinationEstimate?.nominalAt != null;
  if (!curOk) return { state: { currentId: newId, challengerId: null, streak: 0 }, displayId: newId, switched: true };
  const gain = cur!.destinationEstimate!.nominalAt! - rec.recommended!.destinationEstimate!.nominalAt!;
  const meaningful = gain >= minGainSec || (rec.recommended!.constituentRoutes.length < cur!.constituentRoutes.length && gain >= 0);
  if (!meaningful) return { state: { ...prev, challengerId: null, streak: 0 }, displayId: prev.currentId, switched: false };
  const streak = prev.challengerId === newId ? prev.streak + 1 : 1;
  if (streak >= 2) return { state: { currentId: newId, challengerId: null, streak: 0 }, displayId: newId, switched: true };
  return { state: { currentId: prev.currentId, challengerId: newId, streak }, displayId: prev.currentId, switched: false };
}
