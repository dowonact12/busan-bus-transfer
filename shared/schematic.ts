// 3점 도식(출발 — 환승 — 도착)에 실제 차량을 배치하는 순수 함수.
// 위치는 공급자(busInfoByRouteId)가 준 정류소 순번(bstopidx)만 사용 — 보간·생성 차량 없음.
import type { VehiclePosition } from './api';
import type { CandidateLeg, CandidateRoute, Sec } from './types';

export type SchematicZone =
  | 'before_board' // 이 구간 승차 정류장 오기 전(n정류장 전, 0 = 정류장 부근)
  | 'between' // 승차 정류장 ~ 하차 정류장 사이(내 버스가 이미 지나간 구간)
  | 'passed'; // 하차 정류장도 지남

export interface SchematicBus {
  legIndex: number; // 0 = 첫 구간, 1 = 환승 후 구간
  routeNo: string;
  carno: string;
  plate4: string; // 번호판 끝 4자리(표시용)
  stopIdx: number;
  zone: SchematicZone;
  stopsToBoard: number | null; // before_board 일 때 승차 정류장까지 남은 정류장 수
  stopsPastAlight: number | null; // passed 일 때 하차 정류장을 지난 정류장 수
  fraction: number; // between 일 때 0..1 (승차→하차 진행률), 그 외 0
  gpsAgeSec: number | null;
  stale: boolean; // GPS가 오래돼 흐리게(위치 판단에 쓰지 않음)
  lat: number | null;
  lon: number | null;
}

export interface SchematicOptions {
  lookBehind: number; // 승차 정류장 몇 정류장 전까지 보여줄지
  lookAfter: number; // 하차 정류장 지난 뒤 몇 정류장까지 '지남'으로 보여줄지
  staleSec: number;
}
export const SCHEMATIC_DEFAULTS: SchematicOptions = { lookBehind: 12, lookAfter: 2, staleSec: 300 };

export const plate4 = (carno: string) => (carno.match(/(\d{4})\D*$/)?.[1] ?? carno.slice(-4));

export function classifyLegVehicles(leg: CandidateLeg, legIndex: number, vehicles: VehiclePosition[], now: Sec, o: SchematicOptions = SCHEMATIC_DEFAULTS): SchematicBus[] {
  const b = leg.board.routeStopSequence, a = leg.alight.routeStopSequence;
  if (b == null || a == null || a <= b) return [];
  const out: SchematicBus[] = [];
  for (const v of vehicles) {
    const i = v.stopIdx;
    let zone: SchematicZone;
    if (i <= b && b - i <= o.lookBehind) zone = 'before_board';
    else if (i > b && i <= a) zone = 'between';
    else if (i > a && i - a <= o.lookAfter) zone = 'passed';
    else continue;
    const gpsAgeSec = v.gpsAt != null ? Math.max(0, now - v.gpsAt) : null;
    out.push({
      legIndex, routeNo: leg.routeNo, carno: v.carno, plate4: plate4(v.carno), stopIdx: i, zone,
      stopsToBoard: zone === 'before_board' ? b - i : null,
      stopsPastAlight: zone === 'passed' ? i - a : null,
      fraction: zone === 'between' ? (i - b) / (a - b) : 0,
      gpsAgeSec, stale: gpsAgeSec == null || gpsAgeSec > o.staleSec, lat: v.lat, lon: v.lon,
    });
  }
  // 승차 정류장에 가까운 순(오기 전) → 진행 순
  return out.sort((x, y) => y.stopIdx - x.stopIdx);
}

export function buildSchematic(cand: CandidateRoute, vehiclesByRoute: Record<string, { vehicles: VehiclePosition[] } | undefined>, now: Sec, o: SchematicOptions = SCHEMATIC_DEFAULTS): SchematicBus[] {
  return cand.legs.flatMap((leg, i) => classifyLegVehicles(leg, i, vehiclesByRoute[leg.routeNo]?.vehicles ?? [], now, o));
}

/** 사람이 읽는 위치 문장 (방향마다 정류장 이름 대신 역할 이름) */
export function zoneText(bus: SchematicBus, kind: CandidateRoute['kind']): string {
  const boardName = bus.legIndex === 0 ? '출발 정류장' : '환승 정류장';
  const alightName = bus.legIndex === 0 && kind === 'transfer' ? '환승 정류장' : '도착 정류장';
  if (bus.zone === 'before_board') return bus.stopsToBoard === 0 ? `${boardName} 부근` : `${boardName} ${bus.stopsToBoard}정류장 전`;
  if (bus.zone === 'between') return `${bus.legIndex === 0 ? '출발' : '환승'}~${alightName === '환승 정류장' ? '환승' : '도착'} 사이`;
  return `${alightName} 지남`;
}

export function gpsAgeText(age: number | null): string {
  if (age == null) return 'GPS 시각 없음';
  if (age < 60) return 'GPS 1분 안';
  return `GPS ${Math.floor(age / 60)}분 전`;
}
