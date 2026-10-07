// Vercel 빌드: 화면(vite) → .vercel/output/static, API → .vercel/output/functions/api.func (esbuild 단일 번들)
// Build Output API v3. 함수 지역은 서울(icn1). 화면은 같은 오리진 API(apiBase '')를 씀.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.vercel/output');
const region = process.env.FUNCTION_REGION || 'icn1';
fs.rmSync(out, { recursive: true, force: true });

execSync('npx vite build', { cwd: root, stdio: 'inherit', env: { ...process.env, PAGES_BASE: '/' } });
fs.cpSync(path.join(root, 'dist'), path.join(out, 'static'), { recursive: true });
fs.writeFileSync(path.join(out, 'static/config.json'), JSON.stringify({ apiBase: '' }) + '\n'); // 같은 오리진

const fn = path.join(out, 'functions/api.func');
fs.mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [path.join(root, 'server/vercel.ts')],
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outfile: path.join(fn, 'index.mjs'),
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
fs.writeFileSync(path.join(fn, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: false, maxDuration: 20, regions: [region] }, null, 2));
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: '/api?__p=$1' },
    { handle: 'filesystem' },
    { src: '^/assets/(.*)$', status: 404 },
    { src: '^/(.*)$', dest: '/index.html' },
  ],
}, null, 2));
// 안전 점검: 키 문자열이 산출물에 들어가지 않았는지
const key = process.env.BUSAN_BIMS_SERVICE_KEY;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(out)) {
  const s = fs.readFileSync(f, 'utf8');
  if ((key && (s.includes(key) || s.includes(encodeURIComponent(key)))) || /serviceKey=[A-Za-z0-9%]{20,}/.test(s)) { console.error('비밀값 의심 문자열 발견 → 중단:', path.relative(root, f)); process.exit(1); }
}
console.log(`vercel output ready (function region ${region})`);
