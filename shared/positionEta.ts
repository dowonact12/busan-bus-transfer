// BIMS 도착 정보는 정류장마다 '다음 2대'(min1/min2)까지만 준다. 그 뒤 차량은 GPS 노선 위치(busInfoByRouteId)로는
// 보이지만 도착 시각이 없다 → 실제로 GPS에 잡힌 차량만, 남은 정거장 × 관측된 정거장당 속도로 '위치 기반 추정'.
// 보이지 않는 차를 만들지 않는다(GPS에 있는 차량만, 범위 넓게, 라벨 표시).
import type { RouteVehicles } from './api';
import type { ArrivalBoard, ArrivalObservation, CandidateRoute, Sec } from './types';

export const PACE_DEFAULT_SEC = 100; // 관측 표본이 없을 때 정거장당(부산 시내버스 실측 범위 70~120초의 중간)
export const PACE_MIN_SEC = 60;
export const PACE_MAX_SEC = 150;
export const POS_MAX_STOPS = 45;
export const POS_MAX_ETA_SEC = 90 * 60;
export const POS_GPS_MAX_AGE_SEC = 300;
export const POS_VEH_MAX_AGE_SEC = 150;
/** 멀리 있는 차는 BIMS가 주는 가까운 차보다 정거장당 조금 빠름(2026-10-07 실측 9건: 보정 전 중앙 +3.1분 늦게 추정 → ×0.9로 +1.1분, 범위 안 9/9) */
export const POS_NOMINAL_F = 0.9;

const last4 = (s: string | null | undefined) => (s ? s.replace(/\D/g, '').slice(-4) : '');
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** 같은 노선의 BIMS 예측(분/남은 정거장)에서 정거장당 초. 2정거장 이상 남은 예측만 사용 */
export function observedPace(boards: ArrivalBoard[], routeNo: string): { sec: number; samples: number } {
  const xs: number[] = [];
  for (const b of boards) {
    if (b.routeNo !== routeNo) continue;
    for (const o of b.observations) {
      if (o.estimate || o.observationStatus !== 'predicted' || o.etaAt == null || o.remainingStops == null || o.remainingStops < 2) continue;
      const sec = (o.etaAt - o.fetchedAt) / o.remainingStops;
      if (sec > 0) xs.push(sec);
    }
  }
  if (!xs.length) return { sec: PACE_DEFAULT_SEC, samples: 0 };
  return { sec: Math.round(Math.min(PACE_MAX_SEC, Math.max(PACE_MIN_SEC, median(xs)))), samples: xs.length };
}

/**
 * 한 정류장(노선 순번 seq)의 BIMS 목록에 없는 상류 차량 → 위치 기반 추정 관측.
 * - BIMS가 준 차량(번호 끝 4자리)은 건너뜀, BIMS가 준 가장 먼 차보다 가까운 차도 건너뜀(목록과 모순되면 BIMS를 믿음)
 * - 기점(순번 1)에 서 있는 차는 출발 대기일 수 있어 제외, GPS 5분 넘게 멈춘 차 제외, 45정거장·90분 넘으면 제외
 */
