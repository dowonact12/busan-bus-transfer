// 현장 보정: 문→평소 정류장 실측 5~7분(건물 나가기·신호 포함), 예전 저장값 이관 시 이중 계산 없음, 'n정거장 전' 도우미
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { calibratedSettings, defaultPrefs, DOOR_CALIBRATION, migratePrefs, RULE_OF_THUMB, stopsAwayAtLeave } from '../shared/calibration';
import { evaluateCandidate } from '../shared/evaluator';
import { PREFERRED_BY_TRIP } from '../shared/preferences';
import type { ArrivalBoard, CandidateRoute, Settings } from '../shared/types';
import { at, board, lookupOf, NOW, obs } from './helpers';

const root = path.resolve(import.meta.dirname, '..');
const fwd: CandidateRoute[] = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.generated.json'), 'utf8')).candidates;
const rev: CandidateRoute[] = JSON.parse(fs.readFileSync(path.join(root, 'shared/candidates.reverse.generated.json'), 'utf8')).candidates;
const byId = (list: CandidateRoute[], id: string) => list.find((c) => c.id === id)!;
const firstBoardOnly = (c: CandidateRoute, min: number, extra = {}): ArrivalBoard[] => [
  { ...board(c.legs[0].routeNo, c.legs[0].board.ars, []), observations: [obs(c.legs[0].routeNo, c.legs[0].board.ars, min, { order: 1, ...extra })] },
];
const ev = (c: CandidateRoute, s: Settings, boards: ArrivalBoard[]) => evaluateCandidate(c, { now: NOW, settings: s, lookup: lookupOf(boards) });

describe('기본값', () => {
  it('두 방향 모두 실측 5~7분(가운데 6분), 평소 첫 정류장 13706 / 09198', () => {
    expect(DOOR_CALIBRATION.forward).toMatchObject({ ars: '13706', lowMin: 5, highMin: 7 });
    expect(DOOR_CALIBRATION.reverse).toMatchObject({ ars: '09198', lowMin: 5, highMin: 7 });
    expect(PREFERRED_BY_TRIP.forward.candidateId).toContain('-13706-');
    expect(PREFERRED_BY_TRIP.reverse.candidateId).toContain('-09198-');
    expect(defaultPrefs('forward')).toEqual({ v: 2, doorLowMin: 5, doorHighMin: 7, walkMult: 1 });
  });

  it('보정 설정: 건물 나가기 0, 실측 범위 300/360/420초, 문~큰길 = 실측 − 추정 보행', () => {
    const f = calibratedSettings('forward', defaultPrefs('forward'), fwd);
    expect(f.buildingExitSec).toBe(0);
    expect(f.buildingExitHighSec).toBe(0);
    expect(f.doorToStop).toEqual({ '13706': { lowSec: 300, nominalSec: 360, highSec: 420 } });
    expect(f.doorOverheadSec).toBe(360 - 126); // 13706 직선 116m → 126초 추정
    const r = calibratedSettings('reverse', defaultPrefs('reverse'), rev);
    expect(r.doorToStop).toEqual({ '09198': { lowSec: 300, nominalSec: 360, highSec: 420 } });
    expect(r.doorOverheadSec).toBe(360 - 249); // 09198 직선 230m → 249초 추정
  });
});

describe('평가기: 실측 첫 보행', () => {
  for (const [trip, list] of [['forward', fwd], ['reverse', rev]] as const) {
    it(`${trip}: 평소 경로 — 준비 시각 = 지금 + 6분, 출발 마감 = 첫 버스 이른 시각 − (7분 + 승차 여유 1분)`, () => {
      const s = calibratedSettings(trip, defaultPrefs(trip), list);
      const c = byId(list, PREFERRED_BY_TRIP[trip].candidateId);
      const e = ev(c, s, firstBoardOnly(c, 15));
      expect(e.firstWalkEstimate).toEqual({ lowSec: 300, nominalSec: 360, highSec: 420, measured: true });
      expect(e.firstReadyAt).toBe(NOW + 360);
      expect(e.recommendedLeaveAt).toBe(at(15) - s.realtimeRangeSec - 420 - 60); // 버스 9분 전(예측 기준)에 출발
      expect(e.evidence.some((x) => x.segment === 'first_walk' && x.evidenceKind === 'user_measured')).toBe(true);
    });
  }

  it('걷기 속도 설정은 실측 보행엔 적용 안 됨(실측이 이미 본인 속도)', () => {
    const c = byId(fwd, PREFERRED_BY_TRIP.forward.candidateId);
    const slow = calibratedSettings('forward', { ...defaultPrefs('forward'), walkMult: 1.25 }, fwd);
    expect(ev(c, slow, firstBoardOnly(c, 15)).firstReadyAt).toBe(NOW + 360);
  });

  it('실측 안 된 정류장(연산역 13051): 추정 보행 + 문~큰길 234초, 늦을 때 = 추정×1.25 + 234 + 60', () => {
    const s = calibratedSettings('forward', defaultPrefs('forward'), fwd);
    const c = fwd.find((x) => x.legs[0].board.ars === '13051')!;
    const e = ev(c, s, firstBoardOnly(c, 20));
    expect(e.firstWalkEstimate).toEqual({ lowSec: 408 + 234 - 60, nominalSec: 408 + 234, highSec: Math.round(408 * 1.25) + 234 + 60, measured: false });
    expect(e.firstReadyAt).toBe(NOW + 408 + 234);
  });
});

