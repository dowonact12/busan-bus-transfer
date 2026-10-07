// 내부 모델. 외부 API 스키마와 분리한다. 모든 시각은 UTC epoch 초(Sec), 기간은 초.
export type Sec = number;

export type EvidenceKind = 'realtime_prediction' | 'static_duration' | 'headway_estimate' | 'user_confirmed' | 'user_measured' | 'unknown';
export type RangeKind = 'provider' | 'assumed' | 'calibrated' | 'none';
/** live=실제 BIMS 응답, sample=예시 모드 가짜값, recorded=녹화 응답, static=공식 정적자료 기반 추정, test=단위테스트 */
export type DataOrigin = 'live' | 'sample' | 'recorded' | 'static' | 'test';

export interface TimeEstimate {
  nominalAt: Sec | null;
  earliestAt: Sec | null;
  latestAt: Sec | null;
  evidenceKind: EvidenceKind;
  rangeKind: RangeKind;
  origin: DataOrigin;
  basedOnObservations: string[];
  assumptions: string[];
}

export interface StopRef {
  ars: string; // 문자열 유지(앞자리 0 보존)
  name: string;
  lat: number;
  lon: number;
  routeStopSequence?: number;
  officialStopId?: string; // 공식 다운로드 정류소ID (API bstopid와 같다고 가정하지 않음)
  nextStopName?: string | null;
  bstopid?: string | null;
  mappingVerifiedAt?: string | null;
  mappingEvidence?: string | null;
}

export type SeatInfo =
  | { kind: 'unknown'; reason: string }
  | { kind: 'count'; count: number }; // 0 = 공급자 정의상 빈 좌석 없음(만차·입석불가 아님)

export type ObservationStatus = 'predicted' | 'waiting' | 'unknown';

export interface ArrivalObservation {
  routeNo: string;
  lineId: string | null;
  direction: string | null;
  serviceVariant: string | null;
  stopArs: string;
  vehicleReference: string | null; // 차량번호 4자리 등. 전역 고유 ID 아님
  vehicleMatchStatus: 'unmatched' | 'consistent' | 'ambiguous';
  providerObservedAt: Sec | null;
  fetchedAt: Sec;
  etaAt: Sec | null;
  rawArrivalState: string;
  remainingStops: number | null;
  seats: SeatInfo;
  observationStatus: ObservationStatus;
  expiryAt: Sec;
  origin: DataOrigin;
  order: number; // 공급자가 준 1/2 순번. 동일 차량 판단에 쓰지 않음
}

export type BoardStatus = 'ok' | 'empty' | 'error' | 'no_key' | 'rate_limited' | 'not_mapped';

/** 한 정류소·노선의 도착 관측 묶음 */
export interface ArrivalBoard {
  stopArs: string;
  routeNo: string;
  observations: ArrivalObservation[];
  fetchedAt: Sec | null; // 마지막 성공 수신
  status: BoardStatus;
  origin: DataOrigin;
  headwaySec?: number | null; // 공식 배차 정보가 확인된 경우만
  serviceEndedConfirmed?: boolean;
  lastBusPassed?: boolean; // 막차 이후 등 확인
}

export type ArrivalLookup = (stopArs: string, routeNo: string) => ArrivalBoard | undefined;

export interface RideEstimate {
  pathM: number;
  nominalSec: number;
  lowSec: number;
  highSec: number;
  hops: number;
}

export interface CandidateLeg {
  routeNo: string;
  board: StopRef;
  alight: StopRef;
  ride: RideEstimate;
}

export interface WalkLeg {
  meters: number;
  sec: number;
}

export interface CandidateRoute {
  id: string;
  kind: 'direct' | 'transfer';
  routes: string[];
  legs: CandidateLeg[];
  firstWalk: WalkLeg;
  transferWalk?: WalkLeg & { sameStop: boolean; sameNameDifferentArs: boolean };
  finalWalk: WalkLeg;
  staticTotalSec: number;
}

/** 문(집·회사) → 정류장 실측 범위. 건물 나가기·신호 대기 포함한 전체 시간 */
export interface DoorToStop { lowSec: number; nominalSec: number; highSec: number }

export interface Settings {
  /** 정류장별 실측 '문→정류장' 시간(있으면 건물 나가기+추정 보행 대신 사용, 걷기 속도 보정 미적용) */
  doorToStop?: Record<string, DoorToStop>;
  /** 실측 없는 정류장: 추정 보행에 더하는 문~큰길 시간(건물 나가기·신호). 실측 정류장에서 역산 */
  doorOverheadSec?: number;
  buildingExitSec: number; // 3층 → 건물 밖 (초깃값 2분, 측정값 아님)
  buildingExitHighSec: number;
  walkMultiplier: number; // 사용자 걷기 보정
  walkHighFactor: number; // 보행 상한 = 보행 × 계수 (가정 범위)
  firstBoardMarginSec: number; // 1분
  transferMarginSec: number; // 2분
  similarWindowSec: number; // 3분
  staleWarnSec: number; // 60
  staleMaxSec: number; // 120
  realtimeRangeSec: number; // 분 단위 반올림·통신지연 가정 범위 ±
  allowHeadwayEstimate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  buildingExitSec: 120,
  buildingExitHighSec: 180,
  walkMultiplier: 1,
  walkHighFactor: 1.25,
  firstBoardMarginSec: 60,
  transferMarginSec: 120,
  similarWindowSec: 180,
  staleWarnSec: 60,
  staleMaxSec: 120,
  realtimeRangeSec: 60,
  allowHeadwayEstimate: false,
};

