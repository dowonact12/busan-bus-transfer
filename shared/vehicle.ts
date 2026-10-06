// 앞차·뒷차 순번은 갱신마다 바뀔 수 있다. 순번이나 차량번호 4자리만으로 동일 차량을 '확정'하지 않는다.
import type { ArrivalObservation } from './types';

export interface VehicleMatch {
  match: ArrivalObservation | null;
  status: 'consistent' | 'ambiguous' | 'unmatched';
  reason: string;
}

function sameService(a: ArrivalObservation, b: ArrivalObservation): boolean {
  if (a.routeNo !== b.routeNo) return false;
  if (a.lineId && b.lineId && a.lineId !== b.lineId) return false; // 같은 번호 다른 방향/변형
  if ((a.direction ?? null) !== (b.direction ?? null)) return false;
  if ((a.serviceVariant ?? null) !== (b.serviceVariant ?? null)) return false;
  return true;
}

/**
 * 이전 갱신의 차량(prev)을 새 관측들 사이에서 찾는다(같은 정류소 기준).
 * 조건: 노선·노선ID·방향·변형 일치 + 차량번호 일치 + 남은 정류장 수가 늘지 않음.
 * 결과는 최대 'consistent'(정황상 일치)이며 확정이 아니다.
 */
export function matchSameStopVehicle(prev: ArrivalObservation, next: ArrivalObservation[]): VehicleMatch {
  if (!prev.vehicleReference) return { match: null, status: 'unmatched', reason: '이전 차량 식별값 없음' };
  const pool = next.filter((o) => o.stopArs === prev.stopArs && sameService(prev, o) && o.vehicleReference === prev.vehicleReference);
  const plausible = pool.filter((o) => prev.remainingStops == null || o.remainingStops == null || o.remainingStops <= prev.remainingStops);
  if (plausible.length === 1) return { match: { ...plausible[0], vehicleMatchStatus: 'consistent' }, status: 'consistent', reason: '노선·방향·차량번호·남은 정류장 정황 일치' };
  if (plausible.length > 1) return { match: null, status: 'ambiguous', reason: '조건에 맞는 차량이 여러 대' };
  return { match: null, status: 'unmatched', reason: '조건에 맞는 차량 없음' };
}

/**
 * 첫 승차 정류소의 차량이 하류(환승 하차) 정류소에서 관측되는지 찾는다.
 * 남은 정류장 수 = 승차 정류소 남은 수 + 구간 정류장 수(±1) 일 때만 정황상 일치.
 */
export function matchDownstreamVehicle(atBoard: ArrivalObservation, downstream: ArrivalObservation[], hops: number): VehicleMatch {
  if (!atBoard.vehicleReference || atBoard.remainingStops == null) return { match: null, status: 'unmatched', reason: '차량 식별값 또는 남은 정류장 정보 없음' };
  const pool = downstream.filter(
    (o) => sameService({ ...atBoard, stopArs: o.stopArs }, o) && o.vehicleReference === atBoard.vehicleReference && o.remainingStops != null && Math.abs(o.remainingStops - (atBoard.remainingStops! + hops)) <= 1 && o.etaAt != null,
  );
  if (pool.length === 1) return { match: { ...pool[0], vehicleMatchStatus: 'consistent' }, status: 'consistent', reason: '노선·차량번호·정류소 순서 정황 일치' };
  if (pool.length > 1) return { match: null, status: 'ambiguous', reason: '조건에 맞는 하류 차량이 여러 대' };
  return { match: null, status: 'unmatched', reason: '하류 정류소 예측 없음' };
}
