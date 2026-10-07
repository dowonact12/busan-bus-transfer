// 8정거장 규칙 점검용: (정류장, 노선) 도착 예측의 남은 정류장 수 ↔ 분 기록 (키는 출력하지 않음)
import fs from 'node:fs';
import { loadEnv } from '../server/env';
import { BimsClient } from '../server/bimsClient';
const root = new URL('..', import.meta.url).pathname;
loadEnv(root);
const c = new BimsClient(process.env.BUSAN_BIMS_SERVICE_KEY);
const map = JSON.parse(fs.readFileSync(root + 'data/bstopid-map.json', 'utf8'));
const pairs = [['09198', '43'], ['13706', '29'], ['06707', '29'], ['06712', '43']];
const rounds = Number(process.argv[2] ?? 10), gap = Number(process.argv[3] ?? 30);
const out: unknown[] = [];
for (let i = 0; i < rounds; i++) {
  const t = Math.floor(Date.now() / 1000);
  for (const [ars, route] of pairs) {
    const r = await c.call('stopArrByBstopid', { bstopid: map[ars].bstopid });
    const it = r.items.find((x) => x.lineno === route);
    const row = { t, kst: new Date((t + 9 * 3600) * 1000).toISOString().slice(11, 19), ars, route, ok: r.ok, car1: it?.carno1, min1: it?.min1, st1: it?.station1, car2: it?.carno2, min2: it?.min2, st2: it?.station2 };
    out.push(row);
    console.log(JSON.stringify(row));
  }
  if (i < rounds - 1) await new Promise((r) => setTimeout(r, gap * 1000));
}
fs.writeFileSync(root + `data/samples/stops-eta-probe_${Math.floor(Date.now() / 1000)}.json`, JSON.stringify(out, null, 1));