export function positionObservations(board: ArrivalBoard, seq: number, rv: RouteVehicles | undefined, pace: { sec: number; samples: number }, now: Sec): ArrivalObservation[] {
  if (!rv || rv.status !== 'ok' || rv.origin !== 'live' || rv.fetchedAt == null || now - rv.fetchedAt > POS_VEH_MAX_AGE_SEC) return [];
  if (board.status !== 'ok' && board.status !== 'empty') return [];
  const listed = board.observations.filter((o) => !o.estimate);
  const listedCars = new Set(listed.map((o) => last4(o.vehicleReference)).filter(Boolean));
  const farthestListed = Math.max(-1, ...listed.map((o) => o.remainingStops ?? -1));
  const t0 = rv.fetchedAt;
  const out: ArrivalObservation[] = [];
  const cands = rv.vehicles
    .filter((v) => v.stopIdx < seq && v.stopIdx > 1)
    .filter((v) => v.gpsAt == null || t0 - v.gpsAt <= POS_GPS_MAX_AGE_SEC)
    .map((v) => ({ v, left: seq - v.stopIdx }))
    .filter(({ v, left }) => !listedCars.has(last4(v.carno)) && left > farthestListed && left <= POS_MAX_STOPS)
    .sort((a, b) => a.left - b.left);
  for (const { v, left } of cands) {
    const base = left * pace.sec;
    const nominal = base * POS_NOMINAL_F;
    if (nominal > POS_MAX_ETA_SEC) break;
    // 범위: 빠르면 0.7배, 늦으면 1.25배 + 2분(신호·정차 변동). 관측 속도 표본이 없으면 더 넓게
    const lowF = pace.samples ? 0.7 : 0.6, highF = pace.samples ? 1.25 : 1.45;
    out.push({
      routeNo: board.routeNo, lineId: rv.lineId, direction: null, serviceVariant: null, stopArs: board.stopArs,
      vehicleReference: v.carno, vehicleMatchStatus: 'unmatched', providerObservedAt: v.gpsAt, fetchedAt: t0,
      etaAt: t0 + Math.round(nominal), rawArrivalState: `위치 ${left}정거장 전`, remainingStops: left,
      seats: { kind: 'unknown', reason: '미제공' }, observationStatus: 'predicted', expiryAt: t0 + POS_VEH_MAX_AGE_SEC,
      origin: 'live', order: 10 + out.length, estimate: 'position',
      etaLowAt: t0 + Math.round(base * lowF), etaHighAt: t0 + Math.round(base * highF) + 120,
    });
  }
  return out;
}

/** 승차 정류장 보드에 위치 기반 추정을 덧붙인 새 보드 목록(원본 불변). 하차(하류 일치용) 보드는 건드리지 않음 */
export function augmentBoards(boards: ArrivalBoard[], cands: CandidateRoute[], vehicles: Record<string, RouteVehicles>, now: Sec): ArrivalBoard[] {
  const seqOf = new Map<string, number>();
  for (const c of cands) for (const l of c.legs) if (l.board.routeStopSequence != null) seqOf.set(`${l.board.ars}|${l.routeNo}`, l.board.routeStopSequence);
  const paces = new Map<string, { sec: number; samples: number }>();
  return boards.map((b) => {
    const seq = seqOf.get(`${b.stopArs}|${b.routeNo}`);
    const rv = vehicles[b.routeNo];
    if (seq == null || !rv) return b;
    if (!paces.has(b.routeNo)) paces.set(b.routeNo, observedPace(boards, b.routeNo));
    const extra = positionObservations(b, seq, rv, paces.get(b.routeNo)!, now);
    return extra.length ? { ...b, observations: [...b.observations, ...extra] } : b;
  });
}

/** 다음 차가 어디 있는지(시각 없이, GPS로 확인되는 사실만):
 *  'at_origin' = 목록 밖 차가 기점(순번 1)에 서 있음, 'not_departed' = 기점~이 정류장 사이에 목록 밖 차가 하나도 없음, null = 알 수 없음/해당 없음 */
export function nextBusWhere(board: ArrivalBoard | undefined, seq: number | undefined, rv: RouteVehicles | undefined, now: Sec): 'at_origin' | 'not_departed' | null {
  if (!board || seq == null || !rv || rv.status !== 'ok' || rv.origin !== 'live' || rv.fetchedAt == null || now - rv.fetchedAt > POS_VEH_MAX_AGE_SEC) return null;
  const listedCars = new Set(board.observations.filter((o) => !o.estimate).map((o) => last4(o.vehicleReference)).filter(Boolean));
  const up = rv.vehicles.filter((v) => v.stopIdx < seq && !listedCars.has(last4(v.carno)));
  if (up.some((v) => v.stopIdx <= 1)) return 'at_origin';
  return up.length === 0 ? 'not_departed' : null;
}
