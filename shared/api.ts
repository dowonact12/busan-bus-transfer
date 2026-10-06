// 서버 ↔ 화면 계약 (비밀키 없음)
import type { ArrivalBoard, CandidateRoute, Sec } from './types';

export type RealtimeMode = 'live' | 'sample' | 'live_degraded';
/** forward = 가는 길(중앙대로 1067 → 반여로 67), reverse = 오는 길(반여로 67 → 중앙대로 1067) */
export type TripId = 'forward' | 'reverse';

export interface StopVerification {
  ars: string;
  routeNo: string;
  expectedSeq: number | null; // 공식 다운로드 정류소순번
  apiBstopidx: number | null; // 실시간 응답의 bstopidx
  seqMatch: boolean | null;
  bstopid: string | null;
  liveSeenAt: Sec | null;
}

export interface RouteServiceInfo {
  routeNo: string;
  firstTime: string | null; // 기점 첫차 (공식 busInfo)
  endTime: string | null; // 기점 막차 (정류장 통과시각 아님)
  startPoint: string | null;
  endPoint: string | null;
}

export interface Snapshot {
  serverTime: Sec;
  mode: RealtimeMode;
  keyConfigured: boolean;
  providerStatus: 'ok' | 'partial' | 'error' | 'rate_limited' | 'no_key' | 'not_registered';
  providerMessage: string | null;
  boards: ArrivalBoard[];
  verification: StopVerification[];
  routeInfo: RouteServiceInfo[];
  callsToday: number;
  ttlSec: number;
  /** 이 스냅샷이 다루는 방향. 옛 서버 응답엔 없음(= 가는 길만 지원) */
  trip?: TripId;
}

export interface CandidatesPayload {
  trip?: TripId;
  generatedAt: string;
  source: { name: string; note: string; fetchedAt: string };
  origin: { lat: number; lon: number; label: string; approx: boolean };
  destination: { lat: number; lon: number; label: string; approx: boolean };
  candidates: CandidateRoute[];
}

export interface VehiclePosition {
  stopIdx: number; // 노선 정류소 순번(bstopidx) — 이 정류장 부근
  carno: string; // 차량번호(표시용, 전역 고유 ID 아님)
  lat: number | null;
  lon: number | null;
  gpsAt: Sec | null; // 공급자 GPS 시각(gpsym, KST → UTC 변환)
  lowFloor: boolean | null;
}
export interface RouteVehicles {
  routeNo: string;
  lineId: string | null;
  fetchedAt: Sec | null;
  origin: 'live' | 'sample';
  status: 'ok' | 'error' | 'no_key' | 'rate_limited' | 'unknown_line';
  vehicles: VehiclePosition[];
}
export interface RouteStop { seq: number; name: string; ars: string; lat: number; lon: number }
