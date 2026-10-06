import type { DataOrigin, EvidenceKind, Sec, TimeEstimate } from '../shared/types';

const fmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtS = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const hhmm = (t: Sec | null | undefined) => (t == null ? '—' : fmt.format(new Date(t * 1000)));
export const hhmmss = (t: Sec | null | undefined) => (t == null ? '—' : fmtS.format(new Date(t * 1000)));
export const minText = (sec: number | null | undefined) => (sec == null ? '—' : `${Math.max(0, Math.round(sec / 60))}분`);
export const untilText = (t: Sec | null | undefined, now: Sec) => {
  if (t == null) return '—';
  const m = Math.floor((t - now) / 60);
  return m <= 0 ? '곧' : `${m}분 후`;
};
export function rangeText(e: TimeEstimate | null): string | null {
  if (!e || e.earliestAt == null) return null;
  if (e.latestAt == null) return `${hhmm(e.earliestAt)} 이후 · 늦어질 경우 미확정`;
  if (Math.abs(e.latestAt - e.earliestAt) < 60) return null;
  return `${hhmm(e.earliestAt)}~${hhmm(e.latestAt)} (가정한 여유 범위)`;
}
export function evidenceLabel(kind: EvidenceKind, origin: DataOrigin): string {
  if (origin === 'sample' && kind === 'realtime_prediction') return '예시값';
  switch (kind) {
    case 'realtime_prediction': return '실시간 예측';
    case 'static_duration': return '추정';
    case 'headway_estimate': return '배차 기준 추정';
    case 'user_confirmed': return '탑승 확인';
    default: return '확인 불가';
  }
}
export const kakaoMap = (name: string, lat: number, lon: number) => `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lon}`;
