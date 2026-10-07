// Vercel 함수 진입점(Build Output API로 번들됨). 후보·정류장 매핑 JSON은 번들에 포함. 키는 Vercel 환경변수에서만.
import type http from 'node:http';
import { createApi, parseOrigins, sendJson, type Gen } from './app';
import forward from '../shared/candidates.generated.json';
import reverse from '../shared/candidates.reverse.generated.json';
import bstopMap from '../data/bstopid-map.json';

const api = createApi(
  { forward: forward as unknown as Gen, reverse: reverse as unknown as Gen, bstopMap: bstopMap as Record<string, { bstopid: string | null }> },
  { key: process.env.BUSAN_BIMS_SERVICE_KEY || undefined, allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS), platform: 'vercel' },
);

export default async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  // 라우트 재작성으로 들어오면 원래 경로가 __p에 담김
  const orig = url.searchParams.get('__p');
  if (orig != null) { url.pathname = `/api/${orig}`; url.searchParams.delete('__p'); }
  if (!(await api.handle(req, res, url))) sendJson(res, 404, JSON.stringify({ error: 'not found' }));
}
