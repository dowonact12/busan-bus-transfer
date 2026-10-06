import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { RouteStop } from '../shared/api';
import type { SchematicBus } from '../shared/schematic';
import { gpsAgeText } from '../shared/schematic';
import type { CandidateRoute } from '../shared/types';
import { routeColor } from './BusBuddy';

// 핀(위로 약 45px)·이름표가 잘리지 않게 위·옆 여백을 넉넉히
const FIT = { paddingTopLeft: [46, 58] as [number, number], paddingBottomRight: [46, 26] as [number, number] };
type Place = { lat: number; lon: number; label: string };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * 간단한 지도: OpenStreetMap 기본 타일(무료 · 출처 표기 · 소량 개인 사용, 브라우저에서 옅게 보정) 위에
 * (CARTO Positron은 이제 API 키(가입)가 필요해서 쓰지 않음)
 * 이 경로의 정류장 연결선 + 출발/환승/도착 핀 + 건물(대략) + 실시간 GPS 버스만.
 */
export function TripMap({ cand, routeStops, buses, origin, dest }: { cand: CandidateRoute; routeStops: Record<string, RouteStop[]>; buses: SchematicBus[]; origin: Place; dest: Place }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ L: typeof import('leaflet'); map: import('leaflet').Map; busLayer: import('leaflet').LayerGroup; bounds: import('leaflet').LatLngBounds } | null>(null);
  const stopKey = cand.legs.map((l) => `${l.routeNo}:${routeStops[l.routeNo]?.length ?? 0}`).join('|');

  useEffect(() => {
    let cancelled = false;
    import('leaflet').then((L) => {
      if (cancelled || !el.current) return;
      const map = L.map(el.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, zoomSnap: 0.25 });
      map.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, className: 'tiles-soft',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const pts: [number, number][] = [];
      const l1 = cand.legs[0], l2 = cand.legs[1];
      // 노선 선: 승차~하차 정류장을 순서대로 이은 선(실제 도로 모양 아님)
      for (const leg of cand.legs) {
        const list = (routeStops[leg.routeNo] ?? []).filter((s) => s.seq >= (leg.board.routeStopSequence ?? 0) && s.seq <= (leg.alight.routeStopSequence ?? 0));
        const line = list.length >= 2 ? list.map((s) => [s.lat, s.lon] as [number, number]) : [[leg.board.lat, leg.board.lon], [leg.alight.lat, leg.alight.lon]] as [number, number][];
        L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(map);
        L.polyline(line, { color: routeColor(leg.routeNo), weight: 6, opacity: 0.95 }).addTo(map);
        pts.push(...line);
      }
      // 걷는 구간(직선 점선)
      const walk = (a: [number, number], b: [number, number]) => L.polyline([a, b], { color: '#8a83a8', weight: 3, dashArray: '2 7', opacity: 0.9 }).addTo(map);
      walk([origin.lat, origin.lon], [l1.board.lat, l1.board.lon]);
      if (l2 && l2.board.ars !== l1.alight.ars) walk([l1.alight.lat, l1.alight.lon], [l2.board.lat, l2.board.lon]);
      const last = (l2 ?? l1).alight;
      walk([last.lat, last.lon], [dest.lat, dest.lon]);
      // 건물: 작은 표시 + '대략'
      const bld = (p: Place) => {
        L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'map-bld', html: `<em></em><span>🏢 ${esc(p.label)} <i>(대략)</i></span>`, iconSize: [0, 0] }), keyboard: false }).addTo(map);
        pts.push([p.lat, p.lon]);
      };
      bld(origin); bld(dest);
      // 큰 핀 3개
      const pin = (lat: number, lon: number, role: string, cls: string, name: string) => L.marker([lat, lon], {
        icon: L.divIcon({ className: 'map-pin-wrap', html: `<div class="map-pin ${cls}"><b>${role}</b><span>${esc(name)}</span></div>`, iconSize: [0, 0] }), zIndexOffset: 500,
      }).addTo(map);
      pin(l1.board.lat, l1.board.lon, '출발', 'pin-start', l1.board.name);
      if (l2) pin(l1.alight.lat, l1.alight.lon, '환승', 'pin-transfer', l1.alight.name);
      pin(last.lat, last.lon, '도착', 'pin-end', last.name);
      const bounds = L.latLngBounds(pts);
      map.fitBounds(bounds, FIT);
      mapRef.current = { L, map, busLayer: L.layerGroup().addTo(map), bounds };
      drawBuses();
    });
    return () => { cancelled = true; mapRef.current?.map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cand.id, stopKey, origin.lat, dest.lat]);

  const busKey = buses.map((b) => `${b.carno}@${b.lat},${b.lon},${b.stale}`).join('|');
  const drawBuses = () => {
    const m = mapRef.current;
    if (!m) return;
    m.busLayer.clearLayers();
    for (const b of buses) {
      if (b.lat == null || b.lon == null) continue;
      m.L.marker([b.lat, b.lon], {
        icon: m.L.divIcon({ className: 'map-bus', html: `<span class="${b.stale ? 'bus-stale' : ''}" style="background:${routeColor(b.routeNo)}">🚌 ${esc(b.routeNo)} · ${esc(b.plate4)}</span>`, iconSize: [0, 0] }),
        zIndexOffset: 1000, title: `${b.routeNo}번 ${b.carno} · ${gpsAgeText(b.gpsAgeSec)}`,
      }).addTo(m.busLayer);
    }
  };
  useEffect(drawBuses, [busKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tripmap">
      <div ref={el} className="map" role="img" aria-label="경로 지도: 출발·환승·도착 정류장과 실시간 버스" />
      <div className="map-foot">
        <p className="fine">색 선은 정류장을 순서대로 이은 선이라 실제 도로 모양과 달라요. 🏢 건물 위치는 대략이에요. 버스는 BIMS GPS 위치가 있을 때만 보여요.</p>
        <button className="btn tiny soft" onClick={() => mapRef.current?.map.fitBounds(mapRef.current.bounds, FIT)} aria-label="경로 전체 보기">↺ 전체</button>
      </div>
    </div>
  );
}
