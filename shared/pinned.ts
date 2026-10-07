// 첫 화면 단순화: 평소 경로는 항상 맨 위(연결 여부와 무관, 상태를 솔직하게), 추천은 3분 이상 빨리 도착할 때만 한 줄.
import { computeLeaveDeadline } from './evaluator';
import type { Recommendation } from './recommender';
import type { CandidateRoute, ItineraryEvaluation, Sec, Settings } from './types';

export interface MainLayout {
  /** 맨 위 고정 카드(평소 경로). 후보에 없으면 추천으로 대신 */
  pinned: ItineraryEvaluation | null;
  pinnedIsPreferred: boolean;
  /** 평소 경로보다 의미 있게(기본 3분+) 빨리 도착하는 추천. 없으면 null */
  better: { evaluation: ItineraryEvaluation; savedSec: number | null } | null;
}

const ok = (e: ItineraryEvaluation) => e.feasibility === 'comfortable' || e.feasibility === 'tight';

export function mainLayout(rec: Recommendation | null, preferredId: string | null, recommended: ItineraryEvaluation | null = rec?.recommended ?? null, windowSec = 180): MainLayout {
  if (!rec) return { pinned: null, pinnedIsPreferred: false, better: null };
  const pref = preferredId ? rec.all.find((e) => e.candidateId === preferredId) ?? null : null;
  if (!pref) return { pinned: recommended, pinnedIsPreferred: false, better: null };
  let better: MainLayout['better'] = null;
  const pAt = ok(pref) ? pref.destinationEstimate?.nominalAt ?? null : null;
  const arr = (e: ItineraryEvaluation) => e.destinationEstimate?.nominalAt ?? Infinity;
  // 알고리즘 추천이 우선, 추천이 평소 경로 자신이면 연결되는 다른 길 중 가장 빨리 도착하는 것
  const pool = [recommended, ...rec.all.filter(ok).sort((a, b) => arr(a) - arr(b) || (a.feasibility === 'comfortable' ? -1 : 1))]
    .filter((e): e is ItineraryEvaluation => !!e && e.candidateId !== pref.candidateId && ok(e) && e.destinationEstimate?.nominalAt != null);
  for (const r of pool) {
    const rAt = r.destinationEstimate!.nominalAt!;
    if (pAt == null) { better = { evaluation: r, savedSec: null }; break; } // 평소 경로는 지금 도착을 장담 못 함
    if (rAt <= pAt - windowSec) { better = { evaluation: r, savedSec: pAt - rAt }; break; }
  }
  return { pinned: pref, pinnedIsPreferred: true, better };
}

export type ActionKind = 'now' | 'in' | 'relax' | 'unknown';
export interface PinnedAction { kind: ActionKind; text: string; leaveAt: Sec | null; stopsAway: number | null; tight: boolean }

/** 첫 버스 기준 출발 마감(환승 쪽이 미확인이어도 계산) */
export function leaveDeadlineOf(ev: ItineraryEvaluation, s: Settings): Sec | null {
  if (ev.recommendedLeaveAt != null) return ev.recommendedLeaveAt;
  const fb = ev.firstBoardingEstimate, fw = ev.firstWalkEstimate;
  if (fb?.evidenceKind !== 'realtime_prediction' || fb.earliestAt == null || !fw) return null;
  return computeLeaveDeadline(fb.earliestAt, s.buildingExitHighSec, fw.highSec, s.firstBoardMarginSec);
}

/** 한 줄 행동: '지금 나가요!' / 'n분 뒤에 나가요' / '천천히, 아직 n정거장 전' */
export function pinnedAction(ev: ItineraryEvaluation, cand: CandidateRoute, now: Sec, s: Settings, relaxMin = 8): PinnedAction {
  const route = cand.legs[0].routeNo;
  const v = ev.firstVehicle;
  const realtime = ev.firstBoardingEstimate?.evidenceKind === 'realtime_prediction' && !!v;
  if (!realtime) return { kind: 'unknown', text: `${route}번 오는 차가 아직 안 보여요`, leaveAt: null, stopsAway: null, tight: false };
  const leaveAt = leaveDeadlineOf(ev, s);
  const stopsAway = v!.remainingStops ?? null;
  if (leaveAt == null || leaveAt <= now + 30) return { kind: 'now', text: '지금 나가요!', leaveAt, stopsAway, tight: leaveAt != null && leaveAt < now - 30 };
  const mins = Math.floor((leaveAt - now) / 60);
  if (mins >= relaxMin && stopsAway != null) return { kind: 'relax', text: `천천히, 아직 ${stopsAway}정거장 전`, leaveAt, stopsAway, tight: false };
  return { kind: 'in', text: `${Math.max(1, mins)}분 뒤에 나가요`, leaveAt, stopsAway, tight: false };
}

/** 3점 띠: 출발·환승·도착 + 각 점으로 오는 버스 */
export interface StripDot { role: '출발' | '환승' | '도착'; name: string; bus: { routeNo: string; text: string } | null }
export function stripDots(ev: ItineraryEvaluation, cand: CandidateRoute, now: Sec): StripDot[] {
  const l1 = cand.legs[0], l2 = cand.legs[1];
  const busText = (o: ItineraryEvaluation['firstVehicle'], where: string) => {
    if (!o || o.etaAt == null) return where ? '탈 차 아직 안 보여요' : '아직 안 보여요';
    if (o.remainingStops != null) return o.remainingStops <= 0 ? `${where}곧 도착` : `${where}${o.remainingStops}정거장 전`;
    const m = Math.max(0, Math.round((o.etaAt - now) / 60));
    return m <= 0 ? `${where}곧 도착` : `${where}${m}분 뒤`;
  };
  const dots: StripDot[] = [{ role: '출발', name: l1.board.name, bus: { routeNo: l1.routeNo, text: busText(ev.firstVehicle, '') } }];
  if (l2) dots.push({ role: '환승', name: l1.alight.name, bus: { routeNo: l2.routeNo, text: busText(ev.secondVehicle, '환승지 ') } });
  dots.push({ role: '도착', name: (l2 ?? l1).alight.name, bus: null });
  return dots;
}
