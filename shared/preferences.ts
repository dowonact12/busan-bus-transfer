// 사용자가 평소 타는 길(카톡으로 확인한 정류장·노선). 추천기는 비슷한 도착 그룹 안에서만 이 경로를 우선하고,
// 연결이 안 되면 1순위로 올리지 않는다.
import type { TripId } from './api';

export interface PreferredRoute {
  candidateId: string;
  /** 카드 배지 */
  badge: string;
  /** 짧은 설명 */
  note: string;
  /** 대안일 때 붙는 이유 라벨 */
  altLabel: string;
  /** 사람 읽는 정류장 요약(검증용·정보 표시) */
  summary: string;
}

/**
 * forward = 중앙대로 1067 → 반여로 67 (돌아올 때)
 * reverse = 반여로 67 → 중앙대로 1067 (갈 때)
 */
export const PREFERRED_BY_TRIP: Record<TripId, PreferredRoute> = {
  // 돌아올 때: 연제초교 13706 29번 → 동래시장 06712(같은 정류장) 43번 → 한화꿈에그린 09199
  // 동래시장 반대편 06711과는 78m(다른 ARS). 06712는 29·43 동일 ARS = 같은 자리 환승.
  forward: {
    candidateId: 'T-29-13706-06712-43-06712-09199',
    badge: '평소 경로',
    note: '자리 잡기 좋은 평소 노선',
    altLabel: '평소 타는 길',
    summary: '연산역.연제초교(13706) 29 → 동래시장(06712) 같은 정류장 43 → 한화꿈에그린(09199)',
  },
  // 갈 때: 한화꿈에그린 09198 43 → 안락동우체국 06707(같은 정류장)에서 29를 일찍 타 자리 확보 → 연제초교 13707
  // 29는 반여로 67 700m 안에 정류장이 없어 43으로 안락까지 이동. 06707은 29 순번 49(낙민·동래시장보다 앞).
  reverse: {
    candidateId: 'T-43-09198-06707-29-06707-13707',
    badge: '평소 경로',
    note: '자리 잡기 좋은 평소 노선 · 안락에서 29를 일찍',
    altLabel: '평소 타는 길',
    summary: '한화꿈에그린(09198) 43 → 안락동우체국(06707) 같은 정류장 29 → 연산역.연제초교(13707)',
  },
};

export function preferredFor(trip: TripId): PreferredRoute {
  return PREFERRED_BY_TRIP[trip];
}
