// TransferEvaluator — 순수 시간 계산과 가능성 판정 (문서 7장).
// 내부: UTC epoch 초. 여유시간은 한 번만 적용한다.
import { matchDownstreamVehicle } from './vehicle';
import type {
  ArrivalBoard, ArrivalLookup, ArrivalObservation, CandidateRoute, DataOrigin, Feasibility, ItineraryEvaluation,
  JourneyState, LeaveAdvice, SegmentEvidence, Sec, Settings, TimeEstimate,
} from './types';

export interface EvalContext {
  now: Sec;
  settings: Settings;
  lookup: ArrivalLookup;
  journey?: JourneyState | null;
}

const est = (p: Partial<TimeEstimate> & Pick<TimeEstimate, 'evidenceKind' | 'origin'>): TimeEstimate => ({
  nominalAt: null, earliestAt: null, latestAt: null, rangeKind: 'none', basedOnObservations: [], assumptions: [], ...p,
});

/** 7.7 권장 출발 마감 = 첫 버스의 보수적인 이른 도착 − (건물출입 상한 + 첫 보행 상한 + 첫 승차 여유) */
export function computeLeaveDeadline(firstBusEarliestAt: Sec, exitHighSec: number, firstWalkHighSec: number, boardMarginSec: number): Sec {
  return firstBusEarliestAt - (exitHighSec + firstWalkHighSec + boardMarginSec);
}

/** 7.8 환승 상태: R=[준비 범위](환승 보행 포함, 여유 미포함), B=[둘째 차량 범위], S=추가 여유 */
export function classifyTransfer(rLow: Sec, rHigh: Sec, bLow: Sec, bHigh: Sec, s: number): 'comfortable' | 'tight' | 'infeasible' {
  if (bLow >= rHigh + s) return 'comfortable';
  if (bHigh < rLow + s) return 'infeasible';
  return 'tight';
}

export type FreshnessLevel = 'fresh' | 'warn' | 'stale' | 'none';
export function freshness(board: ArrivalBoard | undefined, now: Sec, s: Settings): { level: FreshnessLevel; ageSec: number | null } {
  if (!board || board.fetchedAt == null) return { level: 'none', ageSec: null };
  const age = now - board.fetchedAt;
  if (age < 0) return { level: 'stale', ageSec: age }; // 시간 기준 오류
  if (age <= s.staleWarnSec) return { level: 'fresh', ageSec: age };
  if (age <= s.staleMaxSec) return { level: 'warn', ageSec: age };
  return { level: 'stale', ageSec: age };
}

type Pick1 =
  | { kind: 'vehicle'; obs: ArrivalObservation; nextObserved: ArrivalObservation | null }
  | { kind: 'headway'; estimate: TimeEstimate }
  | { kind: 'none'; reason: Feasibility; note: string };

