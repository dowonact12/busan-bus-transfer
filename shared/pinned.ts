// 첫 화면 단순화: 평소 경로는 항상 맨 위(연결 여부와 무관, 상태를 솔직하게), 추천은 3분 이상 빨리 도착할 때만 한 줄.
import { computeLeaveDeadline } from './evaluator';
import type { Recommendation } from './recommender';
import type { ArrivalObservation, CandidateRoute, ItineraryEvaluation, Sec, Settings, TimeEstimate } from './types';

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

export type ActionKind = 'now' | 'in' | 'relax' | 'tight_miss' | 'unknown';
export interface PinnedAction { kind: ActionKind; text: string; leaveAt: Sec | null; stopsAway: number | null; tight: boolean }

/** 첫 버스 기준 출발 마감(환승 쪽이 미확인이어도 계산) */
export function leaveDeadlineOf(ev: ItineraryEvaluation, s: Settings): Sec | null {
  if (ev.recommendedLeaveAt != null) return ev.recommendedLeaveAt;
  const fb = ev.firstBoardingEstimate, fw = ev.firstWalkEstimate;
  if ((fb?.evidenceKind !== 'realtime_prediction' && fb?.evidenceKind !== 'position_estimate') || fb.earliestAt == null || !fw) return null;
  return computeLeaveDeadline(fb.earliestAt, s.buildingExitHighSec, fw.highSec, s.firstBoardMarginSec);
}

/** 한 줄 행동: '지금 나가요!' / 'n분 뒤에 나가요' / '천천히, 아직 n정거장 전' */
/** seen: 첫 정류장에 관측된 가장 가까운 차(평가가 '못 탈 차'로 건너뛴 경우 솔직하게 '빠듯'으로) */
export function nearestSeen(observations: ArrivalObservation[] | undefined, now: Sec): ArrivalObservation | null {
  return (observations ?? []).filter((o) => o.etaAt != null && o.etaAt >= now - 30).sort((a, b) => a.etaAt! - b.etaAt!)[0] ?? null;
}

export function pinnedAction(ev: ItineraryEvaluation, cand: CandidateRoute, now: Sec, s: Settings, relaxMin = 8, seen: ArrivalObservation | null = null): PinnedAction {
  const route = cand.legs[0].routeNo;
  const v = ev.firstVehicle;
  const kind = ev.firstBoardingEstimate?.evidenceKind;
  const realtime = (kind === 'realtime_prediction' || kind === 'position_estimate') && !!v;
  const approx = kind === 'position_estimate';
  if (!realtime && seen && ev.firstBoardingEstimate?.evidenceKind !== 'headway_estimate') return { kind: 'tight_miss', text: `이번 ${route}번은 빠듯해요`, leaveAt: null, stopsAway: seen.remainingStops ?? null, tight: true };
  if (!realtime) return { kind: 'unknown', text: `${route}번 오는 차가 아직 안 보여요`, leaveAt: null, stopsAway: null, tight: false };
  const leaveAt = leaveDeadlineOf(ev, s);
  const stopsAway = v!.remainingStops ?? null;
  if (leaveAt == null || leaveAt <= now + 30) return { kind: 'now', text: '지금 나가요!', leaveAt, stopsAway, tight: leaveAt != null && leaveAt < now - 30 };
  const mins = Math.floor((leaveAt - now) / 60);
  if (mins >= relaxMin && stopsAway != null) return { kind: 'relax', text: `천천히, 아직 ${stopsAway}정거장 전`, leaveAt, stopsAway, tight: false };
  return { kind: 'in', text: `${approx ? '약 ' : ''}${Math.max(1, mins)}분 뒤에 나가요`, leaveAt, stopsAway, tight: false };
}

/** 3점 띠: 출발·환승·도착 + 각 점으로 오는 버스 + 그 정류장 시각('~' = 추정) */
export interface StopTime { label: string; at: Sec | null; est: boolean }
export interface StripDot { role: '출발' | '환승' | '도착'; name: string; bus: { routeNo: string; text: string } | null; times: StopTime[] }

export type WhereNext = 'at_origin' | 'not_departed' | null;
export const whereText = (w: WhereNext | undefined) => (w === 'at_origin' ? '다음 차 기점 대기 중' : w === 'not_departed' ? '다음 차 기점 출발 전' : null);

/** '10:12' / '~10:12' / '—' */
export function stopTimeText(t: StopTime, fmt: (s: Sec) => string): string {
  return t.at == null ? '—' : `${t.est ? '~' : ''}${fmt(t.at)}`;
}

export function stripDots(ev: ItineraryEvaluation, cand: CandidateRoute, now: Sec, seen1: ArrivalObservation | null = null, s?: Settings, where?: { first?: WhereNext; second?: WhereNext }): StripDot[] {
  const l1 = cand.legs[0], l2 = cand.legs[1];
  const busText = (o: ItineraryEvaluation['firstVehicle'], where: string) => {
    if (!o || o.etaAt == null) return where ? '탈 차 아직 안 보여요' : '아직 안 보여요';
    if (o.remainingStops != null) return o.remainingStops <= 0 ? `${where}곧 도착` : `${where}${o.remainingStops}정거장 전`;
    const m = Math.max(0, Math.round((o.etaAt - now) / 60));
    return m <= 0 ? `${where}곧 도착` : `${where}${m}분 뒤`;
  };
  const live = (e: TimeEstimate | null | undefined) => e?.evidenceKind === 'realtime_prediction' || e?.evidenceKind === 'user_confirmed';
  const t = (label: string, e: TimeEstimate | null | undefined): StopTime => ({ label, at: e?.nominalAt ?? null, est: !live(e) });
  const fb = ev.firstBoardingEstimate, ta = ev.transferArrivalEstimate, sb = ev.transferBoardingEstimate, d = ev.destinationEstimate;
  const first = ev.firstVehicle ? busText(ev.firstVehicle, '') : seen1 ? `${busText(seen1, '')} · 빠듯` : whereText(where?.first) ?? busText(null, '');
  const dots: StripDot[] = [{ role: '출발', name: l1.board.name, bus: { routeNo: l1.routeNo, text: first }, times: [t(`${l1.routeNo}번`, fb)] }];
  if (l2) dots.push({ role: '환승', name: l1.alight.name, bus: { routeNo: l2.routeNo, text: ev.secondVehicle ? busText(ev.secondVehicle, '환승지 ') : whereText(where?.second) ?? busText(null, '환승지 ') }, times: [t('내림', ta), t(`${l2.routeNo}번`, sb)] });
  // 도착 정류장 시각 = 도착 예상 − 마지막 걷기(카드의 큰 숫자는 목적지 문 앞)
  const wF = Math.round(cand.finalWalk.sec * (s?.walkMultiplier ?? 1));
  const last = (l2 ?? l1);
  // 직통이면 하차 = 첫 주행 끝(하류 실시간 일치 시 실시간), 환승이면 둘째 주행은 정적 추정이라 항상 '~'
  const stopAt = l2 ? (d?.nominalAt != null ? d.nominalAt - wF : null) : ta?.nominalAt ?? null;
  dots.push({ role: '도착', name: last.alight.name, bus: null, times: [{ label: '도착', at: stopAt, est: l2 ? true : !live(ta) }] });
  return dots;
}
