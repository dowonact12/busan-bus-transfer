// 도착 정보 '빈칸' 진단: BIMS 도착(2대) vs GPS 노선 위치(전체) vs 우리 Vercel 스냅샷. 키는 출력하지 않음.
import fs from 'node:fs';
import { loadEnv } from '../server/env';
import { BimsClient } from '../server/bimsClient';
const root = new URL('..', import.meta.url).pathname;
loadEnv(root);
const c = new BimsClient(process.env.BUSAN_BIMS_SERVICE_KEY);
const map = JSON.parse(fs.readFileSync(root + 'data/bstopid-map.json', 'utf8'));
const targets = [
  { ars: '06712', route: '43', trip: 'forward' },
  { ars: '06707', route: '29', trip: 'reverse' },
  { ars: '13706', route: '29', trip: 'forward' },
  { ars: '09198', route: '43', trip: 'reverse' },
];
const rounds = Number(process.argv[2] ?? 12), gap = Number(process.argv[3] ?? 30);
const API = 'https://busan-bus-transfer.vercel.app';
const lineIds: Record<string, string> = {};
const rows: unknown[] = [];
const kst = (t: number) => new Date((t + 9 * 3600) * 1000).toISOString().slice(11, 19);
for (let i = 0; i < rounds; i++) {
  const t = Math.floor(Date.now() / 1000);
  const snaps: Record<string, any> = {};
  for (const trip of ['forward', 'reverse']) {
    try { snaps[trip] = await (await fetch(`${API}/api/snapshot?trip=${trip}`)).json(); } catch (e) { snaps[trip] = { error: String(e) }; }
  }
  const routeCache: Record<string, Record<string, string>[]> = {};
  for (const tg of targets) {
    const a = await c.call('stopArrByBstopid', { bstopid: map[tg.ars].bstopid });
    const it = a.items.find((x) => x.lineno === tg.route);
    if (it?.lineid) lineIds[tg.route] = it.lineid;
    const lineid = lineIds[tg.route];
    const b = lineid ? await c.call('busStopArrByBstopidLineid', { bstopid: map[tg.ars].bstopid, lineid }) : null;
    if (!routeCache[tg.route] && lineid) routeCache[tg.route] = (await c.call('busInfoByRouteId', { lineid, numOfRows: '400' })).items;
    const stops = routeCache[tg.route] ?? [];
    const tIdx = Number(stops.find((s) => s.arsno === tg.ars)?.bstopidx ?? NaN);
    const turn = stops.find((s) => s.rpoint === '1');
    const veh = stops.filter((s) => s.carno).map((s) => ({ car: s.carno.slice(-4), idx: Number(s.bstopidx), gps: s.gpsym }));
    const upstream = veh.filter((v) => v.idx <= tIdx).map((v) => ({ ...v, left: tIdx - v.idx })).sort((x, y) => x.left - y.left);
    const snapB = (snaps[tg.trip]?.boards ?? []).find((x: any) => x.stopArs === tg.ars && x.routeNo === tg.route);
    const row = {
      t, kst: kst(t), ...tg, tIdx, routeLen: stops.length, turnIdx: turn ? Number(turn.bstopidx) : null,
      arrOk: a.ok, arrKeys: i === 0 && it ? Object.keys(it) : undefined,
      arr: it ? { min1: it.min1, st1: it.station1, car1: it.carno1?.slice(-4), min2: it.min2, st2: it.station2, car2: it.carno2?.slice(-4) } : null,
      lineArr: b ? (b.items[0] ? { min1: b.items[0].min1, st1: b.items[0].station1, car1: b.items[0].carno1?.slice(-4), min2: b.items[0].min2, st2: b.items[0].station2, car2: b.items[0].carno2?.slice(-4), n: b.items.length, keys: i === 0 ? Object.keys(b.items[0]) : undefined } : { n: 0, code: b.resultCode }) : null,
      upstream, totalVeh: veh.length,
      ours: snapB ? { status: snapB.status, obs: snapB.observations.map((o: any) => ({ eta: o.etaAt ? Math.round((o.etaAt - snaps[tg.trip].serverTime) / 60) : null, st: o.remainingStops, car: o.vehicleReference?.slice(-4), state: o.rawArrivalState })), fetchedAgo: snaps[tg.trip].serverTime - snapB.fetchedAt, mode: snaps[tg.trip].mode } : null,
    };
    rows.push(row);
    console.log(JSON.stringify({ kst: row.kst, ars: tg.ars, r: tg.route, arr: row.arr, line: row.lineArr && { st1: (row.lineArr as any).st1, st2: (row.lineArr as any).st2 }, up: upstream.slice(0, 6).map((u) => `${u.car}:${u.left}`).join(' '), ours: row.ours?.obs.map((o: any) => `${o.car}:${o.st}/${o.eta}m`).join(' ') }));
  }
  fs.writeFileSync(root + `data/samples/snap_${t}.json`, JSON.stringify(snaps));
  if (i < rounds - 1) await new Promise((r) => setTimeout(r, gap * 1000));
}
fs.writeFileSync(root + `data/samples/arrival-gap_${Math.floor(Date.now() / 1000)}.json`, JSON.stringify(rows, null, 1));
console.log('done');