/** 관측 차량 중 requiredAt 이후 처음 오는 차량. 없으면 생성하지 않는다(배차 추정은 명시적 옵션+근거 있을 때만). */
function pickVehicle(board: ArrivalBoard | undefined, requiredAt: Sec, ctx: EvalContext): Pick1 {
  const { now, settings: s } = ctx;
  if (!board || board.status === 'no_key' || board.status === 'not_mapped') return { kind: 'none', reason: 'no_realtime', note: '실시간 판단 불가(연결 필요)' };
  if (board.status === 'error' || board.status === 'rate_limited') {
    if (board.fetchedAt == null) return { kind: 'none', reason: 'no_realtime', note: '공급자 응답 오류 또는 호출 제한' };
  }
  const f = freshness(board, now, s);
  if (f.level === 'stale' || f.level === 'none') return { kind: 'none', reason: f.level === 'none' ? 'no_realtime' : 'stale', note: '도착 정보가 오래됨 — 갱신 필요' };
  const predicted = board.observations.filter((o) => o.observationStatus === 'predicted' && o.etaAt != null).sort((a, b) => a.etaAt! - b.etaAt!);
  if (predicted.length === 0) {
    if (board.observations.some((o) => o.observationStatus === 'waiting')) return { kind: 'none', reason: 'waiting', note: '운행대기' };
    return { kind: 'none', reason: 'no_realtime', note: board.serviceEndedConfirmed ? '운행 종료 확인됨' : '도착 예정 차량 정보 없음(운행 종료로 단정하지 않음)' };
  }
  const idx = predicted.findIndex((o) => o.etaAt! >= requiredAt);
  if (idx >= 0) return { kind: 'vehicle', obs: predicted[idx], nextObserved: predicted[idx + 1] ?? null };
  const last = predicted[predicted.length - 1];
  if (s.allowHeadwayEstimate && board.headwaySec && board.headwaySec > 0 && !board.lastBusPassed && !board.serviceEndedConfirmed) {
    const h = board.headwaySec;
    let n = last.etaAt! + h;
    while (n < requiredAt) n += h;
    return {
      kind: 'headway',
      estimate: est({
        nominalAt: n, earliestAt: n - Math.round(h / 2), latestAt: n + h, evidenceKind: 'headway_estimate', rangeKind: 'assumed', origin: last.origin,
        assumptions: [`관측된 마지막 차량 이후 배차 ${Math.round(h / 60)}분 가정`, '실제 차량 미관측'],
      }),
    };
  }
  return { kind: 'none', reason: 'unobserved_next', note: '관측된 차량이 모두 먼저 지나감 — 그 이후 차량은 아직 확인되지 않음' };
}

function vehicleEstimate(o: ArrivalObservation, s: Settings): TimeEstimate {
  return est({
    nominalAt: o.etaAt, earliestAt: o.etaAt! - s.realtimeRangeSec, latestAt: o.etaAt! + s.realtimeRangeSec,
    evidenceKind: 'realtime_prediction', rangeKind: 'assumed', origin: o.origin,
    basedOnObservations: [`${o.routeNo}@${o.stopArs}#${o.vehicleReference ?? '?'}`],
    assumptions: ['분 단위 원본 · 수신시각 기준 근사', `±${Math.round(s.realtimeRangeSec / 60)}분 가정 범위`],
  });
}

const add = (e: TimeEstimate, nominal: number, low: number, high: number, kind?: TimeEstimate['evidenceKind']): TimeEstimate => ({
  ...e,
  nominalAt: e.nominalAt == null ? null : e.nominalAt + nominal,
  earliestAt: e.earliestAt == null ? null : e.earliestAt + low,
  latestAt: e.latestAt == null ? null : e.latestAt + high,
  evidenceKind: kind ?? e.evidenceKind,
  rangeKind: e.rangeKind === 'none' ? 'assumed' : e.rangeKind,
});

const originLabel = (o: DataOrigin) => (o === 'sample' ? '예시값' : o === 'live' ? '실시간' : o === 'static' ? '정적' : o);

