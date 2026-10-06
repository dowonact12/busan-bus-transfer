// BusanRealtimeProvider: 정류소 단위 조회 공유·캐시·백오프. 길찾기(후보)는 한 번만 로드해 재사용.
import { normalizeBimsArrivalItem } from '../shared/normalizer';
import type { RealtimeMode, RouteServiceInfo, RouteVehicles, Snapshot, StopVerification, VehiclePosition } from '../shared/api';
import type { ArrivalBoard, CandidateRoute, Sec } from '../shared/types';
import type { BimsResult } from './bimsClient';
import { sampleBoards, sampleVehicles } from '../shared/sample';

export interface BimsLike {
  hasKey(): boolean;
  call(op: string, params: Record<string, string>): Promise<BimsResult>;
}
export interface BstopEntry { bstopid: string | null; verified?: boolean }

interface StopCache {
  fetchedAt: Sec | null;
  items: Record<string, string>[];
  lastError: BimsResult['errorKind'] | null;
  failures: number;
  retryAfter: Sec;
}

const kstDate = (t: Sec) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);
const nextKstMidnight = (t: Sec) => { const d = Math.floor((t + 9 * 3600) / 86400) + 1; return d * 86400 - 9 * 3600; };

export class RealtimeService {
  private candidates: CandidateRoute[] | null = null;
  private cache = new Map<string, StopCache>();
  private inflight = new Map<string, Promise<void>>();
  private dailyBlockedUntil: Sec = 0;
  private callsDay = '';
  callsToday = 0;
  routeProviderCalls = 0;
  private notRegistered = false;
  private routeInfo: RouteServiceInfo[] = [];
  private routeInfoDay = '';
  private seenIdx = new Map<string, { idx: number | null; at: Sec }>();
  private lineIds = new Map<string, string>();
  private vehCache = new Map<string, { at: Sec; data: RouteVehicles; retryAfter: Sec; failures: number }>();
  private vehInflight = new Map<string, Promise<RouteVehicles>>();

  constructor(
    private opts: {
      client: BimsLike | null;
      bstopMap: Record<string, BstopEntry>;
      routeProvider: () => CandidateRoute[];
      now?: () => Sec;
      ttlSec?: number;
      dailySoftLimit?: number;
      dailyHardLimit?: number;
    },
  ) {}

  private now(): Sec { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }
  getCandidates(): CandidateRoute[] {
    if (!this.candidates) { this.routeProviderCalls++; this.candidates = this.opts.routeProvider(); }
    return this.candidates;
  }
  ttl(): number {
    const base = this.opts.ttlSec ?? 30;
    return this.callsToday >= (this.opts.dailySoftLimit ?? 8000) ? Math.max(base, 120) : base;
  }
  /** 조회가 필요한 (정류소, 노선) 쌍 — 첫 승차, 첫 노선 하류(환승 하차), 환승 승차 */
  neededPairs(): { ars: string; routeNo: string; seq: number | null }[] {
    const m = new Map<string, { ars: string; routeNo: string; seq: number | null }>();
    for (const c of this.getCandidates()) {
      const l1 = c.legs[0], l2 = c.legs[1];
      const add = (ars: string, routeNo: string, seq?: number) => m.set(`${ars}|${routeNo}`, { ars, routeNo, seq: seq ?? null });
      add(l1.board.ars, l1.routeNo, l1.board.routeStopSequence);
      if (l2) { add(l1.alight.ars, l1.routeNo, l1.alight.routeStopSequence); add(l2.board.ars, l2.routeNo, l2.board.routeStopSequence); }
    }
    return [...m.values()];
  }
  private countCall(t: Sec) {
    const d = kstDate(t);
    if (d !== this.callsDay) { this.callsDay = d; this.callsToday = 0; }
    this.callsToday++;
  }

  private async refreshStop(ars: string): Promise<void> {
    const client = this.opts.client!;
    const t = this.now();
    const c = this.cache.get(ars) ?? { fetchedAt: null, items: [], lastError: null, failures: 0, retryAfter: 0 };
    this.cache.set(ars, c);
    if (c.fetchedAt != null && t - c.fetchedAt < this.ttl()) return; // 공유 캐시
    if (t < c.retryAfter || t < this.dailyBlockedUntil || this.notRegistered) return; // 백오프 중 재시도 안 함
    if (this.callsToday >= (this.opts.dailyHardLimit ?? 9800)) return;
    const entry = this.opts.bstopMap[ars];
    if (!entry?.bstopid) return;
    this.countCall(t);
    const r = await client.call('stopArrByBstopid', { bstopid: entry.bstopid });
    const t2 = this.now();
    if (r.ok) {
      c.fetchedAt = t2; c.items = r.items; c.lastError = null; c.failures = 0; c.retryAfter = 0;
      for (const it of r.items) if (it.lineno && it.lineid) this.lineIds.set(it.lineno, it.lineid);
      for (const it of r.items) this.seenIdx.set(`${ars}|${it.lineno}`, { idx: /^\d+$/.test(it.bstopidx ?? '') ? Number(it.bstopidx) : null, at: t2 });
      return;
    }
    c.lastError = r.errorKind ?? 'other';
    c.failures++;
    if (r.errorKind === 'rate_limited_daily') this.dailyBlockedUntil = nextKstMidnight(t2);
    else if (r.errorKind === 'not_registered') this.notRegistered = true;
    else c.retryAfter = t2 + Math.min(600, 30 * 2 ** (c.failures - 1));
  }

