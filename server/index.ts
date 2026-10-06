// 단일 서버: 빌드된 화면(dist) 제공 + /api 프록시. 서비스키는 서버 환경변수에서만 읽는다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, redact } from './env';
import { BimsClient } from './bimsClient';
import { RealtimeService } from './realtime';
import type { CandidatesPayload, TripId } from '../shared/api';
import type { CandidateRoute } from '../shared/types';

const root = path.resolve(import.meta.dirname, '..');
loadEnv(root);
const KEY = process.env.BUSAN_BIMS_SERVICE_KEY || undefined;
const PORT = Number(process.env.PORT || 5179);
const HOST = process.env.HOST || '0.0.0.0'; // Render 등 컨테이너에서 외부 접속 허용
type Gen = CandidatesPayload & { routeStops: Record<string, unknown[]> };
const readGen = (f: string): Gen | null => (fs.existsSync(path.join(root, f)) ? JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) : null);
// 가는 길(기본) + 오는 길. 노선 정류소 목록은 노선 전체라 두 방향이 같은 값을 공유
const trips: Record<TripId, Gen | null> = { forward: readGen('shared/candidates.generated.json'), reverse: readGen('shared/candidates.reverse.generated.json') };
const gen = trips.forward!;
const allRouteStops: Record<string, unknown[]> = { ...(trips.reverse?.routeStops ?? {}), ...gen.routeStops };
const tripOf = (u: URL): TripId => (u.searchParams.get('trip') === 'reverse' && trips.reverse ? 'reverse' : 'forward');
const allCandidates: CandidateRoute[] = [...gen.candidates, ...(trips.reverse?.candidates ?? [])];
const tripIds: Record<TripId, Set<string>> = { forward: new Set(gen.candidates.map((c) => c.id)), reverse: new Set((trips.reverse?.candidates ?? []).map((c) => c.id)) };
const mapPath = path.join(root, 'data/bstopid-map.json');
const bstopMap = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};

// CORS: GitHub Pages 오리진만 허용 (같은 오리진 접근은 CORS 불필요)
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS ?? 'https://dowonact12.github.io').split(',').map((s) => s.trim()).filter(Boolean));
const client = KEY ? new BimsClient(KEY) : null;
const rt = new RealtimeService({ client, bstopMap, routeProvider: () => allCandidates, ttlSec: 30 });

const dist = path.join(root, 'dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function send(res: http.ServerResponse, code: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const origin = req.headers.origin;
  if (url.pathname.startsWith('/api/') && origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '{}');
  try {
    if (url.pathname === '/api/candidates') {
      const trip = tripOf(url), g = trips[trip]!;
      return send(res, 200, JSON.stringify({ trip, generatedAt: g.generatedAt, source: g.source, origin: g.origin, destination: g.destination, candidates: rt.getCandidates().filter((c) => tripIds[trip].has(c.id)) }));
    }
    if (url.pathname === '/api/snapshot') {
      // 보고 있는 방향의 정류장만 조회(호출 수 절약). 같은 정류장은 캐시 공유
      const trip = tripOf(url);
      const snap = await rt.snapshot(rt.getCandidates().filter((c) => tripIds[trip].has(c.id)));
      return send(res, 200, JSON.stringify({ ...snap, trip }));
    }
    if (url.pathname === '/api/vehicles') {
      const routes = (url.searchParams.get('routes') ?? '').split(',').filter((r) => r && allRouteStops[r]).slice(0, 6);
      const out = await Promise.all(routes.map((r) => rt.vehicles(r, allRouteStops[r].length)));
      return send(res, 200, JSON.stringify({ serverTime: Math.floor(Date.now() / 1000), routes: out }));
    }
    if (url.pathname === '/api/routes') return send(res, 200, JSON.stringify(allRouteStops));
    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, keyConfigured: !!KEY, bimsTransport: client?.transport() ?? 'none', trips: Object.keys(trips).filter((k) => trips[k as TripId]), uptimeSec: Math.round(process.uptime()) }));
    // 정적 파일
    let p = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
    if (!p.startsWith(dist)) return send(res, 403, 'forbidden', 'text/plain');
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, 'index.html');
    if (!fs.existsSync(p)) return send(res, 503, '화면이 아직 빌드되지 않았어요. npm run build', 'text/plain; charset=utf-8');
    const ext = path.extname(p);
    const cache = p.includes(`${path.sep}assets${path.sep}`) ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {};
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...(ext === '.html' ? { 'Cache-Control': 'no-cache' } : cache) });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    console.error('request error:', redact(String((e as Error)?.stack ?? e), KEY));
    send(res, 500, JSON.stringify({ error: '서버 오류' }));
  }
});
server.listen(PORT, HOST, () => console.log(`busan-bus-transfer listening on http://${HOST}:${PORT} · realtime ${KEY ? 'key configured (value hidden)' : 'NOT configured → 예시 모드'} · CORS ${[...ALLOWED_ORIGINS].join(',')}`));
