import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidatesPayload, RouteStop, RouteVehicles, Snapshot, TripId } from '../shared/api';

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
async function api<T>(path: string, timeoutMs = 25000): Promise<T> {
  const base = await apiBase();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${path}`, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
type Bundled = CandidatesPayload & { routeStops: Record<string, RouteStop[]> };
// 앱에 든 공식 정적 후보(서버에 닿지 않거나 옛 서버일 때). 첫 화면을 무겁게 하지 않게 따로 불러옴
const bundledTrip = (t: TripId): Promise<Bundled> => (t === 'forward' ? import('../shared/candidates.generated.json') : import('../shared/candidates.reverse.generated.json')).then((m) => (m.default ?? m) as unknown as Bundled);
const bundledRouteStops = (): Promise<Record<string, RouteStop[]>> => Promise.all([bundledTrip('reverse'), bundledTrip('forward')]).then(([r, f]) => ({ ...r.routeStops, ...f.routeStops }));

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
const WAKE_WINDOW_MS = 120_000; // 깨우기 대기 최대 2분
const WAKE_RETRY_MS = 5_000;

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
  const [, setT] = useState(nowSec());
  useEffect(() => {
    const id = setInterval(() => setT(nowSec()), 5000);
    return () => clearInterval(id);
  }, []);
  // 렌더 시점의 실제 시각을 사용(타이머 값은 다시 그리기용). 새로 받은 자료보다 '현재'가 과거로 보여
  // 나이가 음수(=시간 기준 오류 → 오래됨)로 잘못 판정되던 문제 방지
  return nowSec() + offsetRef.current;
}

export function useData(trip: TripId = 'forward') {
  const [cands, setCands] = useState<CandidatesPayload | null>(null);
  const [routeStops, setRouteStops] = useState<Record<string, RouteStop[]>>({});
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  // 무료 서버는 쉬다가 깨는 데 30~60초 걸릴 수 있어 바로 '끊김'이라 하지 않고 '깨우는 중'으로 재시도
  const [connection, setConnection] = useState<'connecting' | 'waking' | 'ok' | 'lost'>('connecting');
  const failSince = useRef<number | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wakeElapsed, setWakeElapsed] = useState(0);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(false);
  const offset = useRef(0);
  const visible = useVisible();
  // 옛 서버(방향 미지원)는 ?trip 을 무시하고 가는 길 스냅샷을 준다 → 오는 길 실시간은 '서버 업데이트 필요'로 정직하게 표시
  const [tripUnsupported, setTripUnsupported] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    // 후보 경로·노선 정류소는 한 번만 (매 갱신마다 길찾기 재호출 안 함)
    // API에 닿지 않으면 앱에 포함된 공식 정적 후보(같은 자료)를 사용
    api<CandidatesPayload>(`/api/candidates?trip=${trip}`)
      .then(async (c) => setCands((c.trip ?? 'forward') === trip ? c : await bundledTrip(trip)))
      .catch(async () => setCands(await bundledTrip(trip)));
    // 노선 정류소 목록은 노선 전체 값이라 앱에 든 공식 자료와 합침(옛 서버엔 오는 길 전용 노선이 없을 수 있음)
    Promise.all([api<Record<string, RouteStop[]>>('/api/routes').catch(() => ({})), bundledRouteStops()]).then(([r, b]) => setRouteStops({ ...b, ...r }));
  }, [trip]);

  const refresh = useCallback(async (manual = false) => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    if (manual && failSince.current != null && Date.now() - failSince.current > WAKE_WINDOW_MS) failSince.current = Date.now(); // 다시 깨우기
    setLoading(true);
    try {
      const raw = await api<Snapshot>(`/api/snapshot?trip=${trip}`);
      offset.current = raw.serverTime - nowSec();
      const unsupported = (raw.trip ?? 'forward') !== trip;
      setTripUnsupported(unsupported);
      // 다른 방향의 실시간 값을 이 방향 정류장에 섞지 않음: 도착 정보는 비우고 상태만 유지
      const s: Snapshot = unsupported ? { ...raw, trip, boards: [], verification: [], mode: raw.mode === 'sample' ? 'sample' : 'live_degraded', providerMessage: null } : raw;
      setSnap(s);
      setNetError(null);
      setConnection('ok');
      failSince.current = null;
      setWakeElapsed(0);
      setDemo(false);
    } catch {
      if (failSince.current == null) failSince.current = Date.now();
      const elapsed = Date.now() - failSince.current;
      setWakeElapsed(Math.round(elapsed / 1000));
      if (elapsed < WAKE_WINDOW_MS) {
        setConnection('waking');
        setNetError(null);
        retryTimer.current = setTimeout(() => refreshRef.current(), WAKE_RETRY_MS);
      } else {
        setConnection('lost');
        setNetError('실시간 연결이 끊겼어요. 받은 정보는 시간이 지나면 ‘갱신 필요’로 바뀌어요.');
      }
    } finally {
      setLoading(false);
    }
  }, [trip]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);

  useEffect(() => {
    if (!visible || !online) return; // 화면이 숨겨지면 폴링 중단, 복귀 시 즉시 갱신
    refresh();
    const id = setInterval(() => { if (!retryTimer.current) refresh(); }, Math.max(30, snap?.ttlSec ?? 30) * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, online, refresh]);

  return { tripUnsupported, cands, routeStops, snap, netError: online ? netError : '오프라인이에요. 연결되면 다시 불러올게요.', loading, refresh, offset, connection: online ? connection : 'lost', wakeElapsed, demo, setDemo };
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
