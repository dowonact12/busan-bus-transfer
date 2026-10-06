// 오는 길(반여로 67 → 중앙대로 1067) 후보: 공식 노선-정류소 자료 + 실시간 대조 기록으로 검증
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CandidatesPayload, RouteStop } from '../shared/api';
import { recommend } from '../shared/recommender';
import { sampleBoards } from '../shared/sample';
import { DEFAULT_SETTINGS } from '../shared/types';
import { RealtimeService, type BimsLike } from '../server/realtime';
import type { BimsResult } from '../server/bimsClient';

const root = path.resolve(import.meta.dirname, '..');
type Gen = CandidatesPayload & { trip: string; routeStops: Record<string, RouteStop[]> };
const rev: Gen = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.reverse.generated.json'), 'utf8'));
const fwd: Gen = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.generated.json'), 'utf8'));
const bmap: Record<string, { bstopid: string | null; verified?: boolean }> = JSON.parse(fs.readFileSync(path.join(root, 'data/bstopid-map.json'), 'utf8'));

// 공식 다운로드(노선별 정류소순번) — route,seq,...,ars
const official = new Map<string, number[]>();
for (const line of fs.readFileSync(path.join(root, 'data/raw/route_stops.csv'), 'utf8').trim().split('\n').slice(1)) {
  const f = line.split(',');
  const k = `${f[0]}|${f[9]}`;
  official.set(k, [...(official.get(k) ?? []), Number(f[1])]);
}
const pairs = (g: Gen) => g.candidates.flatMap((c) => c.legs.flatMap((l) => [
  { route: l.routeNo, ars: l.board.ars, seq: l.board.routeStopSequence!, role: 'board' },
  { route: l.routeNo, ars: l.alight.ars, seq: l.alight.routeStopSequence!, role: 'alight' },
]));

// 저장된 실시간 응답(키 제거본)에서 (정류소, 노선) → bstopidx
function liveIdx(ars: string, route: string): number | null {
  const files = fs.readdirSync(path.join(root, 'data/samples')).filter((f) => f.startsWith(`stopArrByBstopid_${ars}_`)).sort().reverse();
  for (const f of files) {
    const xml = fs.readFileSync(path.join(root, 'data/samples', f), 'utf8');
    for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
      if (it.match(/<lineno>(.*?)<\/lineno>/)?.[1] === route) return Number(it.match(/<bstopidx>(\d+)<\/bstopidx>/)?.[1] ?? NaN);
    }
  }
  return null;
}