  private async ensureRouteInfo(): Promise<void> {
    const client = this.opts.client;
    const day = kstDate(this.now());
    if (!client?.hasKey() || this.routeInfoDay === day || this.notRegistered || this.now() < this.dailyBlockedUntil) return;
    this.routeInfoDay = day;
    const routes = [...new Set(this.getCandidates().flatMap((c) => c.routes))];
    const out: RouteServiceInfo[] = [];
    for (const no of routes) {
      this.countCall(this.now());
      const r = await client.call('busInfo', { lineno: no });
      const it = r.items.find((i) => i.buslinenum === no);
      out.push({ routeNo: no, firstTime: it?.firsttime ?? null, endTime: it?.endtime ?? null, startPoint: it?.startpoint ?? null, endPoint: it?.endpoint ?? null });
    }
    this.routeInfo = out;
  }

  /** busInfoByRouteId: 노선 정류소 + 차량 위치. 화면에 보이는 노선만, 노선당 TTL 공유 */
  async vehicles(routeNo: string, routeLen: number): Promise<RouteVehicles> {
    const client = this.opts.client;
    const t = this.now();
    if (!client || !client.hasKey() || this.notRegistered) return { ...sampleVehicles(routeNo, routeLen, t), status: client?.hasKey() ? 'error' : 'no_key' };
    const c = this.vehCache.get(routeNo);
    if (c && (t - c.at < this.ttl() || t < c.retryAfter || t < this.dailyBlockedUntil)) return c.data;
    const inf = this.vehInflight.get(routeNo);
    if (inf) return inf;
    const p = (async (): Promise<RouteVehicles> => {
      let lineId = this.lineIds.get(routeNo) ?? null;
      if (!lineId) {
        this.countCall(this.now());
        const r = await client.call('busInfo', { lineno: routeNo });
        lineId = r.items.find((i) => i.buslinenum === routeNo)?.lineid ?? null;
        if (lineId) this.lineIds.set(routeNo, lineId);
      }
      if (!lineId) return { routeNo, lineId: null, fetchedAt: null, origin: 'live', status: 'unknown_line', vehicles: [] };
      this.countCall(this.now());
      const r = await client.call('busInfoByRouteId', { lineid: lineId, numOfRows: '400' });
      const t2 = this.now();
      if (!r.ok) {
        const failures = (c?.failures ?? 0) + 1;
        if (r.errorKind === 'rate_limited_daily') this.dailyBlockedUntil = nextKstMidnight(t2);
        const data: RouteVehicles = c?.data ? { ...c.data, status: r.errorKind?.startsWith('rate') ? 'rate_limited' : 'error' } : { routeNo, lineId, fetchedAt: null, origin: 'live', status: 'error', vehicles: [] };
        this.vehCache.set(routeNo, { at: c?.at ?? 0, data, retryAfter: t2 + Math.min(600, 30 * 2 ** (failures - 1)), failures });
        return data;
      }
      const vehicles: VehiclePosition[] = r.items.filter((i) => i.carno && /^\d+$/.test(i.bstopidx ?? '')).map((i) => ({
        stopIdx: Number(i.bstopidx), carno: i.carno,
        lat: i.lat ? Number(i.lat) : null, lon: i.lin ? Number(i.lin) : null,
        gpsAt: gpsymToEpoch(i.gpsym, t2), lowFloor: i.lowplate === '1' ? true : i.lowplate === '0' ? false : null,
      }));
      const data: RouteVehicles = { routeNo, lineId, fetchedAt: t2, origin: 'live', status: 'ok', vehicles };
      this.vehCache.set(routeNo, { at: t2, data, retryAfter: 0, failures: 0 });
      return data;
    })().finally(() => this.vehInflight.delete(routeNo));
    this.vehInflight.set(routeNo, p);
    return p;
  }

