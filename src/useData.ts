import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidatesPayload, RouteStop, RouteVehicles, Snapshot } from '../shared/api';
import bundled from '../shared/candidates.generated.json';
import { sampleBoards, sampleVehicles } from '../shared/sample';

/** 런타임 설정: GitHub Pages에서는 config.json 의 apiBase(터널 주소)만 바꿔 재배포 */
let apiBasePromise: Promise<string> | null = null;
export function apiBase(): Promise<string> {
  if (!apiBasePromise) {
    apiBasePromise = fetch(`${import.meta.env.BASE_URL}config.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j: { apiBase?: string }) => (j.apiBase ?? '').replace(/\/$/, ''))
      .catch(() => '');
  }
  return apiBasePromise;
}
async function api<T>(path: string): Promise<T> {
  const base = await apiBase();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${base}${path}`, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
const bundledPayload = bundled as unknown as CandidatesPayload & { routeStops: Record<string, RouteStop[]> };

/** API에 닿지 않을 때 사용자가 고르는 '예시 화면' — origin='sample' 로만 생성 */
export function clientSampleSnapshot(cands: CandidatesPayload, now: number): Snapshot {
  const m = new Map<string, { ars: string; routeNo: string }>();
  for (const c of cands.candidates) {
    const [l1, l2] = c.legs;
    m.set(`${l1.board.ars}|${l1.routeNo}`, { ars: l1.board.ars, routeNo: l1.routeNo });
    if (l2) m.set(`${l2.board.ars}|${l2.routeNo}`, { ars: l2.board.ars, routeNo: l2.routeNo });
  }
  return { serverTime: now, mode: 'sample', keyConfigured: false, providerStatus: 'error', providerMessage: '실시간 연결 끊김 — 예시 화면', boards: sampleBoards([...m.values()], now), verification: [], routeInfo: [], callsToday: 0, ttlSec: 30 };
}
export { sampleVehicles };

const nowSec = () => Math.floor(Date.now() / 1000);

export function useVisible(): boolean {
  const [v, setV] = useState(typeof document === 'undefined' ? true : document.visibilityState === 'visible');
  useEffect(() => {
    const f = () => setV(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  return v;
}

/** 서버 시계 보정된 현재 시각(초). 5초마다 갱신 — 분 단위 데이터라 초 단위 카운트다운 안 함 */
export function useNow(offsetRef: React.MutableRefObject<number>): number {
  const [t, setT] = useState(nowSec());
  useEffect(() => {
    const id = setInterval(() => setT(nowSec()), 5000);
    return () => clearInterval(id);
  }, []);
  return t + offsetRef.current;
}

export function useData() {
  const [cands, setCands] = useState<CandidatesPayload | null>(null);
  const [routeStops, setRouteStops] = useState<Record<string, RouteStop[]>>({});
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'ok' | 'lost'>('connecting');
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(false);
  const offset = useRef(0);
  const visible = useVisible();
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    // 후보 경로·노선 정류소는 한 번만 (매 갱신마다 길찾기 재호출 안 함)
    // API에 닿지 않으면 앱에 포함된 공식 정적 후보(같은 자료)를 사용
    api<CandidatesPayload>('/api/candidates').then(setCands).catch(() => setCands(bundledPayload));
    api<Record<string, RouteStop[]>>('/api/routes').then(setRouteStops).catch(() => setRouteStops(bundledPayload.routeStops));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api<Snapshot>('/api/snapshot');
      offset.current = s.serverTime - nowSec();
      setSnap(s);
      setNetError(null);
      setConnection('ok');
      setDemo(false);
    } catch {
      setConnection('lost');
      setNetError('실시간 연결이 끊겼어요. 받은 정보는 시간이 지나면 ‘갱신 필요’로 바뀌어요.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible || !online) return; // 화면이 숨겨지면 폴링 중단, 복귀 시 즉시 갱신
    refresh();
    const id = setInterval(refresh, Math.max(30, snap?.ttlSec ?? 30) * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, online, refresh]);

  return { cands, routeStops, snap, netError: online ? netError : '오프라인이에요. 연결되면 다시 불러올게요.', loading, refresh, offset, connection: online ? connection : 'lost', demo, setDemo };
}

export function useVehicles(routes: string[], enabled: boolean, demo = false, routeLens: Record<string, number> = {}) {
  const [data, setData] = useState<Record<string, RouteVehicles>>({});
  const visible = useVisible();
  const key = [...new Set(routes)].sort().join(',');
  useEffect(() => {
    if (!visible || !key) return;
    if (demo) {
      const t = nowSec();
      setData(Object.fromEntries(key.split(',').map((r) => [r, sampleVehicles(r, routeLens[r] ?? 60, t)])));
      return;
    }
    if (!enabled) return;
    let alive = true;
    const load = () => api<{ routes: RouteVehicles[] }>(`/api/vehicles?routes=${encodeURIComponent(key)}`).then((j) => {
      if (!alive) return;
      setData((d) => { const n = { ...d }; for (const rv of j.routes) n[rv.routeNo] = rv; return n; });
    }).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, visible, demo]);
  return data;
}

export function useLocal<T>(k: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(k); return s ? { ...init, ...JSON.parse(s) } : init; } catch { return init; }
  });
  const set = (nv: T) => { setV(nv); try { localStorage.setItem(k, JSON.stringify(nv)); } catch { /* ignore */ } };
  return [v, set];
}
