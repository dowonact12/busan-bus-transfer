import type { ArrivalBoard, ArrivalObservation, CandidateRoute, Settings, StopRef } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

export const NOW = 1_790_000_000; // 고정 UTC 기준 (테스트 가상값)
export const M = 60;
export const at = (min: number) => NOW + min * M;

/** 범위 0 설정: 기대 수치가 명세와 정확히 비교되도록 */
export const S0: Settings = { ...DEFAULT_SETTINGS, realtimeRangeSec: 0, walkHighFactor: 1, buildingExitHighSec: DEFAULT_SETTINGS.buildingExitSec };

const stop = (ars: string, name = `정류장${ars}`): StopRef => ({ ars, name, lat: 35.18, lon: 129.08 });

export function transferCand(o: { id?: string; r1?: string; r2?: string; firstWalkMin: number; ride1Min: number; transferWalkMin: number; ride2Min: number; finalWalkMin: number; sameStop?: boolean; tArs?: [string, string]; names?: [string, string]; ride1Range?: [number, number] }): CandidateRoute {
  const [a1, a2] = o.tArs ?? ['T1', o.sameStop === false ? 'T2' : 'T1'];
  const [n1, n2] = o.names ?? ['환승지', '환승지'];
  const r1 = o.ride1Range ?? [o.ride1Min, o.ride1Min];
  return {
    id: o.id ?? 'T', kind: 'transfer', routes: [o.r1 ?? 'A', o.r2 ?? 'B'],
    firstWalk: { meters: 0, sec: o.firstWalkMin * M },
    transferWalk: { meters: 50, sec: o.transferWalkMin * M, sameStop: a1 === a2, sameNameDifferentArs: a1 !== a2 && n1 === n2 },
    finalWalk: { meters: 0, sec: o.finalWalkMin * M },
    legs: [
      { routeNo: o.r1 ?? 'A', board: stop('O1'), alight: stop(a1, n1), ride: { pathM: 0, nominalSec: o.ride1Min * M, lowSec: r1[0] * M, highSec: r1[1] * M, hops: 5 } },
      { routeNo: o.r2 ?? 'B', board: stop(a2, n2), alight: stop('D1'), ride: { pathM: 0, nominalSec: o.ride2Min * M, lowSec: o.ride2Min * M, highSec: o.ride2Min * M, hops: 3 } },
    ],
    staticTotalSec: 0,
  };
}

export function directCand(o: { id?: string; r?: string; firstWalkMin: number; rideMin: number; finalWalkMin: number; board?: string }): CandidateRoute {
  return {
    id: o.id ?? 'D', kind: 'direct', routes: [o.r ?? 'X'],
    firstWalk: { meters: 0, sec: o.firstWalkMin * M }, finalWalk: { meters: 0, sec: o.finalWalkMin * M },
    legs: [{ routeNo: o.r ?? 'X', board: stop(o.board ?? 'O1'), alight: stop('D1'), ride: { pathM: 0, nominalSec: o.rideMin * M, lowSec: o.rideMin * M, highSec: o.rideMin * M, hops: 10 } }],
    staticTotalSec: 0,
  };
}

export function obs(routeNo: string, ars: string, min: number, extra: Partial<ArrivalObservation> = {}): ArrivalObservation {
  return {
    routeNo, lineId: null, direction: null, serviceVariant: null, stopArs: ars, vehicleReference: null, vehicleMatchStatus: 'unmatched',
    providerObservedAt: null, fetchedAt: NOW, etaAt: at(min), rawArrivalState: String(min), remainingStops: null,
    seats: { kind: 'unknown', reason: '미제공' }, observationStatus: 'predicted', expiryAt: NOW + 120, origin: 'test', order: 1, ...extra,
  };
}

export function board(routeNo: string, ars: string, mins: number[], extra: Partial<ArrivalBoard> = {}): ArrivalBoard {
  return { stopArs: ars, routeNo, observations: mins.map((m, i) => obs(routeNo, ars, m, { order: i + 1 })), fetchedAt: NOW, status: 'ok', origin: 'test', ...extra };
}

export function lookupOf(boards: ArrivalBoard[]) {
  return (ars: string, routeNo: string) => boards.find((b) => b.stopArs === ars && b.routeNo === routeNo);
}
