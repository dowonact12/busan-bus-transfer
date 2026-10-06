import { describe, expect, it } from 'vitest';
import { buildSchematic, classifyLegVehicles, gpsAgeText, plate4, zoneText } from '../shared/schematic';
import type { CandidateLeg, CandidateRoute } from '../shared/types';

const NOW = 1_790_000_000;
const stop = (ars: string, seq: number) => ({ ars, name: ars, lat: 35.2, lon: 129.1, routeStopSequence: seq });
const leg = (routeNo: string, b: number, a: number): CandidateLeg => ({ routeNo, board: stop(`B${routeNo}`, b), alight: stop(`A${routeNo}`, a), ride: { pathM: 0, nominalSec: 0, lowSec: 0, highSec: 0, hops: a - b } });
const v = (stopIdx: number, carno: string, gpsAgo: number | null = 20) => ({ stopIdx, carno, lat: 35.2, lon: 129.1, gpsAt: gpsAgo == null ? null : NOW - gpsAgo, lowFloor: null });

describe('3점 도식 차량 배치', () => {
  it('승차 전 n정류장 / 사이 / 지남 구간을 공급자 순번으로만 나눈다', () => {
    const l = leg('43', 16, 22);
    const out = classifyLegVehicles(l, 0, [v(13, '70자1111'), v(16, '70자2222'), v(19, '70자3333'), v(22, '70자4444'), v(23, '70자5555'), v(40, '70자6666'), v(2, '70자7777')], NOW);
    const by = Object.fromEntries(out.map((b) => [b.plate4, b]));
    expect(by['1111'].zone).toBe('before_board'); expect(by['1111'].stopsToBoard).toBe(3);
    expect(by['2222'].zone).toBe('before_board'); expect(by['2222'].stopsToBoard).toBe(0);
    expect(by['3333'].zone).toBe('between'); expect(by['3333'].fraction).toBeCloseTo(0.5);
    expect(by['4444'].zone).toBe('between'); expect(by['4444'].fraction).toBe(1);
    expect(by['5555'].zone).toBe('passed'); expect(by['5555'].stopsPastAlight).toBe(1);
    expect(by['6666']).toBeUndefined(); // 너무 멀리 지난 차량은 표시 안 함
    expect(by['7777']).toBeUndefined(); // 승차 14정류장 전(기본 12 초과)
    expect(out.map((b) => b.stopIdx)).toEqual([23, 22, 19, 16, 13]);
  });

  it('GPS가 5분 넘게 오래되거나 시각이 없으면 stale(흐리게)', () => {
    const out = classifyLegVehicles(leg('36', 59, 72), 0, [v(55, 'a1234', 30), v(56, 'b2345', 301), v(57, 'c3456', null)], NOW);
    expect(out.find((b) => b.plate4 === '1234')!.stale).toBe(false);
    expect(out.find((b) => b.plate4 === '2345')!.stale).toBe(true);
    expect(out.find((b) => b.plate4 === '3456')!.stale).toBe(true);
    expect(gpsAgeText(30)).toBe('GPS 1분 안');
    expect(gpsAgeText(190)).toBe('GPS 3분 전');
    expect(gpsAgeText(null)).toBe('GPS 시각 없음');
  });

  it('환승 경로: 두 번째 노선 차량은 환승 정류장 기준으로 배치하고 문장도 역할 이름을 쓴다', () => {
    const cand: CandidateRoute = { id: 'T', kind: 'transfer', routes: ['43', '36'], legs: [leg('43', 16, 18), leg('36', 62, 72)], firstWalk: { meters: 0, sec: 0 }, finalWalk: { meters: 0, sec: 0 }, staticTotalSec: 0 };
    const out = buildSchematic(cand, { '43': { vehicles: [v(14, '70자4402')] }, '36': { vehicles: [v(60, '71바1234'), v(65, '71바9999')] } }, NOW);
    const t = Object.fromEntries(out.map((b) => [b.plate4, zoneText(b, cand.kind)]));
    expect(t['4402']).toBe('출발 정류장 2정류장 전');
    expect(t['1234']).toBe('환승 정류장 2정류장 전');
    expect(t['9999']).toBe('환승~도착 사이');
    const direct: CandidateRoute = { ...cand, kind: 'direct', routes: ['36'], legs: [leg('36', 59, 72)] };
    expect(buildSchematic(direct, { '36': { vehicles: [v(73, 'x0001')] } }, NOW).map((b) => zoneText(b, 'direct'))).toEqual(['도착 정류장 지남']);
  });

  it('번호판 끝 4자리', () => {
    expect(plate4('70자4402')).toBe('4402');
    expect(plate4('부산70자4402')).toBe('4402');
  });
});
