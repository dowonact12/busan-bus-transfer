import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { RouteStop, RouteVehicles } from '../shared/api';
import type { CandidateRoute } from '../shared/types';
import { routeColor } from './BusBuddy';

/** OSM 기본 타일(무료, 출처 표기 필수, 소량 개인 사용). 선은 정류장 연결선이며 실제 도로 경로가 아님 */
export function MapView({ cand, routeStops, vehicles, origin, dest }: { cand: CandidateRoute; routeStops: Record<string, RouteStop[]>; vehicles: Record<string, RouteVehicles>; origin: { lat: number; lon: number }; dest: { lat: number; lon: number } }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let map: import('leaflet').Map | null = null;
    let cancelled = false;
    import('leaflet').then((L) => {
      if (cancelled || !el.current) return;
      map = L.map(el.current, { zoomControl: true, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
      const pts: [number, number][] = [];
      const dot = (lat: number, lon: number, color: string, label: string, r = 7) => { L.circleMarker([lat, lon], { radius: r, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).bindTooltip(label).addTo(map!); pts.push([lat, lon]); };
      dot(origin.lat, origin.lon, '#b9a3ea', '출발 (대략 위치 · 출입구 아님)', 8);
      dot(dest.lat, dest.lon, '#f6a6b9', '도착 (대략 위치 · 출입구 아님)', 8);
      for (const leg of cand.legs) {
        const list = (routeStops[leg.routeNo] ?? []).filter((s) => s.seq >= (leg.board.routeStopSequence ?? 0) && s.seq <= (leg.alight.routeStopSequence ?? 0));
        const c = routeColor(leg.routeNo);
        L.polyline(list.map((s) => [s.lat, s.lon] as [number, number]), { color: c, weight: 5, opacity: 0.8, dashArray: '2 8' }).addTo(map!);
        list.forEach((s) => dot(s.lat, s.lon, c, `${leg.routeNo}번 · ${s.name} (${s.ars})`, s.seq === leg.board.routeStopSequence || s.seq === leg.alight.routeStopSequence ? 8 : 4));
        for (const v of vehicles[leg.routeNo]?.vehicles ?? []) {
          if (v.lat == null || v.lon == null) continue;
          L.marker([v.lat, v.lon], { icon: L.divIcon({ className: 'map-bus', html: `<span style="background:${c}">🚌 ${leg.routeNo}</span>`, iconSize: [56, 24] }) }).bindTooltip(`${leg.routeNo}번 ${v.carno} (실시간 GPS)`).addTo(map!);
        }
      }
      map.fitBounds(L.latLngBounds(pts).pad(0.15));
    });
    return () => { cancelled = true; map?.remove(); };
  }, [cand, routeStops, vehicles, origin, dest]);
  return (
    <div>
      <div ref={el} className="map" aria-label="경로 지도" />
      <p className="fine">점선은 정류장끼리 이은 선이에요(실제 도로 아님). 출발·도착 점은 대략 위치예요. 버스 아이콘은 BIMS 실시간 GPS가 있을 때만 보여요.</p>
    </div>
  );
}
