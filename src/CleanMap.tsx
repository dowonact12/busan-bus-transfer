import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { RouteStop } from '../shared/api';
import type { SchematicBus } from '../shared/schematic';
import type { CandidateRoute } from '../shared/types';
import { routeColor } from './BusBuddy';

const LeafletMap = lazy(() => import('./TripMap').then((m) => ({ default: m.TripMap })));
type Place = { lat: number; lon: number; label: string };
type Props = { cand: CandidateRoute; routeStops: Record<string, RouteStop[]>; buses: SchematicBus[]; origin: Place; dest: Place };

/** 깔끔한 밝은 지도: OpenFreeMap positron(무료·키 없음) + MapLibre. 위성/항공사진 레이어 없음.
 *  우리 노선 선 + 출발·환승·도착 3곳 + 버스만. WebGL이 안 되면 OSM 회색 타일(Leaflet)로 대신. */
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const DROP = /^(building|highway-name-(path|minor)|highway-shield|road_shield|airport|aeroway|waterway_line_label|water_name_line_label|railway.*dashline|boundary)/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function legLine(leg: CandidateRoute['legs'][number], stops: RouteStop[] | undefined): [number, number][] {
  const list = (stops ?? []).filter((s) => s.seq >= (leg.board.routeStopSequence ?? 0) && s.seq <= (leg.alight.routeStopSequence ?? 0));
  return list.length >= 2 ? list.map((s) => [s.lon, s.lat]) : [[leg.board.lon, leg.board.lat], [leg.alight.lon, leg.alight.lat]];
}

export function CleanMap(p: Props) {
  const [fallback, setFallback] = useState(false);
  if (fallback) return <Suspense fallback={<div className="map map-loading">지도 불러오는 중…</div>}><LeafletMap {...p} /></Suspense>;
  return <GlMap {...p} onFail={() => setFallback(true)} />;
}

function GlMap({ cand, routeStops, buses, onFail }: Props & { onFail: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const ref = useRef<{ ml: typeof import('maplibre-gl'); map: import('maplibre-gl').Map; markers: import('maplibre-gl').Marker[]; bounds: import('maplibre-gl').LngLatBounds } | null>(null);
  const stopKey = cand.legs.map((l) => `${l.routeNo}:${routeStops[l.routeNo]?.length ?? 0}`).join('|');

  useEffect(() => {
    let cancelled = false;
    Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]).then(([ml]) => {
      if (cancelled || !el.current) return;
      const lines = cand.legs.map((l) => ({ routeNo: l.routeNo, coords: legLine(l, routeStops[l.routeNo]) }));
      const bounds = new ml.LngLatBounds();
      lines.forEach((l) => l.coords.forEach((c) => bounds.extend(c)));
      let map: import('maplibre-gl').Map;
      try {
        map = new ml.Map({ container: el.current, style: STYLE, bounds, fitBoundsOptions: { padding: { top: 56, bottom: 30, left: 70, right: 70 } }, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false });
      } catch { onFail(); return; }
      map.touchZoomRotate.disableRotation();
      map.on('error', (e) => { if (!map.loaded() && /webgl/i.test(String(e.error?.message ?? ''))) onFail(); });
      map.on('style.load', () => {
        for (const layer of map.getStyle().layers ?? []) {
          if (DROP.test(layer.id)) map.removeLayer(layer.id);
          else if (layer.type === 'symbol' && /^(label_|highway-name-major|water_name_point)/.test(layer.id)) map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:ko'], ['get', 'name']]);
        }
        lines.forEach((l, i) => {
          const id = `leg${i}`;
          map.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l.coords } } });
          map.addLayer({ id: `${id}-casing`, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9 } });
          map.addLayer({ id: `${id}-line`, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': routeColor(l.routeNo), 'line-width': 5.5 } });
        });
        const l1 = cand.legs[0], l2 = cand.legs[1], last = (l2 ?? l1).alight;
        const pin = (lon: number, lat: number, role: string, cls: string, name: string) => {
          const d = document.createElement('div');
          d.className = `glp ${cls}`;
          d.innerHTML = `<i></i><span><b>${role}</b> ${esc(name)}</span>`;
          new ml.Marker({ element: d }).setLngLat([lon, lat]).addTo(map);
        };
        pin(l1.board.lon, l1.board.lat, '출발', 'glp-start', l1.board.name);
        if (l2) pin(l1.alight.lon, l1.alight.lat, '환승', 'glp-mid', l1.alight.name);
        pin(last.lon, last.lat, '도착', 'glp-end', last.name);
      });
      ref.current = { ml, map, markers: [], bounds };
      drawBuses();
    }).catch(onFail);
    return () => { cancelled = true; ref.current?.map.remove(); ref.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cand.id, stopKey]);

  const busKey = buses.map((b) => `${b.carno}@${b.lat},${b.lon},${b.stale}`).join('|');
  const drawBuses = () => {
    const m = ref.current;
    if (!m) return;
    m.markers.forEach((x) => x.remove());
    m.markers = buses.filter((b) => b.lat != null && b.lon != null).map((b) => {
      const d = document.createElement('div');
      d.className = `gl-bus${b.stale ? ' bus-stale' : ''}`;
      d.style.background = routeColor(b.routeNo);
      d.textContent = `🚌 ${b.routeNo}`;
      d.title = `${b.routeNo}번 ${b.plate4}`;
      return new m.ml.Marker({ element: d }).setLngLat([b.lon!, b.lat!]).addTo(m.map);
    });
  };
  useEffect(drawBuses, [busKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tripmap">
      <div ref={el} className="map gl-map" role="img" aria-label="경로 지도: 출발·환승·도착과 실시간 버스" />
      <div className="map-foot">
        <p className="fine">선은 정류장을 이은 선이라 실제 도로와 조금 달라요. 버스는 GPS가 있을 때만 보여요.</p>
        <button className="btn tiny soft" onClick={() => ref.current?.map.fitBounds(ref.current.bounds, { padding: { top: 56, bottom: 30, left: 70, right: 70 } })} aria-label="경로 전체 보기">↺ 전체</button>
      </div>
    </div>
  );
}
