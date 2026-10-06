// 공급자(부산 BIMS) 응답 → 내부 모델 정규화. 분 → 초 변환은 여기서 한 번만 한다.
import type { ArrivalObservation, DataOrigin, ObservationStatus, SeatInfo, Sec } from './types';

export const MINUTE = 60;
/** 관측 유효기간(표시 정책의 최대 신선도와 동일) */
export const OBS_EXPIRY_SEC = 120;

/** BIMS min1/min2: 숫자 문자열(분) 또는 '운행대기' 같은 상태 문자열 */
export function parseMinutes(raw: unknown, fetchedAt: Sec): { etaAt: Sec | null; status: ObservationStatus; raw: string } {
  const s = raw == null ? '' : String(raw).trim();
  if (/^\d+$/.test(s)) return { etaAt: fetchedAt + Number(s) * MINUTE, status: 'predicted', raw: s };
  if (s.includes('운행대기') || s.includes('대기')) return { etaAt: null, status: 'waiting', raw: s };
  return { etaAt: null, status: 'unknown', raw: s };
}

/** seat1/seat2: -1·null·빈값·비숫자 = 확인 불가. 0 = 공급자 정의상 빈 좌석 없음. 양수 = 잔여좌석 */
export function parseSeat(raw: unknown): SeatInfo {
  if (raw === null || raw === undefined) return { kind: 'unknown', reason: '미제공' };
  const s = String(raw).trim();
  if (s === '') return { kind: 'unknown', reason: '미제공' };
  if (!/^-?\d+$/.test(s)) return { kind: 'unknown', reason: '해석 불가 값' };
  const n = Number(s);
  if (n < 0) return { kind: 'unknown', reason: '공급자 미제공 코드' };
  return { kind: 'count', count: n };
}

export function seatLabel(seat: SeatInfo): string {
  if (seat.kind === 'unknown') return '잔여좌석 확인 불가';
  if (seat.count === 0) return '현재 제공 잔여좌석 0석 (빈 좌석 없음 · 만차 여부는 알 수 없음)';
  return `현재 제공 잔여좌석 ${seat.count}석`;
}

const intOrNull = (v: unknown): number | null => {
  const s = v == null ? '' : String(v).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
};
const strOrNull = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' ? null : s;
};

/** 대소문자 무관 필드 접근 (문서·실제 응답 표기 차이 대비) */
function pick(item: Record<string, unknown>, name: string): unknown {
  if (name in item) return item[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(item)) if (k.toLowerCase() === lower) return item[k];
  return undefined;
}

/**
 * stopArrByBstopid / busStopArrByBstopidLineid 응답 item 하나 → 관측 최대 2개.
 * 필드명은 공식 상세기능 표 기준(min1/min2, carno1/carno2, seat1/seat2, station1/station2, lineno, lineid).
 * 실제 키 발급 후 샘플로 재검증 필요.
 */
export function normalizeBimsArrivalItem(
  item: Record<string, unknown>,
  ctx: { stopArs: string; fetchedAt: Sec; origin: DataOrigin },
): ArrivalObservation[] {
  const routeNo = strOrNull(pick(item, 'lineno')) ?? strOrNull(pick(item, 'lineNo')) ?? '';
  const lineId = strOrNull(pick(item, 'lineid'));
  const out: ArrivalObservation[] = [];
  for (const n of [1, 2] as const) {
    const minRaw = pick(item, `min${n}`);
    if (minRaw === undefined) continue;
    const m = parseMinutes(minRaw, ctx.fetchedAt);
    out.push({
      routeNo,
      lineId,
      direction: null,
      serviceVariant: null,
      stopArs: ctx.stopArs,
      vehicleReference: strOrNull(pick(item, `carno${n}`)),
      vehicleMatchStatus: 'unmatched',
      providerObservedAt: null, // 공급자 관측시각 미제공 → 수신시각 기준 근사
      fetchedAt: ctx.fetchedAt,
      etaAt: m.etaAt,
      rawArrivalState: m.raw,
      remainingStops: intOrNull(pick(item, `station${n}`)),
      seats: parseSeat(pick(item, `seat${n}`)),
      observationStatus: m.status,
      expiryAt: ctx.fetchedAt + OBS_EXPIRY_SEC,
      origin: ctx.origin,
      order: n,
    });
  }
  return out;
}

/** 아주 단순한 XML <item> 파서 (평평한 자식 태그만). 외부 의존성 없이 BIMS XML 처리 */
export function parseXmlItems(xml: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const obj: Record<string, string> = {};
    const tre = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let t: RegExpExecArray | null;
    while ((t = tre.exec(m[1]))) obj[t[1]] = decodeXml(t[2].trim());
    items.push(obj);
  }
  return items;
}

export function parseXmlHeader(xml: string): { resultCode: string | null; resultMsg: string | null } {
  const code = /<resultCode>([^<]*)<\/resultCode>/.exec(xml)?.[1] ?? /<returnReasonCode>([^<]*)<\/returnReasonCode>/.exec(xml)?.[1] ?? null;
  const msg = /<resultMsg>([^<]*)<\/resultMsg>/.exec(xml)?.[1] ?? /<returnAuthMsg>([^<]*)<\/returnAuthMsg>/.exec(xml)?.[1] ?? null;
  return { resultCode: code, resultMsg: msg };
}

function decodeXml(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
