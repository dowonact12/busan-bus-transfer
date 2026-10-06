// 부산 BIMS 공공 API 클라이언트 (서버 전용). 키는 process.env.BUSAN_BIMS_SERVICE_KEY 에서만 읽는다.
import { parseXmlHeader, parseXmlItems } from '../shared/normalizer';
import { redact } from './env';

export const BIMS_BASE = 'https://apis.data.go.kr/6260000/BusanBIMS';
export const BIMS_BASE_HTTP = 'http://apis.data.go.kr/6260000/BusanBIMS';
/** 이 박스에서는 apis.data.go.kr HTTPS 핸드셰이크가 실패해 공식 HTTP 엔드포인트로 폴백한다.
 *  HTTP는 키가 평문 전송되므로 BUSAN_BIMS_ALLOW_HTTP_FALLBACK=0 으로 끌 수 있다. */
const allowHttp = () => process.env.BUSAN_BIMS_ALLOW_HTTP_FALLBACK !== '0';

export type KeyForm = 'raw' | 'encoded';
export interface BimsResult {
  ok: boolean;
  resultCode: string | null;
  resultMsg: string | null;
  items: Record<string, string>[];
  httpStatus: number;
  rawRedacted: string;
  errorKind?: 'not_registered' | 'rate_limited_daily' | 'rate_limited_second' | 'http' | 'timeout' | 'other';
}

export class BimsClient {
  private keyForm: KeyForm | null = null;
  base: string = BIMS_BASE;
  private baseLocked = false;
  calls = 0;
  constructor(private key: string | undefined, private fetchImpl: typeof fetch = fetch) {}
  hasKey(): boolean {
    return !!this.key;
  }

  private buildUrl(op: string, params: Record<string, string>, form: KeyForm): string {
    const k = form === 'encoded' ? encodeURIComponent(this.key!) : this.key!;
    const qs = Object.entries(params).map(([a, b]) => `${a}=${encodeURIComponent(b)}`).join('&');
    return `${this.base}/${op}?serviceKey=${k}&${qs}`;
  }

  async call(op: string, params: Record<string, string>): Promise<BimsResult> {
    if (!this.key) throw new Error('no key');
    const forms: KeyForm[] = this.keyForm ? [this.keyForm] : ['encoded', 'raw'];
    let last: BimsResult | null = null;
    for (const form of forms) {
      const usedBase = this.base;
      last = await this.once(op, params, form);
      if (!last.ok && last.httpStatus === 0 && usedBase === BIMS_BASE && !this.baseLocked && allowHttp()) {
        this.base = BIMS_BASE_HTTP; // TLS 실패 → 공식 HTTP 엔드포인트 재시도
      }
      if (!last.ok && last.httpStatus === 0 && usedBase !== this.base) last = await this.once(op, params, form);
      if (last.httpStatus !== 0) this.baseLocked = true;
      if (last.errorKind !== 'not_registered') {
        if (last.ok) this.keyForm = form;
        return last;
      }
    }
    return last!;
  }

  private async once(op: string, params: Record<string, string>, form: KeyForm): Promise<BimsResult> {
    const url = this.buildUrl(op, { pageNo: '1', numOfRows: '100', ...params }, form);
    this.calls++;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      const text = await res.text();
      const raw = redact(text, this.key);
      const h = parseXmlHeader(text);
      const items = parseXmlItems(text);
      const code = h.resultCode;
      let errorKind: BimsResult['errorKind'];
      if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE KEY IS NOT REGISTERED/i.test(text) || code === '30') errorKind = 'not_registered';
      else if (code === '22' || /LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS/i.test(text)) errorKind = 'rate_limited_daily';
      else if (code === '23' || res.status === 429 || /PER_SECOND/i.test(text)) errorKind = 'rate_limited_second';
      else if (!res.ok) errorKind = 'http';
      else if (code && code !== '00' && code !== '0') errorKind = 'other';
      return { ok: !errorKind, resultCode: code, resultMsg: h.resultMsg, items, httpStatus: res.status, rawRedacted: raw, errorKind };
    } catch (e) {
      const msg = redact(String((e as Error).message ?? e), this.key);
      return { ok: false, resultCode: null, resultMsg: msg, items: [], httpStatus: 0, rawRedacted: '', errorKind: (e as Error).name === 'AbortError' ? 'timeout' : 'other' };
    } finally {
      clearTimeout(t);
    }
  }
}
