// 혼잡 정보: '버스 안', '주변 사람', '도로'를 분리. 시간대 통계를 현재 인파로 쓰지 않는다.
import type { CrowdObservation, Sec } from './types';

export interface CrowdDisplay {
  show: boolean;
  title: string;
  label: string;
  isCurrent: boolean; // '지금' 정보로 표시 가능한가
  usableForBoardingDecision: false; // 인파로 승차 가능성을 계산하지 않음 (별도 검증 전)
}

const TITLES = { onboard: '버스 안', people_area: '주변 사람', road: '도로 정체' } as const;

export function crowdDisplay(obs: CrowdObservation | null, kind: CrowdObservation['kind'], now: Sec): CrowdDisplay {
  const title = TITLES[kind];
  if (!obs || obs.value == null) {
    return { show: true, title, label: obs?.missingReason ?? '확인 불가 — 검증된 제공원 없음', isCurrent: false, usableForBoardingDecision: false };
  }
  const scopeName = obs.scopeKind === 'commercial_area' ? '주변 상권' : obs.scopeKind === 'admin_dong' ? '행정동' : obs.scopeKind === 'stop' ? '정류장' : obs.scopeKind === 'vehicle' ? '차량' : '도로 구간';
  if (obs.temporalKind === 'historical_typical') {
    return { show: true, title, label: `평소 통계(${scopeName} · ${obs.source}) — 지금 상황 아님`, isCurrent: false, usableForBoardingDecision: false };
  }
  if (obs.temporalKind === 'estimated') {
    return { show: true, title, label: `추정값(${scopeName} · ${obs.source})`, isCurrent: false, usableForBoardingDecision: false };
  }
  // near_realtime: 관측시각이 오래되지 않았을 때만 '현재'. 10분 단위 자료 기준 20분 허용
  const fresh = obs.observedAt != null && now - obs.observedAt <= 20 * 60;
  return {
    show: true,
    title,
    label: `${scopeName} ${obs.level ?? obs.value + obs.unit} (${obs.source}${fresh ? '' : ' · 오래된 관측'})`,
    isCurrent: fresh,
    usableForBoardingDecision: false,
  };
}
