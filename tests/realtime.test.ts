import { describe, expect, it } from 'vitest';
import { RealtimeService, type BimsLike } from '../server/realtime';
import type { BimsResult } from '../server/bimsClient';
import { transferCand, directCand, NOW } from './helpers';
import { redact } from '../server/env';

function fakeClient(behaviour: (op: string, p: Record<string, string>) => Partial<BimsResult>) {
  const calls: { op: string; p: Record<string, string> }[] = [];
  const c: BimsLike & { calls: typeof calls } = {
    calls,
    hasKey: () => true,
    async call(op, p) {
      calls.push({ op, p });
      return { ok: true, resultCode: '00', resultMsg: 'OK', items: [], httpStatus: 200, rawRedacted: '', ...behaviour(op, p) } as BimsResult;
    },
  };
  return c;
}

const cands = [
  directCand({ id: 'D', r: '36', firstWalkMin: 5, rideMin: 20, finalWalkMin: 3 }),
  transferCand({ id: 'T1', r1: '36', r2: '43', firstWalkMin: 5, ride1Min: 10, transferWalkMin: 1, ride2Min: 5, finalWalkMin: 3 }),
  transferCand({ id: 'T2', r1: '29', r2: '43', firstWalkMin: 2, ride1Min: 10, transferWalkMin: 1, ride2Min: 5, finalWalkMin: 3 }),
];
const bstopMap = { O1: { bstopid: '1' }, T1: { bstopid: '2' }, D1: { bstopid: '3' } };

describe('T16 비용·갱신', () => {
  it('30초 간격 반복 갱신: 후보(길찾기)는 한 번만, 공유 정류소 조회는 합침, TTL 안에서는 재호출 없음', async () => {
    let t = NOW;
    const client = fakeClient((op, p) => ({ items: (op === "stopArrByBstopid" ? [{ lineno: "36", min1: "5", bstopidx: "75" }, { lineno: "43", min1: "9" }, { lineno: "29", min1: "3" }] : []) as Record<string, string>[] }));
    let routeCalls = 0;
    const rt = new RealtimeService({ client, bstopMap, routeProvider: () => { routeCalls++; return cands; }, now: () => t, ttlSec: 30 });
    await Promise.all([rt.snapshot(), rt.snapshot()]); // 동시 요청도 합침
    const arrCalls = () => client.calls.filter((c) => c.op === 'stopArrByBstopid').length;
    expect(arrCalls()).toBe(2); // 고유 정류소 O1, T1 각 1회 (3개 후보 × 여러 노선이어도)
    t += 10; await rt.snapshot();
    expect(arrCalls()).toBe(2); // TTL 안
    t += 25; await rt.snapshot();
    expect(arrCalls()).toBe(4); // TTL 지난 뒤 정류소당 1회
    expect(routeCalls).toBe(1);
  });
  it('일일 한도 초과 시 계속 재시도하지 않음', async () => {
    let t = NOW;
    const client = fakeClient((op) => (op === 'stopArrByBstopid' ? { ok: false, resultCode: '22', errorKind: 'rate_limited_daily' } : {}));
    const rt = new RealtimeService({ client, bstopMap, routeProvider: () => cands, now: () => t, ttlSec: 30 });
    const s1 = await rt.snapshot();
    const n = client.calls.filter((c) => c.op === 'stopArrByBstopid').length;
    for (let i = 0; i < 5; i++) { t += 30; await rt.snapshot(); }
    expect(client.calls.filter((c) => c.op === 'stopArrByBstopid').length).toBe(n);
    expect(s1.providerStatus).toBe('rate_limited');
  });
  it('일시 오류는 지수 백오프', async () => {
    let t = NOW;
    const client = fakeClient((op) => (op === 'stopArrByBstopid' ? { ok: false, httpStatus: 0, errorKind: 'timeout' } : {}));
    const rt = new RealtimeService({ client, bstopMap: { O1: { bstopid: '1' } }, routeProvider: () => [cands[0]], now: () => t, ttlSec: 30 });
    await rt.snapshot(); t += 20; await rt.snapshot();
    expect(client.calls.filter((c) => c.op === 'stopArrByBstopid').length).toBe(1);
    t += 15; await rt.snapshot();
    expect(client.calls.filter((c) => c.op === 'stopArrByBstopid').length).toBe(2);
  });
  it('키 없으면 예시 모드(origin=sample)로 명시', async () => {
    const rt = new RealtimeService({ client: null, bstopMap, routeProvider: () => cands, now: () => NOW });
    const s = await rt.snapshot();
    expect(s.mode).toBe('sample');
    expect(s.boards.every((b) => b.origin === 'sample')).toBe(true);
  });
  it('로그·오류 문자열에서 키 제거', () => {
    expect(redact('http://x?serviceKey=abc%2Bdef&a=1 abc+def', 'abc+def')).not.toMatch(/abc/);
  });
});
