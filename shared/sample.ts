// 예시 모드 전용 가짜 도착값. 실제 버스 시각이 아니다. origin='sample' 로 표시된다.
import type { ArrivalBoard, Sec } from './types';
import type { RouteVehicles } from './api';

function hash(s: string): number { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export function sampleBoards(pairs: { ars: string; routeNo: string }[], now: Sec): ArrivalBoard[] {
  return pairs.map(({ ars, routeNo }) => {
    const h = hash(`${ars}|${routeNo}`);
    const headway = (7 + (h % 12)) * 60;
    const phase = h % headway;
    const first = headway - ((now + phase) % headway);
    const mins = [first, first + headway].map((s) => Math.max(0, Math.floor(s / 60)));
    return {
      stopArs: ars, routeNo, fetchedAt: now, status: 'ok', origin: 'sample', headwaySec: null,
      observations: mins.map((m, i) => ({
        routeNo, lineId: null, direction: null, serviceVariant: null, stopArs: ars, vehicleReference: null, vehicleMatchStatus: 'unmatched' as const,
        providerObservedAt: null, fetchedAt: now, etaAt: now + m * 60, rawArrivalState: String(m), remainingStops: null,
        seats: { kind: 'unknown' as const, reason: '예시 모드' }, observationStatus: 'predicted' as const, expiryAt: now + 120, origin: 'sample' as const, order: i + 1,
      })),
    };
  });
}

export function sampleVehicles(routeNo: string, routeLen: number, now: Sec): RouteVehicles {
  const h = hash(routeNo);
  const n = Math.max(2, Math.round(routeLen / 18));
  const shift = Math.floor(now / 90) % Math.max(1, Math.round(routeLen / n));
  const vehicles = Array.from({ length: n }, (_, i) => ({
    stopIdx: 1 + ((Math.round((i * routeLen) / n) + shift + (h % 7)) % routeLen), carno: `예시${i + 1}`, lat: null, lon: null, gpsAt: null, lowFloor: null,
  }));
  return { routeNo, lineId: null, fetchedAt: now, origin: 'sample', status: 'ok', vehicles };
}