describe('예전 저장값 이관 — 이중 계산 없음', () => {
  it('v1 {exitMin:2, walkMult} → v2: exitMin 버리고 실측 5~7분, 걷기 속도는 유지', () => {
    expect(migratePrefs({ exitMin: 2, walkMult: 0.85 }, 'reverse')).toEqual({ v: 2, doorLowMin: 5, doorHighMin: 7, walkMult: 0.85 });
    expect(migratePrefs({ exitMin: 5, walkMult: 3 }, 'forward')).toEqual({ v: 2, doorLowMin: 5, doorHighMin: 7, walkMult: 1 });
    expect(migratePrefs(null, 'forward')).toEqual(defaultPrefs('forward'));
    expect(migratePrefs('garbage', 'forward')).toEqual(defaultPrefs('forward'));
  });

  it('이관 후 평소 경로 준비 시간은 6분(예전 2분 + 추정 4분/2분이 더해지지 않음)', () => {
    for (const [trip, list] of [['forward', fwd], ['reverse', rev]] as const) {
      const migrated = migratePrefs({ exitMin: 2, walkMult: 1 }, trip);
      const s = calibratedSettings(trip, migrated, list);
      const c = byId(list, PREFERRED_BY_TRIP[trip].candidateId);
      const e = ev(c, s, firstBoardOnly(c, 15));
      expect(e.firstReadyAt! - NOW).toBe(360);
      expect(e.firstReadyAt! - NOW).not.toBe(120 + 360);
      expect(e.firstReadyAt! - NOW).not.toBe(120 + c.firstWalk.sec);
      expect(s.buildingExitSec).toBe(0);
    }
  });

  it('v2 범위 편집은 유지, 뒤바뀐 범위는 정렬, 범위 밖은 1~30분으로 자름', () => {
    expect(migratePrefs({ v: 2, doorLowMin: 4, doorHighMin: 8, walkMult: 1 }, 'forward')).toEqual({ v: 2, doorLowMin: 4, doorHighMin: 8, walkMult: 1 });
    expect(migratePrefs({ v: 2, doorLowMin: 9, doorHighMin: 6, walkMult: 1 }, 'forward')).toMatchObject({ doorLowMin: 6, doorHighMin: 9 });
    expect(migratePrefs({ v: 2, doorLowMin: 0, doorHighMin: 99, walkMult: 1 }, 'forward')).toMatchObject({ doorLowMin: 1, doorHighMin: 30 });
    const s = calibratedSettings('forward', { v: 2, doorLowMin: 4, doorHighMin: 8, walkMult: 1 }, fwd);
    expect(s.doorToStop!['13706']).toEqual({ lowSec: 240, nominalSec: 360, highSec: 480 });
  });
});

describe("'n정거장 전일 때 나가면 돼요'", () => {
  it('남은 정거장·분 비율로 출발 시각의 정거장 수 어림', () => {
    // 12정거장 전, 15분 뒤 도착 → 출발 마감(도착 9분 전)엔 약 7정거장 전
    expect(stopsAwayAtLeave({ remainingStops: 12, etaAt: at(15) }, at(6), NOW)).toEqual({ now: 12, atLeave: 7 });
    expect(stopsAwayAtLeave({ remainingStops: 8, etaAt: at(10) }, NOW - 30, NOW)).toEqual({ now: 8, atLeave: 8 });
    expect(stopsAwayAtLeave({ remainingStops: null, etaAt: at(10) }, at(1), NOW)).toBeNull();
    expect(stopsAwayAtLeave(null, at(1), NOW)).toBeNull();
  });

  it('본인 규칙(갈 때 43번 8정거장 전)과 모델: 8정거장≈10분이면 지금 나가라고 하고 정류장엔 버스 3분 전 도착', () => {
    expect(RULE_OF_THUMB.reverse).toMatchObject({ routeNo: '43', ars: '09198', stopsBefore: 8 });
    const s = calibratedSettings('reverse', defaultPrefs('reverse'), rev);
    const c = byId(rev, PREFERRED_BY_TRIP.reverse.candidateId);
    const e = ev(c, s, firstBoardOnly(c, 10, { remainingStops: 8 }));
    expect(e.recommendedLeaveAt).toBe(at(10) - 60 - 420 - 60); // = 지금 + 1분
    const sa = stopsAwayAtLeave(e.firstVehicle, e.recommendedLeaveAt!, NOW)!;
    expect(sa.atLeave).toBe(7);
    expect(at(10) - (e.recommendedLeaveAt! + 360)).toBe(180); // 가운데 값이면 버스 3분 전 도착
  });
});
