// 현장 보정(실사용자 측정): 문 → 평소 정류장 시간. 건물 나가기(3층 계단·엘리베이터)와 신호 대기를 포함한 '문→정류장' 전체.
// - 실측 정류장: 그 범위를 그대로 사용(걷기 속도 보정 미적용, 별도 '건물 나가기' 없음 → 이중 계산 방지)
// - 다른 정류장: 직선 추정 보행 + (실측 − 같은 정류장 추정 보행) = 문~큰길 시간(건물·신호)을 더함
import type { TripId } from './api';
import type { ArrivalObservation, CandidateRoute, DoorToStop, Settings } from './types';
import { DEFAULT_SETTINGS } from './types';

export interface DoorCalibration {
  /** 실측한 평소 첫 정류장 ARS */
  ars: string;
  stopName: string;
  /** 문 이름(집/회사) */
  from: string;
  lowMin: number;
  highMin: number;
  source: string;
}

export const MEASURED_LABEL = '직접 측정(사용자)';

export const DOOR_CALIBRATION: Record<TripId, DoorCalibration> = {
  // 돌아올 때: 회사 3층 → 연산역.연제초교(13706), 3층 나가기·신호 포함 5~7분
  forward: { ars: '13706', stopName: '연산역.연제초교', from: '회사(3층)', lowMin: 5, highMin: 7, source: MEASURED_LABEL },
  // 갈 때: 집(반여로 67) → 한화꿈에그린아파트(09198), 5~7분
  reverse: { ars: '09198', stopName: '한화꿈에그린아파트', from: '집', lowMin: 5, highMin: 7, source: MEASURED_LABEL },
};

/** 본인 경험 규칙(갈 때 43번): 8정거장 전에 나서면 정류장에 버스보다 3분(가끔 5분) 먼저 도착 */
export interface RuleOfThumb { routeNo: string; ars: string; stopsBefore: number; text: string }
export const RULE_OF_THUMB: Partial<Record<TripId, RuleOfThumb>> = {
  reverse: { routeNo: '43', ars: '09198', stopsBefore: 8, text: '보통 8정거장 전에 출발' },
};

// ── 기기 저장 설정 ──
export const PREFS_VERSION = 2;
export interface UserPrefsV2 { v: 2; doorLowMin: number; doorHighMin: number; walkMult: number }
const WALK_CHOICES = [1.25, 1, 0.85];

export function defaultPrefs(trip: TripId): UserPrefsV2 {
  const c = DOOR_CALIBRATION[trip];
  return { v: 2, doorLowMin: c.lowMin, doorHighMin: c.highMin, walkMult: 1 };
}

const clampMin = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(30, Math.max(1, Math.round(n))) : d);

/**
 * 예전 저장값({exitMin: 2, walkMult}) → v2. 예전 '건물 나가기 2분 + 추정 보행'은 실측 문→정류장 범위에 이미 포함되므로
 * exitMin은 버리고(이중 계산 방지) 걷기 속도만 이어받는다.
 */
export function migratePrefs(raw: unknown, trip: TripId): UserPrefsV2 {
  const d = defaultPrefs(trip);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const walkMult = typeof r.walkMult === 'number' && WALK_CHOICES.includes(r.walkMult) ? r.walkMult : 1;
  if (r.v !== PREFS_VERSION) return { ...d, walkMult };
  let lo = clampMin(r.doorLowMin, d.doorLowMin);
  let hi = clampMin(r.doorHighMin, d.doorHighMin);
  if (lo > hi) [lo, hi] = [hi, lo];
  return { v: 2, doorLowMin: lo, doorHighMin: hi, walkMult };
}

export function doorRange(p: UserPrefsV2): DoorToStop {
  return { lowSec: p.doorLowMin * 60, nominalSec: Math.round(((p.doorLowMin + p.doorHighMin) / 2) * 60), highSec: p.doorHighMin * 60 };
}

/** 실측 정류장의 직선 추정 보행(초). 후보 중 그 정류장에서 타는 것의 firstWalk */
export function estimatedWalkTo(ars: string, candidates: CandidateRoute[]): number | null {
  const c = candidates.find((x) => x.legs[0]?.board.ars === ars);
  return c ? c.firstWalk.sec : null;
}

/** 방향별 보정 설정: 건물 나가기 0(실측에 포함), 실측 정류장 범위, 나머지 정류장엔 역산한 문~큰길 시간 */
export function calibratedSettings(trip: TripId, prefs: UserPrefsV2, candidates: CandidateRoute[], base: Settings = DEFAULT_SETTINGS): Settings {
  const cal = DOOR_CALIBRATION[trip];
  const range = doorRange(prefs);
  const est = estimatedWalkTo(cal.ars, candidates);
  const overhead = est != null ? Math.max(0, range.nominalSec - Math.round(est * prefs.walkMult)) : 0;
  return {
    ...base,
    buildingExitSec: 0,
    buildingExitHighSec: 0,
    walkMultiplier: prefs.walkMult,
    doorToStop: { [cal.ars]: range },
    doorOverheadSec: overhead,
  };
}

/**
 * 추천 출발 시각에 그 버스가 몇 정거장 전일지(실시간 예측의 남은 정거장·분을 같은 속도로 선형 어림).
 * 남은 정거장 정보가 없으면 null.
 */
export function stopsAwayAtLeave(obs: Pick<ArrivalObservation, 'remainingStops' | 'etaAt'> | null | undefined, leaveAt: number, now: number): { now: number; atLeave: number } | null {
  if (!obs || obs.remainingStops == null || obs.etaAt == null) return null;
  const cur = obs.remainingStops;
  const total = obs.etaAt - now;
  if (total <= 0 || leaveAt <= now) return { now: cur, atLeave: cur };
  const frac = Math.max(0, (obs.etaAt - leaveAt) / total);
  return { now: cur, atLeave: Math.max(0, Math.round(cur * frac)) };
}
