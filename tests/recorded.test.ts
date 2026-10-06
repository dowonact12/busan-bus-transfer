// 실제 BIMS 응답(2026-10-06 녹화, 키 제거) 기반 검증 — 실시간 시각 자체를 단정하는 테스트가 아님
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBimsArrivalItem, parseXmlItems } from '../shared/normalizer';
import { matchDownstreamVehicle } from '../shared/vehicle';

const dir = path.resolve(import.meta.dirname, '../data/samples');
const load = (prefix: string) => {
  const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix))!;
  const fetchedAt = Number(/_(\d+)\.xml$/.exec(f)![1]);
  return { items: parseXmlItems(fs.readFileSync(path.join(dir, f), 'utf8')), fetchedAt };
};

describe('녹화된 실제 응답', () => {
  it('정류소 응답 필드(min/station/carno/seat/lineid/bstopidx)를 파싱, 좌석 -1은 확인 불가', () => {
    const { items, fetchedAt } = load('stopArrByBstopid_13051_');
    const it36 = items.find((i) => i.lineno === '36')!;
    expect(it36.bstopidx).toBe('75'); // 공식 다운로드 36번 정류소순번 75(연산역 13051)와 일치
    const o = normalizeBimsArrivalItem(it36, { stopArs: '13051', fetchedAt, origin: 'recorded' });
    expect(o.length).toBe(2);
    expect(o[0].etaAt! - fetchedAt).toBe(Number(it36.min1) * 60);
    expect(o[0].seats.kind).toBe('unknown');
    expect(o[0].vehicleReference).toMatch(/^\d{4}$/);
  });
  it('36번 같은 차량이 하류 동래한전(06706)에서 남은 정류장 정황 일치(8정거장)', () => {
    const a = load('stopArrByBstopid_13051_');
    const b = load('stopArrByBstopid_06706_');
    const atBoard = normalizeBimsArrivalItem(a.items.find((i) => i.lineno === '36')!, { stopArs: '13051', fetchedAt: a.fetchedAt, origin: 'recorded' })[0];
    const down = normalizeBimsArrivalItem(b.items.find((i) => i.lineno === '36')!, { stopArs: '06706', fetchedAt: b.fetchedAt, origin: 'recorded' });
    const m = matchDownstreamVehicle(atBoard, down, 8);
    expect(m.status).toBe('consistent');
    expect(m.match!.etaAt!).toBeGreaterThan(atBoard.etaAt!);
  });
});
