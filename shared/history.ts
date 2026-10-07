// 내 기록(기기 안 localStorage에만). 서버로 보내지 않음. 탄 시각·노선·차량번호(표시용)만 저장.
// 같은 방향·평일/주말·시간대 기록이 3번 이상이면 중앙값을 모델 추정과 섞어 씀 → '내 기록 기반 (n회)'
import type { TripId } from './api';
import type { Sec } from './types';

export interface TripRecord {
  id: string;
  trip: TripId;
  candidateId: string;
  routeNo: string;
  boardArs: string;
  vehicleRef: string | null;
  leftAt: Sec | null; // '출발했어요'
  atStopAt: Sec | null; // '정류장 도착'
  boardedAt: Sec; // '이 버스 탔어요'
  arrivedAt: Sec | null; // '도착했어요'
}

export const HISTORY_KEY = 'bbt.history';
export const HISTORY_MAX = 300;
export const MIN_SAMPLES = 3;

export type DayType = 'weekday' | 'weekend';
const KST = 9 * 3600;
export function dayType(t: Sec): DayType { const d = new Date((t + KST) * 1000).getUTCDay(); return d === 0 || d === 6 ? 'weekend' : 'weekday'; }
export function hourOf(t: Sec): number { return new Date((t + KST) * 1000).getUTCHours(); }
export interface Bucket { trip: TripId; day: DayType; hour: number }
export const bucketOf = (trip: TripId, t: Sec): Bucket => ({ trip, day: dayType(t), hour: hourOf(t) });
const sameBucket = (a: Bucket, b: Bucket) => a.trip === b.trip && a.day === b.day && a.hour === b.hour;

/** 기록에서 시간 구간 뽑기(말이 안 되는 값은 버림) */
export function durations(r: TripRecord): { walkSec: number | null; waitSec: number | null; doorToBoardSec: number | null; rideSec: number | null } {
  const ok = (x: number | null, max: number) => (x != null && x > 0 && x <= max ? x : null);
  const walkSec = r.leftAt != null && r.atStopAt != null ? ok(r.atStopAt - r.leftAt, 45 * 60) : null;
  const waitSec = r.atStopAt != null ? ok(r.boardedAt - r.atStopAt, 60 * 60) ?? (r.boardedAt === r.atStopAt ? 0 : null) : null;
  const doorToBoardSec = r.leftAt != null ? ok(r.boardedAt - r.leftAt, 90 * 60) : null;
  const rideSec = r.arrivedAt != null ? ok(r.arrivedAt - r.boardedAt, 3 * 3600) : null;
  return { walkSec, waitSec, doorToBoardSec, rideSec };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export interface Blended { sec: number; n: number; learned: boolean; medianSec: number | null; modelSec: number }
/** n < 3 이면 모델 그대로. n ≥ 3 이면 가중 평균: 내 기록 가중치 n/(n+3) (3회 50%, 9회 75%, 최대 85%) */
export function blend(modelSec: number, samples: number[]): Blended {
  const n = samples.length;
  const med = median(samples);
  if (n < MIN_SAMPLES || med == null) return { sec: modelSec, n, learned: false, medianSec: med, modelSec };
  const w = Math.min(0.85, n / (n + 3));
  return { sec: Math.round(w * med + (1 - w) * modelSec), n, learned: true, medianSec: med, modelSec };
}

type Field = 'walkSec' | 'waitSec' | 'rideSec' | 'doorToBoardSec';
/** 같은 방향·요일 종류·시간대(출발 기준 시각) 기록 중 조건에 맞는 구간 값 */
export function samplesFor(records: TripRecord[], b: Bucket, field: Field, match: (r: TripRecord) => boolean = () => true): number[] {
  return records.filter((r) => sameBucket(bucketOf(r.trip, r.leftAt ?? r.boardedAt), b) && match(r)).map((r) => durations(r)[field]).filter((x): x is number => x != null);
}

/** 문→정류장(정류장별) 학습값: 실측 기본값과 섞음 */
export function learnedDoorToStop(records: TripRecord[], trip: TripId, now: Sec, boardArs: string, model: { lowSec: number; nominalSec: number; highSec: number }) {
  const s = samplesFor(records, bucketOf(trip, now), 'walkSec', (r) => r.boardArs === boardArs);
  const b = blend(model.nominalSec, s);
  if (!b.learned) return { range: model, blended: b };
  const shift = b.sec - model.nominalSec;
  const maxObs = Math.max(...s);
  return { range: { lowSec: Math.max(60, model.lowSec + shift), nominalSec: b.sec, highSec: Math.max(model.highSec + shift, Math.min(maxObs, b.sec + 180)) }, blended: b };
}

/** 탄 뒤 도착까지(경로별) 학습값 */
export function learnedRide(records: TripRecord[], trip: TripId, now: Sec, candidateId: string, modelSec: number): Blended {
  return blend(modelSec, samplesFor(records, bucketOf(trip, now), 'rideSec', (r) => r.candidateId === candidateId));
}

export function parseHistory(raw: string | null): TripRecord[] {
  try {
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a.filter((r) => r && typeof r.boardedAt === 'number' && (r.trip === 'forward' || r.trip === 'reverse')).slice(-HISTORY_MAX) : [];
  } catch { return []; }
}
export function upsertRecord(list: TripRecord[], r: TripRecord): TripRecord[] {
  const i = list.findIndex((x) => x.id === r.id);
  const out = i >= 0 ? list.map((x, j) => (j === i ? r : x)) : [...list, r];
  return out.slice(-HISTORY_MAX);
}