export function evaluateCandidate(c: CandidateRoute, ctx: EvalContext): ItineraryEvaluation {
  const { now, settings: s, lookup, journey } = ctx;
  const wm = s.walkMultiplier;
  const w1 = Math.round(c.firstWalk.sec * wm);
  const w1High = Math.round(w1 * s.walkHighFactor);
  const wT = c.transferWalk ? Math.round(c.transferWalk.sec * wm) : 0;
  const wTHigh = Math.round(wT * s.walkHighFactor);
  const wF = Math.round(c.finalWalk.sec * wm);
  const wFHigh = Math.round(wF * s.walkHighFactor);
  const leg1 = c.legs[0];
  const leg2 = c.legs[1];
  const warnings: string[] = [];
  const evidence: SegmentEvidence[] = [];
  const base: ItineraryEvaluation = {
    candidateId: c.id, kind: c.kind, constituentRoutes: c.routes, feasibility: 'no_realtime', tier: 'none',
    firstVehicle: null, secondVehicle: null, firstReadyAt: null, firstBoardingEstimate: null, transferArrivalEstimate: null,
    transferReadyEstimate: null, transferRequiredAt: null, transferBoardingEstimate: null, destinationEstimate: null,
    destinationConditional: false, destinationIfMissed: null, firstWaitSec: null, transferWaitSec: null, transferSlackSec: null,
    outdoorWaitSec: null, indoorWaitSec: null, walkSec: w1 + wT + wF, totalSec: null, recommendedLeaveAt: null,
    leaveAdvice: { kind: 'none' }, evidence, warnings, dataAgeSec: null, evaluatedAt: now, expiresAt: null,
  };
  evidence.push({ segment: 'walks', evidenceKind: 'static_duration', origin: 'static', note: '보행: 직선거리 × 1.3 ÷ 1.2m/s 추정 (현장 미검증)' });
  if (c.transferWalk && !c.transferWalk.sameStop) {
    warnings.push(c.transferWalk.sameNameDifferentArs
      ? `같은 이름이지만 다른 정류장(ARS ${leg1.alight.ars} → ${leg2!.board.ars}) — 도보·횡단 동선 확인 필요`
      : `환승 시 다른 정류장으로 이동(${c.transferWalk.meters}m 직선) — 횡단 동선 확인 필요`);
  }

  // ── 진행 상태 반영 ──
  const phase = journey?.phase ?? 'before';
  const onFirst = phase === 'on_first_bus' || phase === 'at_transfer' || phase === 'on_second_bus';
  if (onFirst && journey?.boarded) {
    const b = journey.boarded;
    if (leg1.routeNo !== b.routeNo || leg1.board.ars !== b.boardArs) {
      return { ...base, feasibility: 'not_applicable', warnings: ['이미 다른 버스에 탑승 중'] };
    }
  }
  if (phase === 'on_second_bus' && journey?.secondBoarded && (!leg2 || leg2.routeNo !== journey.secondBoarded.routeNo || leg2.board.ars !== journey.secondBoarded.boardArs)) {
    return { ...base, feasibility: 'not_applicable', warnings: ['이미 다른 버스에 탑승 중'] };
  }

  // ── 7.2 첫 버스 ──
  let firstBoarding: TimeEstimate;
  let firstVehicle: ArrivalObservation | null = null;
  let leaveDeadline: Sec | null = null;
  let firstReadyAt: Sec | null = null;
  const board1 = lookup(leg1.board.ars, leg1.routeNo);
  let worstAge: number | null = null;
  const noteAge = (b: ArrivalBoard | undefined) => {
    const f = freshness(b, now, s);
    if (f.ageSec != null) worstAge = Math.max(worstAge ?? 0, f.ageSec);
    if (f.level === 'warn') warnings.push('오래된 정보 주의 — 갱신 대기 중');
  };

  if (onFirst && journey?.boarded) {
    firstBoarding = est({ nominalAt: journey.boarded.boardedAt, earliestAt: journey.boarded.boardedAt, latestAt: journey.boarded.boardedAt, evidenceKind: 'user_confirmed', origin: 'static', assumptions: ['사용자가 탑승 확인'] });
    if (!journey.boarded.vehicleConfirmed) warnings.push('탑승 차량 확인 대기 — 정적 추정으로 계산');
    evidence.push({ segment: 'first_arrival', evidenceKind: 'user_confirmed', origin: 'static', note: '첫 버스 탑승: 사용자 확인' });
  } else {
    const atStop = phase === 'at_stop';
    const walking = phase === 'walking_to_stop';
    let readyAt: Sec;
    if (atStop) readyAt = now;
    else if (walking && journey?.leftAt != null && journey.candidateId === c.id) readyAt = Math.max(now, journey.leftAt + s.buildingExitSec + w1);
    else if (walking) readyAt = now + w1; // 이미 건물 밖
    else readyAt = now + s.buildingExitSec + w1;
    firstReadyAt = readyAt;
    const margin = atStop ? 0 : s.firstBoardMarginSec; // 이미 정류장에 있는 사용자는 다르게 처리
    noteAge(board1);
    const p = pickVehicle(board1, readyAt + margin, ctx);
    if (p.kind === 'none') {
      return { ...base, firstReadyAt, feasibility: p.reason, warnings: [...warnings, `${leg1.routeNo}번: ${p.note}`], dataAgeSec: worstAge };
    }
    if (p.kind === 'vehicle') {
      firstVehicle = p.obs;
      firstBoarding = vehicleEstimate(p.obs, s);
      if (atStop && p.obs.etaAt! - now < 60) warnings.push('곧 도착 — 탑승 여유 적음');
      evidence.push({ segment: 'first_arrival', evidenceKind: 'realtime_prediction', origin: p.obs.origin, note: `첫 버스 도착: ${originLabel(p.obs.origin)} 예측` });
    } else {
      firstBoarding = p.estimate;
      evidence.push({ segment: 'first_arrival', evidenceKind: 'headway_estimate', origin: p.estimate.origin, note: '첫 버스 도착: 배차 기준 추정' });
    }
    if (!atStop && !walking) leaveDeadline = computeLeaveDeadline(firstBoarding.earliestAt!, s.buildingExitHighSec, w1High, s.firstBoardMarginSec);
  }

  // ── 7.3 첫 주행 ──
  let leg1End: TimeEstimate;
  const downBoard = lookup(leg1.alight.ars, leg1.routeNo);
  const dm = firstVehicle && downBoard && freshness(downBoard, now, s).level !== 'stale' ? matchDownstreamVehicle(firstVehicle, downBoard.observations, leg1.ride.hops) : null;
  let boardedMatch: ArrivalObservation | null = null;
  if (onFirst && journey?.boarded?.vehicleConfirmed && journey.boarded.vehicleReference && downBoard && freshness(downBoard, now, s).level !== 'stale') {
    const pool = downBoard.observations.filter((o) => o.routeNo === leg1.routeNo && o.vehicleReference === journey.boarded!.vehicleReference && o.etaAt != null);
    if (pool.length === 1) boardedMatch = { ...pool[0], vehicleMatchStatus: 'consistent' };
  }
  if (boardedMatch) {
    leg1End = vehicleEstimate(boardedMatch, s);
    evidence.push({ segment: 'first_ride', evidenceKind: 'realtime_prediction', origin: boardedMatch.origin, note: `${leg1.alight.name} 도착: 탑승 차량(사용자 확인)의 하류 예측` });
  } else if (dm?.match) {
    leg1End = vehicleEstimate(dm.match, s);
    evidence.push({ segment: 'first_ride', evidenceKind: 'realtime_prediction', origin: dm.match.origin, note: `${leg1.alight.name} 도착: 같은 차량의 하류 정류장 ${originLabel(dm.match.origin)} 예측(정황 일치, 확정 아님)` });
  } else {
    leg1End = add(firstBoarding, leg1.ride.nominalSec, leg1.ride.lowSec, leg1.ride.highSec, firstBoarding.evidenceKind === 'headway_estimate' ? 'headway_estimate' : 'static_duration');
    leg1End.assumptions = [...leg1End.assumptions, `주행 ${leg1.ride.hops}정거장 정적 추정(평균 15km/h 가정, 범위 11~20km/h)`];
    evidence.push({ segment: 'first_ride', evidenceKind: 'static_duration', origin: 'static', note: `${leg1.routeNo}번 주행 ${Math.round(leg1.ride.nominalSec / 60)}분: 정적 추정` });
  }

  const firstWaitSec = firstReadyAt != null && firstBoarding.nominalAt != null ? Math.max(0, firstBoarding.nominalAt - firstReadyAt) : null;
  const leaveAt = leaveDeadline != null ? Math.max(now, leaveDeadline) : now;
  const indoorWaitSec = leaveDeadline != null ? leaveAt - now : 0;
  const outdoorFirstWait = firstBoarding.nominalAt != null && firstReadyAt != null ? Math.max(0, firstBoarding.nominalAt - (firstReadyAt + indoorWaitSec)) : 0;
  const tierOf = (...e: TimeEstimate[]) => (e.some((x) => x.evidenceKind === 'headway_estimate') ? 'estimate' : 'observed') as 'estimate' | 'observed';
  const leaveAdvice = (realtimeFresh: boolean): LeaveAdvice => {
    if (leaveDeadline == null) return { kind: 'none' };
    if (!realtimeFresh || firstBoarding.evidenceKind !== 'realtime_prediction') return { kind: 'conservative_now' };
    if (leaveDeadline < now) return { kind: 'leave_now_tight' };
    if (leaveDeadline - now >= 60) return { kind: 'leave_in', atSec: leaveDeadline, minutes: Math.floor((leaveDeadline - now) / 60) };
    return { kind: 'leave_now' };
  };
  const firstFresh = freshness(board1, now, s).level === 'fresh';

  // ── 직통 ──
  if (c.kind === 'direct' || !leg2) {
    const dest = add(leg1End, wF, wF, wFHigh);
    return {
      ...base, feasibility: 'comfortable', tier: tierOf(firstBoarding), firstVehicle, firstReadyAt, firstBoardingEstimate: firstBoarding,
      destinationEstimate: dest, firstWaitSec, transferWaitSec: 0, outdoorWaitSec: outdoorFirstWait, indoorWaitSec,
      totalSec: dest.nominalAt! - now, recommendedLeaveAt: leaveDeadline, leaveAdvice: leaveAdvice(firstFresh), dataAgeSec: worstAge,
      expiresAt: (board1?.fetchedAt ?? now) + s.staleMaxSec, transferArrivalEstimate: leg1End,
    };
  }

  // ── 7.4 환승 ──
  let readyT: TimeEstimate;
  if (phase === 'at_transfer' || phase === 'on_second_bus') readyT = est({ nominalAt: now, earliestAt: now, latestAt: now, evidenceKind: 'user_confirmed', origin: 'static' });
  else readyT = add(leg1End, wT, wT, wTHigh);
  const requiredAt = readyT.nominalAt! + s.transferMarginSec;
  const board2 = lookup(leg2.board.ars, leg2.routeNo);
  noteAge(board2);

  let second: TimeEstimate;
  let secondVehicle: ArrivalObservation | null = null;
  let nextAfter: ArrivalObservation | null = null;
  if (phase === 'on_second_bus' && journey?.secondBoarded) {
    second = est({ nominalAt: journey.secondBoarded.boardedAt, earliestAt: journey.secondBoarded.boardedAt, latestAt: journey.secondBoarded.boardedAt, evidenceKind: 'user_confirmed', origin: 'static' });
  } else {
    const p2 = pickVehicle(board2, requiredAt, ctx);
    if (p2.kind === 'none') {
      return {
        ...base, feasibility: p2.reason, firstVehicle, firstReadyAt, firstBoardingEstimate: firstBoarding, transferArrivalEstimate: leg1End,
        transferReadyEstimate: readyT, transferRequiredAt: requiredAt, firstWaitSec, indoorWaitSec,
        recommendedLeaveAt: leaveDeadline, leaveAdvice: leaveAdvice(firstFresh), dataAgeSec: worstAge,
        warnings: [...warnings, `${leg2.routeNo}번(${leg2.board.name}): ${p2.note}`, '최종 도착 미확정'],
      };
    }
    if (p2.kind === 'vehicle') {
      secondVehicle = p2.obs;
      nextAfter = p2.nextObserved;
      second = vehicleEstimate(p2.obs, s);
      evidence.push({ segment: 'second_arrival', evidenceKind: 'realtime_prediction', origin: p2.obs.origin, note: `환승 버스 도착: ${originLabel(p2.obs.origin)} 예측` });
    } else {
      second = p2.estimate;
      evidence.push({ segment: 'second_arrival', evidenceKind: 'headway_estimate', origin: p2.estimate.origin, note: '환승 버스 도착: 배차 기준 추정' });
    }
  }
  evidence.push({ segment: 'transfer_walk', evidenceKind: 'static_duration', origin: 'static', note: `환승 보행 ${Math.round(wT / 60)}분 추정 + 여유 ${Math.round(s.transferMarginSec / 60)}분` });

  // 실제 환승 대기 = 둘째 승차 − 환승 준비 / 계산상 여유 = 둘째 승차 − (준비 + 여유)
  const transferWaitSec = second.nominalAt! - readyT.nominalAt!;
  const transferSlackSec = second.nominalAt! - requiredAt;
  const status = second.evidenceKind === 'user_confirmed' ? 'comfortable' : classifyTransfer(readyT.earliestAt!, readyT.latestAt!, second.earliestAt!, second.latestAt!, s.transferMarginSec);
  if (status === 'infeasible') {
    return { ...base, feasibility: 'infeasible', firstVehicle, secondVehicle, firstReadyAt, firstBoardingEstimate: firstBoarding, transferArrivalEstimate: leg1End, transferReadyEstimate: readyT, transferRequiredAt: requiredAt, transferBoardingEstimate: second, transferWaitSec, transferSlackSec, dataAgeSec: worstAge, warnings: [...warnings, '현재 계산상 환승 연결 어려움'] };
  }
  const evidenceKind2 = second.evidenceKind === 'headway_estimate' ? 'headway_estimate' : 'static_duration';
  let dest = add(second, leg2.ride.nominalSec + wF, leg2.ride.lowSec + wF, leg2.ride.highSec + wFHigh, evidenceKind2);
  evidence.push({ segment: 'second_ride', evidenceKind: 'static_duration', origin: 'static', note: `${leg2.routeNo}번 주행 ${Math.round(leg2.ride.nominalSec / 60)}분: 정적 추정` });
  let ifMissed: TimeEstimate | null = null;
  const conditional = status === 'tight' || second.evidenceKind === 'headway_estimate';
  if (status === 'tight') {
    warnings.push('환승 촉박 — 아래 도착은 선택 차량에 탔을 때의 값');
    if (nextAfter) {
      ifMissed = add(vehicleEstimate(nextAfter, s), leg2.ride.nominalSec + wF, leg2.ride.lowSec + wF, leg2.ride.highSec + wFHigh, 'static_duration');
      dest = { ...dest, latestAt: ifMissed.latestAt }; // 놓쳤을 때까지 포함한 상한
    } else {
      dest = { ...dest, latestAt: null }; // 다음 차량 미관측 → 지연 시 상한 미확정
      warnings.push('놓치면 다음 차량 미확인 — 도착 미확정');
    }
  }
  const tier = tierOf(firstBoarding, second);
  return {
    ...base, feasibility: status, tier, firstVehicle, secondVehicle, firstReadyAt, firstBoardingEstimate: firstBoarding,
    transferArrivalEstimate: leg1End, transferReadyEstimate: readyT, transferRequiredAt: requiredAt, transferBoardingEstimate: second,
    destinationEstimate: dest, destinationConditional: conditional, destinationIfMissed: ifMissed, firstWaitSec,
    transferWaitSec, transferSlackSec, outdoorWaitSec: outdoorFirstWait + Math.max(0, transferWaitSec), indoorWaitSec,
    totalSec: dest.nominalAt! - now, recommendedLeaveAt: leaveDeadline,
    leaveAdvice: leaveAdvice(firstFresh && freshness(board2, now, s).level !== 'stale'), dataAgeSec: worstAge,
    expiresAt: Math.min(board1?.fetchedAt ?? now, board2?.fetchedAt ?? now) + s.staleMaxSec,
  };
}
