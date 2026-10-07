// 내 기록 섞기: 3회 미만이면 모델 그대로, 3회 이상이면 중앙값 가중 평균, 버킷(방향·평일/주말·시간대) 분리
import { describe, expect, it } from 'vitest';
import { blend, bucketOf, dayType, durations, learnedDoorToStop, learnedRide, median, parseHistory, upsertRecord, type TripRecord } from '../shared/history';

// 2026-10-07(수) 08:10 KST
const T = Date.UTC(2026, 9, 7, 8 - 9, 10) / 1000;
const day = 86400;
const rec = (i: number, o: Partial<TripRecord> = {}): TripRecord => ({
  id: `r${i}`, trip: 'reverse', candidateId: 'C', routeNo: '43', boardArs: '09198', vehicleRef: '2106',
  leftAt: T - i * 7 * day, atStopAt: T - i * 7 * day + 300, boardedAt: T - i * 7 * day + 480, arrivedAt: T - i * 7 * day + 480 + 1800, ...o,
});

describe('기록 → 구간', () => {
  it('걷기·기다림·탄 뒤 도착까지', () => {
    expect(durations(rec(1))).toEqual({ walkSec: 300, waitSec: 180, doorToBoardSec: 480, rideSec: 1800 });
    expect(durations(rec(1, { atStopAt: null, arrivedAt: null }))).toEqual({ walkSec: null, waitSec: null, doorToBoardSec: 480, rideSec: null });
    expect(durations(rec(1, { atStopAt: T - 7 * day - 10 })).walkSec).toBeNull(); // 음수는 버림
  });
  it('중앙값', () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(3); expect(median([])).toBeNull(); });
});

describe('섞기', () => {
  it('3회 미만이면 모델 그대로(learned=false)', () => {
    expect(blend(360, [300, 300])).toMatchObject({ sec: 360, learned: false, n: 2 });
  });
  it('3회면 50:50, 9회면 75:25, 최대 85%', () => {
    expect(blend(360, [300, 300, 300])).toMatchObject({ sec: 330, learned: true, n: 3, medianSec: 300 });
    expect(blend(360, Array(9).fill(240))).toMatchObject({ sec: 270, n: 9 });
    expect(blend(360, Array(60).fill(240)).sec).toBe(Math.round(0.85 * 240 + 0.15 * 360));
  });
  it('버킷: 같은 방향·평일·같은 시간대만 셈', () => {
    expect(dayType(T)).toBe('weekday');
    expect(bucketOf('reverse', T)).toEqual({ trip: 'reverse', day: 'weekday', hour: 8 });
    const recs = [rec(1), rec(2), rec(3, { leftAt: T - 3 * 7 * day + 3600 })]; // 3번째는 09시
    const m = { lowSec: 300, nominalSec: 360, highSec: 420 };
    expect(learnedDoorToStop(recs, 'reverse', T, '09198', m).blended.learned).toBe(false); // 08시 기록 2개뿐
    const recs3 = [rec(1), rec(2), rec(3), rec(4, { trip: 'forward' }), rec(5, { boardArs: '09272' })];
    const r = learnedDoorToStop(recs3, 'reverse', T, '09198', m);
    expect(r.blended).toMatchObject({ learned: true, n: 3, medianSec: 300, sec: 330 });
    expect(r.range).toEqual({ lowSec: 270, nominalSec: 330, highSec: 390 });
  });
  it('탄 뒤 도착까지(경로별)', () => {
    const recs = [rec(1), rec(2), rec(3, { arrivedAt: T - 21 * day + 480 + 2400 })];
    expect(learnedRide(recs, 'reverse', T, 'C', 2100)).toMatchObject({ learned: true, n: 3, medianSec: 1800, sec: 1950 });
    expect(learnedRide(recs, 'reverse', T, 'OTHER', 2100).learned).toBe(false);
  });
});

describe('저장', () => {
  it('깨진 값은 빈 목록, 같은 id는 갱신', () => {
    expect(parseHistory('nope')).toEqual([]);
    expect(parseHistory(JSON.stringify([{ boardedAt: 1, trip: 'x' }]))).toEqual([]);
    const a = upsertRecord([], rec(1));
    const b = upsertRecord(a, { ...rec(1), arrivedAt: 5 });
    expect(b).toHaveLength(1);
    expect(b[0].arrivedAt).toBe(5);
  });
});