  async snapshot(): Promise<Snapshot> {
    const pairs = this.neededPairs();
    const client = this.opts.client;
    const t0 = this.now();
    if (!client || !client.hasKey()) {
      return { serverTime: t0, mode: 'sample', keyConfigured: false, providerStatus: 'no_key', providerMessage: '키 연결 필요 — 예시 모드', boards: sampleBoards(pairs, t0), verification: [], routeInfo: [], callsToday: 0, ttlSec: this.ttl() };
    }
    const stops = [...new Set(pairs.map((p) => p.ars))];
    // 동시 호출 4개로 제한(초당 호출 제한 보호), 같은 정류소 진행 중 요청은 합침
    const queue = [...stops];
    const worker = async () => {
      while (queue.length) {
        const ars = queue.shift()!;
        const existing = this.inflight.get(ars);
        if (existing) { await existing; continue; }
        const p = this.refreshStop(ars).finally(() => this.inflight.delete(ars));
        this.inflight.set(ars, p);
        await p;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, stops.length) }, worker));
    this.ensureRouteInfo().catch(() => {});
    const t = this.now();
    const boards: ArrivalBoard[] = pairs.map(({ ars, routeNo }) => {
      const c = this.cache.get(ars);
      const mapped = !!this.opts.bstopMap[ars]?.bstopid;
      if (!mapped) return { stopArs: ars, routeNo, observations: [], fetchedAt: null, status: 'not_mapped', origin: 'live' };
      if (!c || c.fetchedAt == null) return { stopArs: ars, routeNo, observations: [], fetchedAt: null, status: c?.lastError?.startsWith('rate') ? 'rate_limited' : 'error', origin: 'live' };
      const obs = c.items.filter((i) => i.lineno === routeNo).flatMap((i) => normalizeBimsArrivalItem(i, { stopArs: ars, fetchedAt: c.fetchedAt!, origin: 'live' }));
      const status = c.lastError ? (c.lastError.startsWith('rate') ? 'rate_limited' : 'error') : obs.length ? 'ok' : 'empty';
      return { stopArs: ars, routeNo, observations: obs, fetchedAt: c.fetchedAt, status, origin: 'live', headwaySec: null };
    });
    const verification: StopVerification[] = pairs.map(({ ars, routeNo, seq }) => {
      const s = this.seenIdx.get(`${ars}|${routeNo}`);
      return { ars, routeNo, expectedSeq: seq, apiBstopidx: s?.idx ?? null, seqMatch: s && s.idx != null && seq != null ? s.idx === seq : null, bstopid: this.opts.bstopMap[ars]?.bstopid ?? null, liveSeenAt: s?.at ?? null };
    });
    const okStops = stops.filter((a) => this.cache.get(a)?.fetchedAt != null && !this.cache.get(a)?.lastError).length;
    let providerStatus: Snapshot['providerStatus'] = okStops === stops.length ? 'ok' : okStops > 0 ? 'partial' : 'error';
    let msg: string | null = null;
    if (this.notRegistered) { providerStatus = 'not_registered'; msg = '키가 아직 등록되지 않음(발급 직후 최대 1시간 소요 가능)'; }
    else if (t < this.dailyBlockedUntil) { providerStatus = 'rate_limited'; msg = '오늘 호출 한도 초과 — 자정 이후 재개'; }
    else if (providerStatus !== 'ok') msg = '일부 정류장 응답 오류 — 잠시 후 재시도';
    const mode: RealtimeMode = this.notRegistered ? 'sample' : providerStatus === 'ok' ? 'live' : 'live_degraded';
    if (mode === 'sample') {
      return { serverTime: t, mode, keyConfigured: true, providerStatus, providerMessage: msg, boards: sampleBoards(pairs, t), verification, routeInfo: [], callsToday: this.callsToday, ttlSec: this.ttl() };
    }
    return { serverTime: t, mode, keyConfigured: true, providerStatus, providerMessage: msg, boards, verification, routeInfo: this.routeInfo, callsToday: this.callsToday, ttlSec: this.ttl() };
  }
}

/** gpsym 'HHMMSS'(KST, 날짜 없음) → 수신시각에 가장 가까운 과거 시각(UTC epoch) */
export function gpsymToEpoch(v: string | undefined, fetchedAt: Sec): Sec | null {
  if (!v || !/^\d{6}$/.test(v)) return null;
  const h = Number(v.slice(0, 2)), m = Number(v.slice(2, 4)), s = Number(v.slice(4, 6));
  const dayStartKst = Math.floor((fetchedAt + 9 * 3600) / 86400) * 86400 - 9 * 3600;
  let t = dayStartKst + h * 3600 + m * 60 + s;
  if (t > fetchedAt + 300) t -= 86400; // 자정 넘김
  return t;
}