describe('오는 길 후보 매핑', () => {
  it('방향·라벨: 출발 반여로 67, 도착 중앙대로 1067 (도착지에 3층 이동 없음)', () => {
    expect(rev.trip).toBe('reverse');
    expect(rev.origin.label).toBe('반여로 67');
    expect(rev.destination.label).toBe('중앙대로 1067');
    expect(rev.destination.label).not.toMatch(/3층/);
    expect(rev.origin.lat).toBeCloseTo(fwd.destination.lat, 4);
    expect(rev.destination.lon).toBeCloseTo(fwd.origin.lon, 4);
  });

  it('직통과 1회 환승 모두 있고, 문서 5장 노선의 반대 방향(36 직통, 43→36, 43→29)이 들어 있다', () => {
    const sigs = new Set(rev.candidates.map((c) => c.routes.join('>')));
    expect(rev.candidates.some((c) => c.kind === 'direct')).toBe(true);
    expect(rev.candidates.some((c) => c.kind === 'transfer')).toBe(true);
    for (const s of ['36', '43>36', '43>29']) expect(sigs.has(s)).toBe(true);
    expect(rev.candidates.every((c) => c.legs.length === (c.kind === 'direct' ? 1 : 2))).toBe(true);
  });

  it('모든 구간은 공식 순번상 승차 < 하차이고, 순번이 공식 자료·노선 정류소 목록과 일치', () => {
    for (const c of rev.candidates) for (const l of c.legs) {
      const b = l.board.routeStopSequence!, a = l.alight.routeStopSequence!;
      expect(b, c.id).toBeLessThan(a);
      expect(official.get(`${l.routeNo}|${l.board.ars}`), `${c.id} board`).toContain(b);
      expect(official.get(`${l.routeNo}|${l.alight.ars}`), `${c.id} alight`).toContain(a);
      const rs = rev.routeStops[l.routeNo];
      expect(rs.find((s) => s.seq === b)?.ars).toBe(l.board.ars);
      expect(rs.find((s) => s.seq === a)?.ars).toBe(l.alight.ars);
      expect(l.ride.hops).toBe(a - b);
    }
  });

  it('반대 방향 정류장을 쓴다: 43은 한화꿈에그린 09198(동래 방면)에서 타고, 가는 길 하차 정류장(09199·09273)에서 타지 않는다', () => {
    const boards43 = new Set(rev.candidates.flatMap((c) => c.legs.filter((l) => l.routeNo === '43').map((l) => l.board.ars)));
    expect([...boards43]).toEqual(['09198']);
    const fwdAlights = new Set(fwd.candidates.map((c) => c.legs.at(-1)!.alight.ars));
    for (const c of rev.candidates) expect(fwdAlights.has(c.legs[0].board.ars), c.id).toBe(false);
    // 36 직통은 연산역(13151) 방면으로 내려간다
    for (const c of rev.candidates.filter((x) => x.kind === 'direct' && x.routes[0] === '36')) expect(c.legs[0].alight.ars).toBe('13151');
  });

  it('모든 정류장 ARS가 실시간 bstopid로 매핑·확인돼 있다', () => {
    for (const p of pairs(rev)) {
      expect(bmap[p.ars]?.bstopid, p.ars).toMatch(/^\d{9}$/);
      expect(bmap[p.ars]?.verified, p.ars).toBe(true);
    }
  });

  it('실시간 응답 기록의 bstopidx가 공식 순번과 같다 (심야 노선처럼 기록 없는 쌍만 예외)', () => {
    const uniq = new Map(pairs(rev).map((p) => [`${p.ars}|${p.route}`, p]));
    let checked = 0;
    const missing: string[] = [];
    for (const p of uniq.values()) {
      const idx = liveIdx(p.ars, p.route);
      if (idx == null) { missing.push(`${p.route}@${p.ars}`); continue; }
      expect(idx, `${p.route}@${p.ars}`).toBe(p.seq);
      checked++;
    }
    expect(missing.every((m) => m.startsWith('106(심야)'))).toBe(true);
    expect(checked).toBeGreaterThanOrEqual(uniq.size - 3);
  });

  it('후보 ID가 가는 길과 겹치지 않는다', () => {
    const f = new Set(fwd.candidates.map((c) => c.id));
    for (const c of rev.candidates) expect(f.has(c.id)).toBe(false);
  });

  it('추천기가 오는 길 후보로도 동작하고 출발 건물 나가는 시간(기본 2분)을 반영한다', () => {
    const now = 1_790_000_000;
    const ps = rev.candidates.flatMap((c) => [{ ars: c.legs[0].board.ars, routeNo: c.legs[0].routeNo }, ...(c.legs[1] ? [{ ars: c.legs[1].board.ars, routeNo: c.legs[1].routeNo }] : [])]);
    const boards = sampleBoards(ps, now);
    const lookup = (a: string, r: string) => boards.find((b) => b.stopArs === a && b.routeNo === r);
    const r2 = recommend(rev.candidates, { now, settings: { ...DEFAULT_SETTINGS, buildingExitSec: 120, buildingExitHighSec: 180 }, lookup, journey: { phase: 'before' } });
    const r5 = recommend(rev.candidates, { now, settings: { ...DEFAULT_SETTINGS, buildingExitSec: 300, buildingExitHighSec: 360 }, lookup, journey: { phase: 'before' } });
    expect(r2.all.length).toBe(rev.candidates.length);
    const e2 = r2.all.find((e) => e.firstReadyAt != null)!;
    const e5 = r5.all.find((e) => e.candidateId === e2.candidateId)!;
    expect(e5.firstReadyAt! - e2.firstReadyAt!).toBe(180);
  });
});

describe('서버: 방향별 스냅샷은 그 방향 정류장만 조회', () => {
  it('오는 길 스냅샷은 가는 길 정류장을 부르지 않는다', async () => {
    const calls: string[] = [];
    const client: BimsLike = { hasKey: () => true, async call(op, p) { if (op === 'stopArrByBstopid') calls.push(p.bstopid); return { ok: true, resultCode: '00', resultMsg: 'OK', items: [], httpStatus: 200, rawRedacted: '' } as BimsResult; } };
    const all = [...fwd.candidates, ...rev.candidates];
    const rt = new RealtimeService({ client, bstopMap: bmap, routeProvider: () => all, now: () => 1_790_000_000 });
    const snap = await rt.snapshot(rev.candidates);
    const revStops = new Set(rev.candidates.flatMap((c) => [c.legs[0].board.ars, ...(c.legs[1] ? [c.legs[0].alight.ars, c.legs[1].board.ars] : [])]));
    expect(new Set(snap.boards.map((b) => b.stopArs))).toEqual(revStops);
    expect(calls.length).toBe(revStops.size);
    expect(calls).not.toContain(bmap['13051'].bstopid); // 가는 길 36 승차(연산역 방면) 정류장
  });
});
