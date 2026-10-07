// probe-arrival-gap 결과 분석: BIMS 목록 범위 + 우리 평가(평소 경로) 전/후(위치 기반 추정) 비교
import fs from 'node:fs';
import type { RouteVehicles } from '../shared/api';
import { calibratedSettings, defaultPrefs } from '../shared/calibration';
import { evaluateCandidate } from '../shared/evaluator';
import { augmentBoards } from '../shared/positionEta';
import { DEFAULT_SETTINGS } from '../shared/types';
const root = new URL('..', import.meta.url).pathname;
const dir = root + 'data/samples/';
const rowsFile = fs.readdirSync(dir).filter((f) => f.startsWith('arrival-gap_')).sort().pop()!;
const rows: any[] = JSON.parse(fs.readFileSync(dir + rowsFile, 'utf8'));
const gens: Record<string, any> = { forward: JSON.parse(fs.readFileSync(root + 'shared/candidates.generated.json', 'utf8')), reverse: JSON.parse(fs.readFileSync(root + 'shared/candidates.reverse.generated.json', 'utf8')) };
const PIN: Record<string, string> = { forward: 'T-29-13706-06712-43-06712-09199', reverse: 'T-43-09198-06707-29-06707-13707' };

// 1) BIMS 목록 범위
const stat: Record<string, { n: number; listed: number[]; upstream: number[]; maxListedStops: number[]; unlistedNearer: number; listedMatchesNearest: number }> = {};
for (const r of rows) {
  const k = `${r.ars}/${r.route}`;
  const s = (stat[k] ??= { n: 0, listed: [], upstream: [], maxListedStops: [], unlistedNearer: 0, listedMatchesNearest: 0 });
  s.n++;
  const listed = [r.arr?.car1, r.arr?.car2].filter(Boolean);
  s.listed.push(listed.length);
  s.upstream.push(r.upstream.filter((u: any) => u.idx > 1).length);
  const sts = [r.arr?.st1, r.arr?.st2].filter((x) => x != null && /^\d+$/.test(x)).map(Number);
  if (sts.length) s.maxListedStops.push(Math.max(...sts));
  const maxSt = sts.length ? Math.max(...sts) : -1;
  if (r.upstream.some((u: any) => u.idx > 1 && !listed.includes(u.car) && u.left < maxSt)) s.unlistedNearer++;
  const nearest = r.upstream.filter((u: any) => u.idx > 1 && u.left > 0).slice(0, listed.length).map((u: any) => u.car);
  if (nearest.length === listed.length && nearest.every((c: string) => listed.includes(c))) s.listedMatchesNearest++;
}
console.log('== BIMS 도착 목록 vs GPS 상류 차량 (라운드 수 n)');
for (const [k, s] of Object.entries(stat)) {
  const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1);
  console.log(k, `n=${s.n} 목록 차량 최대 ${Math.max(...s.listed)}대(평균 ${avg(s.listed)}) · GPS 상류 평균 ${avg(s.upstream)}대 · 목록 최장 ${Math.max(...s.maxListedStops, 0)}정거장 · 목록=가장 가까운 차 ${s.listedMatchesNearest}/${s.n} · 목록보다 가까운데 빠진 차 ${s.unlistedNearer}회`);
}

// 2) 평소 경로 평가 전/후
const byT = new Map<number, any[]>();
for (const r of rows) byT.set(r.t, [...(byT.get(r.t) ?? []), r]);
const tally: Record<string, Record<string, number>> = {};
for (const [t, rs] of byT) {
  const f = dir + `snap_${t}.json`;
  if (!fs.existsSync(f)) continue;
  const snaps = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 이 라운드의 GPS 상류 차량으로 RouteVehicles 재구성(대상 정류장 상류만)
  const veh: Record<string, Record<string, RouteVehicles>> = { forward: {}, reverse: {} };
  for (const r of rs) {
    const rv: RouteVehicles = { routeNo: r.route, lineId: null, fetchedAt: t, origin: 'live', status: 'ok', turnIdx: r.turnIdx, vehicles: r.upstream.map((u: any) => ({ carno: u.car, stopIdx: u.idx, lat: null, lon: null, gpsAt: null, lowFloor: null })) };
    const prev = veh[r.trip][r.route];
    veh[r.trip][r.route] = prev ? { ...rv, vehicles: [...prev.vehicles, ...rv.vehicles.filter((v) => !prev.vehicles.some((p) => p.carno === v.carno))] } : rv;
  }
  for (const trip of ['forward', 'reverse']) {
    const snap = snaps[trip];
    if (!snap?.boards) continue;
    const cands = gens[trip].candidates;
    const cand = cands.find((c: any) => c.id === PIN[trip]);
    const settings = calibratedSettings(trip as any, defaultPrefs(trip as any), cands, DEFAULT_SETTINGS);
    const now = snap.serverTime;
    // 스냅샷의 차량번호는 전체, 프로브는 끝 4자리 → 비교는 끝 4자리라 그대로 사용
    const lk = (bs: any[]) => (a: string, r: string) => bs.find((b) => b.stopArs === a && b.routeNo === r);
    const before = evaluateCandidate(cand, { now, settings, lookup: lk(snap.boards) });
    const aug = augmentBoards(snap.boards, [cand], veh[trip], now);
    const after = evaluateCandidate(cand, { now, settings, lookup: lk(aug) });
    const T = (tally[trip] ??= {});
    const inc = (k: string) => (T[k] = (T[k] ?? 0) + 1);
    inc('rounds');
    if (!before.firstVehicle) inc('first bus none (before)');
    if (before.firstVehicle && !before.secondVehicle) inc('transfer bus none (before)');
    if (before.destinationEstimate) inc('arrival known (before)');
    if (after.firstVehicle && !after.secondVehicle) inc('transfer bus none (after)');
    if (after.secondVehicle?.estimate) inc('transfer via GPS estimate (after)');
    if (after.destinationEstimate) inc('arrival known (after)');
    T[`feas before:${before.feasibility}`] = (T[`feas before:${before.feasibility}`] ?? 0) + 1;
    T[`feas after:${after.feasibility}`] = (T[`feas after:${after.feasibility}`] ?? 0) + 1;
  }
}
console.log('== 평소 경로(고정 카드) 재평가: 실제 Vercel 스냅샷 기준');
for (const [trip, T] of Object.entries(tally)) console.log(trip, JSON.stringify(T));