export type JourneyPhase = 'before' | 'walking_to_stop' | 'at_stop' | 'on_first_bus' | 'at_transfer' | 'on_second_bus' | 'arrived';

export interface JourneyState {
  phase: JourneyPhase;
  candidateId?: string | null;
  leftAt?: Sec | null;
  boarded?: {
    routeNo: string;
    boardArs: string;
    vehicleReference: string | null;
    vehicleConfirmed: boolean; // 사용자가 차량을 확인했는지. 자동으로 첫 차량이라 정하지 않음
    boardedAt: Sec;
  } | null;
  secondBoarded?: { routeNo: string; boardArs: string; boardedAt: Sec } | null;
}

export type Feasibility =
  | 'comfortable' // 현재 계산상 여유 있음
  | 'tight' // 촉박하거나 예측이 겹침
  | 'infeasible' // 현재 계산상 연결 어려움
  | 'unobserved_next' // 관측된 차량 모두 놓침, 이후 차량 미확인
  | 'waiting' // 운행대기
  | 'no_realtime' // 정적 경로는 있으나 실시간 판단 불가
  | 'stale' // 오래된 정보 — 갱신 필요
  | 'not_applicable'; // 현재 진행 상태와 맞지 않음

export type LeaveAdvice =
  | { kind: 'leave_in'; atSec: Sec; minutes: number }
  | { kind: 'leave_now' }
  | { kind: 'leave_now_tight' }
  | { kind: 'conservative_now' } // 근거 부족 — 지금 출발 권장, 탑승 보장 안 함
  | { kind: 'none' };

export interface SegmentEvidence {
  segment: 'first_walk' | 'first_arrival' | 'first_ride' | 'transfer_walk' | 'second_arrival' | 'second_ride' | 'walks';
  evidenceKind: EvidenceKind;
  origin: DataOrigin;
  note: string;
}

export interface FirstWalkEstimate { lowSec: number; nominalSec: number; highSec: number; measured: boolean }

export interface ItineraryEvaluation {
  /** 문→첫 정류장(건물 나가기 포함 여부는 measured/설정에 따름) */
  firstWalkEstimate?: FirstWalkEstimate;
  candidateId: string;
  kind: 'direct' | 'transfer';
  constituentRoutes: string[];
  feasibility: Feasibility;
  tier: 'observed' | 'estimate' | 'none';
  firstVehicle: ArrivalObservation | null;
  secondVehicle: ArrivalObservation | null;
  firstReadyAt: Sec | null;
  firstBoardingEstimate: TimeEstimate | null;
  transferArrivalEstimate: TimeEstimate | null;
  transferReadyEstimate: TimeEstimate | null;
  transferRequiredAt: Sec | null;
  transferBoardingEstimate: TimeEstimate | null;
  destinationEstimate: TimeEstimate | null;
  destinationConditional: boolean; // 촉박: 선택 차량 탑승 시의 조건부 도착
  destinationIfMissed: TimeEstimate | null; // 놓쳤을 때(다음 차량이 실제 관측된 경우만)
  firstWaitSec: number | null;
  transferWaitSec: number | null; // 실제 환승 대기 = 둘째 승차 − 환승 준비
  transferSlackSec: number | null; // 계산상 여유 = 둘째 승차 − (환승 준비 + 여유)
  outdoorWaitSec: number | null;
  indoorWaitSec: number | null;
  walkSec: number;
  totalSec: number | null;
  recommendedLeaveAt: Sec | null;
  leaveAdvice: LeaveAdvice;
  evidence: SegmentEvidence[];
  warnings: string[];
  dataAgeSec: number | null;
  evaluatedAt: Sec;
  expiresAt: Sec | null;
}

export type CrowdTemporalKind = 'near_realtime' | 'historical_typical' | 'estimated';
export interface CrowdObservation {
  kind: 'onboard' | 'people_area' | 'road';
  source: string;
  scopeId: string;
  scopeKind: 'stop' | 'vehicle' | 'commercial_area' | 'admin_dong' | 'road_segment';
  observedAt: Sec | null;
  fetchedAt: Sec;
  temporalKind: CrowdTemporalKind;
  value: number | null;
  unit: string;
  level: string | null;
  missingReason: string | null;
}
