// 화면 도우미(모두 관측값 기반, 없는 버스를 만들지 않음):
//  1) 자리 힌트: 기점(또는 회차지점)에서 몇 정거장째 + 앞차와 간격(+출퇴근 시간) → 널널할 듯/보통/붐빌 듯 (추정)
//     공급자 잔여좌석(seat)이 유효하면 그것을 우선(실시간)
//  2) 배차 몰림: 같은 노선 두 대가 2정거장·3분 안으로 붙어 오면 표시 + 뒤차를 타도 되는지
//  3) 플랜 B: 노리던 차를 놓치면 같은 노선의 다음 '관측된' 차와 새 도착, 3분 안쪽(또는 더 빠른) 다른 경로
import { evaluateCandidate, type EvalContext } from './evaluator';
import type { ArrivalBoard, ArrivalObservation, CandidateRoute, ItineraryEvaluation, Sec } from './types';
import type { VehiclePosition } from './api';

// ── 1) 자리 힌트 ──
export type SeatLevel = '널널할 듯' | '보통' | '붐빌 듯';
export interface SeatHint { level: SeatLevel; reason: string; tag: '추정' | '실시간'; score: number; seatCount?: number }

export interface SeatHintInput {
  obs: Pick<ArrivalObservation, 'etaAt' | 'remainingStops' | 'seats' | 'order' | 'vehicleReference'>;
  /** 이 정류장의 노선 순번(bstopidx = 기점부터 순번) */
  boardSeq: number | null | undefined;
  /** 회차지점 순번(busInfoByRouteId rpoint=1). 순환 노선이면 회차 뒤 정류장은 회차지점부터 셈 */
  turnIdx?: number | null;
  /** 같은 정류장에서 바로 앞 순번 차량(order-1)의 도착 예측. 첫 차면 null */
  aheadEtaAt?: Sec | null;
  /** 노선 차량 위치(앞차가 이미 지나간 경우 간격 추정용) */
  vehicles?: VehiclePosition[] | null;
  now: Sec;
}

const KST = 9 * 3600;
export function isRushHour(t: Sec): boolean {
  const d = new Date((t + KST) * 1000);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 7 * 60 && m < 9 * 60) || (m >= 17 * 60 + 30 && m < 19 * 60 + 30);
}

/** 앞차와의 간격(분). 두 번째 차면 같은 정류장 예측 차이, 첫 차면 지나간 앞차 위치 × 정거장당 분 + 이 차 도착까지 */
export function gapToAheadMin(i: SeatHintInput): number | null {
  const eta = i.obs.etaAt;
  if (eta == null) return null;
  if (i.aheadEtaAt != null) return Math.max(0, Math.round((eta - i.aheadEtaAt) / 60));
  if (!i.vehicles?.length || i.boardSeq == null) return null;
  const ahead = i.vehicles.filter((v) => v.stopIdx > i.boardSeq!).sort((a, b) => a.stopIdx - b.stopIdx)[0];
  if (!ahead) return null;
  const etaMin = Math.max(0, (eta - i.now) / 60);
  const mps = i.obs.remainingStops && i.obs.remainingStops > 0 ? Math.min(3, Math.max(0.8, etaMin / i.obs.remainingStops)) : 1.5;
  return Math.round((ahead.stopIdx - i.boardSeq) * mps + etaMin);
}

export function seatHint(i: SeatHintInput): SeatHint {
  const s = i.obs.seats;
  if (s.kind === 'count') {
    const level: SeatLevel = s.count >= 10 ? '널널할 듯' : s.count >= 3 ? '보통' : '붐빌 듯';
    return { level, reason: `잔여좌석 ${s.count}석(버스 정보)`, tag: '실시간', score: 0, seatCount: s.count };
  }
  let score = 0;
  const parts: string[] = [];
  if (i.boardSeq != null) {
    const afterTurn = i.turnIdx != null && i.boardSeq > i.turnIdx;
    const n = afterTurn ? i.boardSeq - i.turnIdx! : i.boardSeq - 1;
    parts.push(`${afterTurn ? '회차지점' : '기점'}에서 ${n}정거장째`);
    score += n <= 5 ? 2 : n <= 15 ? 1 : n <= 40 ? 0 : -1;
  }
  const gap = gapToAheadMin(i);
  if (gap != null) {
    parts.push(`앞차랑 ${gap}분 차이`);
    score += gap >= 12 ? -1 : gap <= 4 ? 1 : 0;
  }
  if (isRushHour(i.now)) { parts.push('출퇴근 시간'); score -= 1; }
  const level: SeatLevel = score >= 2 ? '널널할 듯' : score <= -1 ? '붐빌 듯' : '보통';
  return { level, reason: parts.length ? parts.join(' + ') : '근거 정보가 부족해요', tag: '추정', score };
}

// ── 2) 배차 몰림 ──
export interface Bunching { first: ArrivalObservation; second: ArrivalObservation; gapSec: number; stopGap: number | null }

export function detectBunching(board: ArrivalBoard | undefined, maxStops = 2, maxSec = 180): Bunching | null {
  if (!board) return null;
  // BIMS가 준 차량끼리만(위치 기반 추정은 제외)
  const o = board.observations.filter((x) => x.etaAt != null && !x.estimate).sort((a, b) => a.etaAt! - b.etaAt!);
  if (o.length < 2) return null;
  const [first, second] = o;
  const gapSec = second.etaAt! - first.etaAt!;
  const stopGap = first.remainingStops != null && second.remainingStops != null ? second.remainingStops - first.remainingStops : null;
  if (gapSec <= maxSec || (stopGap != null && stopGap <= maxStops)) return { first, second, gapSec, stopGap };
  return null;
}

export interface SecondBusOutcome { ok: boolean; evaluation: ItineraryEvaluation; delaySec: number | null; text: string }

