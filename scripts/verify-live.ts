// Phase A: ARS → bstopid 매핑(좌표·이름 대조) + 실제 도착 조회. 키 제거 샘플 저장.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../server/env';
import { BimsClient } from '../server/bimsClient';
import { normalizeBimsArrivalItem } from '../shared/normalizer';

const root = path.resolve(import.meta.dirname, '..');
loadEnv(root);
const client = new BimsClient(process.env.BUSAN_BIMS_SERVICE_KEY);
const stops = new Map<string, any>();
for (const f of ['shared/candidates.generated.json', 'shared/candidates.reverse.generated.json']) {
  if (!fs.existsSync(path.join(root, f))) continue;
  const gen = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  for (const c of gen.candidates) for (const l of c.legs) for (const s of [l.board, l.alight]) stops.set(s.ars, s);
}
const extra = (process.argv[2] ?? '06173,06708,09271').split(',');
const csv = fs.readFileSync(path.join(root, 'data/raw/route_stops.csv'), 'utf8').split('\n');
for (const a of extra) if (!stops.has(a)) {
  const line = csv.find((l) => l.split(',')[9] === a);
  if (line) { const c = line.split(','); stops.set(a, { ars: a, name: c[2], lon: Number(c[7]), lat: Number(c[8]) }); }
}
const hav = (a: any, b: any) => { const R = 6371000, r = Math.PI / 180; const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const samples = path.join(root, 'data/samples');
const mapPath = path.join(root, 'data/bstopid-map.json');
const map: Record<string, any> = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};
const verifiedAt = new Date().toISOString();
for (const [ars, s] of stops) {
  if (map[ars]?.bstopid) continue;
  const r = await client.call('busStopList', { arsno: ars });
  fs.writeFileSync(path.join(samples, `busStopList_${ars}.xml`), r.rawRedacted);
  const hits = r.items.filter((i) => i.arsno === ars);
  if (hits.length !== 1) { map[ars] = { bstopid: null, reason: `busStopList ${r.resultCode} hits=${hits.length}`, verifiedAt }; console.log(ars, 'NOT MAPPED', r.resultCode, hits.length); continue; }
  const h = hits[0];
  const d = hav(s, { lat: Number(h.gpsy), lon: Number(h.gpsx) });
  const nameOk = h.bstopnm.replace(/\s/g, '') === s.name.replace(/\s/g, '');
  map[ars] = { bstopid: h.bstopid, apiName: h.bstopnm, officialName: s.name, distanceM: Math.round(d), nameMatch: nameOk, verified: d <= 50 && nameOk, verifiedAt, evidence: 'busStopList arsno 단일 일치 + 공식 다운로드 좌표·이름 대조' };
  console.log(ars, h.bstopid, h.bstopnm, Math.round(d) + 'm', nameOk ? 'name=' : 'name≠ ' + s.name);
}
fs.writeFileSync(mapPath, JSON.stringify(map, null, 1));
// 실제 도착
const want = (process.argv[3] ?? '13051,13706,13056,06706,06702,06712').split(',');
for (const ars of want) {
  const m = map[ars];
  if (!m?.bstopid) continue;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const r = await client.call('stopArrByBstopid', { bstopid: m.bstopid });
  fs.writeFileSync(path.join(samples, `stopArrByBstopid_${ars}_${fetchedAt}.xml`), r.rawRedacted);
  console.log(`\n== ${ars} ${m.apiName} (${m.bstopid}) result=${r.resultCode} items=${r.items.length}`);
  if (r.items[0]) console.log('fields:', Object.keys(r.items[0]).join(','));
  for (const it of r.items) {
    const obs = normalizeBimsArrivalItem(it, { stopArs: ars, fetchedAt, origin: 'live' });
    console.log(`  ${it.lineno} lineid=${it.lineid} min1=${it.min1 ?? '-'} st1=${it.station1 ?? '-'} car1=${it.carno1 ?? '-'} seat1=${it.seat1 ?? '-'} | min2=${it.min2 ?? '-'} st2=${it.station2 ?? '-'} car2=${it.carno2 ?? '-'} seat2=${it.seat2 ?? '-'}  → ${obs.map((o) => o.observationStatus + (o.etaAt ? '+' + (o.etaAt - fetchedAt) + 's' : '')).join(', ')}`);
  }
}
console.log('\ncalls:', client.calls, 'base:', client.base.startsWith('https') ? 'https' : 'http');
