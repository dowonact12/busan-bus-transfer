// /api 라우팅을 Node 서버(로컬·Render)와 Vercel 함수가 함께 쓴다. 서비스키는 서버 환경변수에서만 읽고 응답·로그에 넣지 않는다.
import type http from 'node:http';
import { redact } from './env';
import { BimsClient } from './bimsClient';
import { RealtimeService, type BstopEntry } from './realtime';
import type { CandidatesPayload, TripId } from '../shared/api';
import type { CandidateRoute } from '../shared/types';

export type Gen = CandidatesPayload & { routeStops: Record<string, unknown[]> };
export interface AppData { forward: Gen; reverse: Gen | null; bstopMap: Record<string, BstopEntry> }
export interface AppOptions { key: string | undefined; allowedOrigins: string[]; platform: string; ttlSec?: number }

export function sendJson(res: http.ServerResponse, code: number, body: string, extra: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(body);
}

export function createApi(data: AppData, opts: AppOptions) {
  const trips: Record<TripId, Gen | null> = { forward: data.forward, reverse: data.reverse };
  const gen = data.forward;
  const allRouteStops: Record<string, unknown[]> = { ...(data.reverse?.routeStops ?? {}), ...gen.routeStops };
  const allCandidates: CandidateRoute[] = [...gen.candidates, ...(data.reverse?.candidates ?? [])];
  const tripIds: Record<TripId, Set<string>> = { forward: new Set(gen.candidates.map((c) => c.id)), reverse: new Set((data.reverse?.candidates ?? []).map((c) => c.id)) };
  const tripOf = (u: URL): TripId => (u.searchParams.get('trip') === 'reverse' && trips.reverse ? 'reverse' : 'forward');
  const allowed = new Set(opts.allowedOrigins);
  const client = opts.key ? new BimsClient(opts.key) : null;
  const rt = new RealtimeService({ client, bstopMap: data.bstopMap, routeProvider: () => allCandidates, ttlSec: opts.ttlSec ?? 30 });
  const startedAt = Date.now();

  /** /api/* 처리. 처리했으면 true. pathname은 '/api/...' 형태 */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, '{}'); return true; }
    try {
      if (p === '/api/candidates') {
        const trip = tripOf(url), g = trips[trip]!;
        sendJson(res, 200, JSON.stringify({ trip, generatedAt: g.generatedAt, source: g.source, origin: g.origin, destination: g.destination, candidates: rt.getCandidates().filter((c) => tripIds[trip].has(c.id)) }));
      } else if (p === '/api/snapshot') {
        // 보고 있는 방향의 정류장만 조회(호출 수 절약). 같은 정류장은 캐시 공유
        const trip = tripOf(url);
        const snap = await rt.snapshot(rt.getCandidates().filter((c) => tripIds[trip].has(c.id)));
        sendJson(res, 200, JSON.stringify({ ...snap, trip }));
      } else if (p === '/api/vehicles') {
        const routes = (url.searchParams.get('routes') ?? '').split(',').filter((r) => r && allRouteStops[r]).slice(0, 6);
        const out = await Promise.all(routes.map((r) => rt.vehicles(r, allRouteStops[r].length)));
        sendJson(res, 200, JSON.stringify({ serverTime: Math.floor(Date.now() / 1000), routes: out }));
      } else if (p === '/api/routes') {
        sendJson(res, 200, JSON.stringify(allRouteStops));
      } else if (p === '/api/health') {
        sendJson(res, 200, JSON.stringify({ ok: true, keyConfigured: !!opts.key, bimsTransport: client?.transport() ?? 'none', trips: (Object.keys(trips) as TripId[]).filter((k) => trips[k]), platform: opts.platform, region: process.env.VERCEL_REGION ?? null, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));
      } else {
        sendJson(res, 404, JSON.stringify({ error: 'not found' }));
      }
    } catch (e) {
      console.error('request error:', redact(String((e as Error)?.stack ?? e), opts.key));
      sendJson(res, 500, JSON.stringify({ error: '서버 오류' }));
    }
    return true;
  }
  return { handle, rt };
}

export const parseOrigins = (v: string | undefined) => (v ?? 'https://dowonact12.github.io').split(',').map((s) => s.trim()).filter(Boolean);
