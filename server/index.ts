// 로컬·Render용 단일 서버: 빌드된 화면(dist) 제공 + /api(server/app.ts). 서비스키는 서버 환경변수에서만 읽는다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, redact } from './env';
import { createApi, parseOrigins, type Gen } from './app';

const root = path.resolve(import.meta.dirname, '..');
loadEnv(root);
const KEY = process.env.BUSAN_BIMS_SERVICE_KEY || undefined;
const PORT = Number(process.env.PORT || 5179);
const HOST = process.env.HOST || '0.0.0.0'; // Render 등 컨테이너에서 외부 접속 허용
const readGen = (f: string): Gen | null => (fs.existsSync(path.join(root, f)) ? JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) : null);
const mapPath = path.join(root, 'data/bstopid-map.json');
// CORS: GitHub Pages 오리진만 허용 (같은 오리진 접근은 CORS 불필요)
const ALLOWED = parseOrigins(process.env.ALLOWED_ORIGINS);
const api = createApi(
  { forward: readGen('shared/candidates.generated.json')!, reverse: readGen('shared/candidates.reverse.generated.json'), bstopMap: fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {} },
  { key: KEY, allowedOrigins: ALLOWED, platform: process.env.RENDER ? 'render' : 'node' },
);

const dist = path.join(root, 'dist');
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const sendText = (res: http.ServerResponse, code: number, body: string) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (await api.handle(req, res, url)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, '');
    // 정적 파일
    let p = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
    if (!p.startsWith(dist)) return sendText(res, 403, 'forbidden');
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, 'index.html');
    if (!fs.existsSync(p)) return sendText(res, 503, '화면이 아직 빌드되지 않았어요. npm run build');
    const ext = path.extname(p);
    const cache = p.includes(`${path.sep}assets${path.sep}`) ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {};
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...(ext === '.html' ? { 'Cache-Control': 'no-cache' } : cache) });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    console.error('request error:', redact(String((e as Error)?.stack ?? e), KEY));
    sendText(res, 500, '서버 오류');
  }
});
server.listen(PORT, HOST, () => console.log(`busan-bus-transfer listening on http://${HOST}:${PORT} · realtime ${KEY ? 'key configured (value hidden)' : 'NOT configured → 예시 모드'} · CORS ${ALLOWED.join(',')}`));
