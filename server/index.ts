// 단일 서버: 빌드된 화면(dist) 제공 + /api 프록시. 서비스키는 서버 환경변수에서만 읽는다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, redact } from './env';
import { BimsClient } from './bimsClient';
import { RealtimeService } from './realtime';
import type { CandidatesPayload } from '../shared/api';

const root = path.resolve(import.meta.dirname, '..');
loadEnv(root);
const KEY = process.env.BUSAN_BIMS_SERVICE_KEY || undefined;
const PORT = Number(process.env.PORT || 5179);
const gen: CandidatesPayload & { routeStops: Record<string, unknown[]> } = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.generated.json'), 'utf8'));
const mapPath = path.join(root, 'data/bstopid-map.json');
const bstopMap = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};

// CORS: GitHub Pages 오리진만 허용 (같은 오리진 접근은 CORS 불필요)
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS ?? 'https://dowonact12.github.io').split(',').map((s) => s.trim()).filter(Boolean));
const client = KEY ? new BimsClient(KEY) : null;
const rt = new RealtimeService({ client, bstopMap, routeProvider: () => gen.candidates, ttlSec: 30 });

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
      return send(res, 200, JSON.stringify({ generatedAt: gen.generatedAt, source: gen.source, origin: gen.origin, destination: gen.destination, candidates: rt.getCandidates() }));
    }
    if (url.pathname === '/api/snapshot') {
      const snap = await rt.snapshot();
      return send(res, 200, JSON.stringify(snap));
    }
    if (url.pathname === '/api/vehicles') {
      const routes = (url.searchParams.get('routes') ?? '').split(',').filter((r) => r && gen.routeStops?.[r]).slice(0, 6);
      const out = await Promise.all(routes.map((r) => rt.vehicles(r, gen.routeStops[r].length)));
      return send(res, 200, JSON.stringify({ serverTime: Math.floor(Date.now() / 1000), routes: out }));
    }
    if (url.pathname === '/api/routes') return send(res, 200, JSON.stringify(gen.routeStops ?? {}));
    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, keyConfigured: !!KEY }));
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
server.listen(PORT, () => console.log(`busan-bus-transfer listening on http://localhost:${PORT} · realtime ${KEY ? 'key configured (value hidden)' : 'NOT configured → 예시 모드'}`));
