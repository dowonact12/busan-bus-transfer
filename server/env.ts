// .env.local / .env 를 직접 읽는다(의존성 없음). 값은 절대 로그에 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(root: string): void {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  let out = text;
  for (const s of new Set([secret, encodeURIComponent(secret)])) out = out.split(s).join('[REDACTED]');
  return out.replace(/serviceKey=[^&\s"']+/gi, 'serviceKey=[REDACTED]');
}