/** 앞차를 보내고 뒤차를 탄다면: 첫 정류장 관측에서 앞차를 빼고 다시 평가 */
export function secondBusOutcome(cand: CandidateRoute, ctx: EvalContext, skip: ArrivalObservation, baseline: ItineraryEvaluation | null): SecondBusOutcome {
  const leg1 = cand.legs[0];
  const lookup = (ars: string, routeNo: string) => {
    const b = ctx.lookup(ars, routeNo);
    if (!b || ars !== leg1.board.ars || routeNo !== leg1.routeNo) return b;
    return { ...b, observations: b.observations.filter((x) => !(x.etaAt === skip.etaAt && x.vehicleReference === skip.vehicleReference)) };
  };
  const ev = evaluateCandidate(cand, { ...ctx, lookup });
  const okFeas = ev.feasibility === 'comfortable' || ev.feasibility === 'tight';
  const base = baseline?.destinationEstimate?.nominalAt ?? null;
  const d = ev.destinationEstimate?.nominalAt ?? null;
  const delaySec = base != null && d != null ? d - base : null;
  const later = delaySec != null ? ` · 도착 ${Math.max(0, Math.round(delaySec / 60))}분 늦어요` : '';
  let text: string;
  if (cand.kind === 'transfer') {
    text = ev.feasibility === 'comfortable' ? `뒤차 타도 환승 돼요${later}` : ev.feasibility === 'tight' ? `뒤차면 환승이 빠듯해요${later}` : okFeas ? `뒤차 타도 괜찮아요${later}` : '뒤차면 환승 연결이 아직 확인 안 돼요';
  } else {
    text = d != null ? `뒤차 타도 ${later ? later.slice(3) : '도착 시각이 비슷해요'}` : '뒤차 도착 시각은 아직 몰라요';
  }
  return { ok: okFeas, evaluation: ev, delaySec, text };
}

// ── 3) 플랜 B ──
export interface Target { candidateId: string; routeNo: string; boardArs: string; vehicleRef: string | null; etaAt: Sec; leaveBy: Sec | null; seenAt: Sec }

export function targetOf(ev: ItineraryEvaluation, cand: CandidateRoute, now: Sec): Target | null {
  const v = ev.firstVehicle;
  if (!v || v.etaAt == null || ev.firstBoardingEstimate?.evidenceKind !== 'realtime_prediction') return null;
  return { candidateId: cand.id, routeNo: cand.legs[0].routeNo, boardArs: cand.legs[0].board.ars, vehicleRef: v.vehicleReference, etaAt: v.etaAt, leaveBy: ev.recommendedLeaveAt, seenAt: now };
}

export type MissReason = 'leave_passed' | 'bus_left';
/** 노리던 차를 놓쳤는지: 지금 평가가 다른(더 늦은) 차로 넘어갔으면 놓친 것. 이유는 그 차가 아직 정류장 예측에 있으면 '출발 시각 지남', 없으면 '버스가 떠남' */
export function detectMiss(prev: Target | null, ev: ItineraryEvaluation, board: ArrivalBoard | undefined, now: Sec): MissReason | null {
  if (!prev || prev.candidateId !== ev.candidateId) return null;
  if (prev.etaAt < now - 15 * 60) return null; // 너무 오래된 목표는 무시
  const cur = ev.firstVehicle;
  const same = (o: Pick<ArrivalObservation, 'vehicleReference' | 'etaAt'>) => (prev.vehicleRef && o.vehicleReference ? o.vehicleReference === prev.vehicleRef : o.etaAt != null && Math.abs(o.etaAt - prev.etaAt) <= 90);
  if (cur && same(cur)) return null;
  if (cur && cur.etaAt != null && cur.etaAt < prev.etaAt - 90) return null; // 더 이른 차로 바뀜 = 놓친 게 아님
  const still = board?.observations.some((o) => o.etaAt != null && o.etaAt >= now && same(o));
  return still ? 'leave_passed' : 'bus_left';
}

export interface PlanB {
  reason: MissReason;
  missed: Target;
  next: { vehicleRef: string | null; etaAt: Sec; origin: ArrivalObservation['origin'] } | null;
  newArrivalAt: Sec | null;
  alternative: { candidateId: string; arrivalAt: Sec; diffSec: number } | null;
}

/** ev = 지금 평가(평가기는 탈 수 있는 다음 관측 차량을 고름). others = 같은 시점 다른 후보 평가 */
export function planB(missed: Target, reason: MissReason, ev: ItineraryEvaluation, others: ItineraryEvaluation[], windowSec = 180): PlanB {
  const v = ev.firstVehicle;
  const next = v && v.etaAt != null && ev.firstBoardingEstimate?.evidenceKind === 'realtime_prediction' ? { vehicleRef: v.vehicleReference, etaAt: v.etaAt, origin: v.origin } : null;
  const newArrivalAt = next ? ev.destinationEstimate?.nominalAt ?? null : null;
  const feasible = others.filter((e) => e.candidateId !== ev.candidateId && (e.feasibility === 'comfortable' || e.feasibility === 'tight') && e.destinationEstimate?.nominalAt != null && e.tier === 'observed');
  feasible.sort((a, b) => a.destinationEstimate!.nominalAt! - b.destinationEstimate!.nominalAt!);
  const best = feasible[0];
  let alternative: PlanB['alternative'] = null;
  if (best) {
    const at = best.destinationEstimate!.nominalAt!;
    if (newArrivalAt == null || at <= newArrivalAt + windowSec) alternative = { candidateId: best.candidateId, arrivalAt: at, diffSec: newArrivalAt != null ? at - newArrivalAt : 0 };
  }
  return { reason, missed, next, newArrivalAt, alternative };
}
