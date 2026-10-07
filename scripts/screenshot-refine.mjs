// 자리 힌트·배차 몰림·플랜 B·내 기록 화면 확인. 실제 실시간 데이터 위에서, 필요한 경우만 브라우저 안에서 응답을 바꿔 '모의 상태'를 만들고 화면에 표시함
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://localhost:5179/';
const out = (n) => `screenshot-refine-${n}.png`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const newPage = async (trip, init) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await page.addInitScript(([t, extra]) => { try { localStorage.setItem('bbt.trip', t); if (extra && !sessionStorage.getItem('seeded')) { for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } } catch {} }, [trip, init ?? null]);
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  return page;
};
const label = (page, text) => page.evaluate((t) => { const d = document.createElement('div'); d.textContent = t; Object.assign(d.style, { position: 'fixed', left: '8px', right: '8px', bottom: '8px', zIndex: 9999, background: '#222', color: '#fff', font: '700 13px sans-serif', padding: '8px 10px', borderRadius: '10px', opacity: '0.92', textAlign: 'center' }); document.body.appendChild(d); }, text);
const ready = async (page) => { await page.goto(url, { waitUntil: 'networkidle' }); await page.waitForSelector('.card.hero, .card.alt', { timeout: 60000 }); await page.waitForTimeout(2500); };
const txt = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

// 1) 실제 데이터: 자리 힌트(카드) + 혼잡 시트
for (const trip of ['forward', 'reverse']) {
  const page = await newPage(trip);
  await ready(page);
  console.log(trip, 'LIVE hint rows:', await page.$$eval('.hint-row', (e) => e.map((x) => x.textContent)));
  await page.screenshot({ path: out(`${trip}-live-card`) });
  await page.click('nav.quick button >> text=혼잡');
  await page.waitForSelector('.seat-list');
  await page.waitForTimeout(500);
  console.log(trip, 'LIVE crowd sheet:', (await txt(page.locator('.seat-list'))).slice(0, 500));
  await page.screenshot({ path: out(`${trip}-live-crowd`) });
  await page.close();
}

// 2) 모의: 배차 몰림(각 정류장 둘째 차를 첫 차 2분 뒤로)
{
  const page = await newPage('reverse');
  await page.route('**/api/snapshot**', async (route) => {
    const r = await route.fetch(); const j = await r.json();
    for (const b of j.boards) { const o = b.observations.filter((x) => x.etaAt != null).sort((a, c) => a.etaAt - c.etaAt); if (o.length >= 2) { o[1].etaAt = o[0].etaAt + 120; if (o[0].remainingStops != null) o[1].remainingStops = o[0].remainingStops + 1; } }
    await route.fulfill({ response: r, json: j });
  });
  await ready(page);
  console.log('MOCK bunching:', await page.$$eval('.bunch-line', (e) => e.map((x) => x.textContent)));
  await label(page, '🧪 모의 상태: 실제 데이터의 둘째 차를 첫 차 2분 뒤로 옮김(배차 몰림 강제)');
  await page.screenshot({ path: out('mock-bunching') });
  await page.close();
}

// 3) 모의: 플랜 B(처음엔 실제 데이터 → 다음 갱신에서 각 정류장 첫 차가 지나간 것처럼 뺌)
for (const trip of ['forward', 'reverse']) {
  const page = await newPage(trip);
  let drop = null;
  await page.route('**/api/snapshot**', async (route) => {
    const r = await route.fetch(); const j = await r.json();
    if (drop) for (const b of j.boards) b.observations = b.observations.filter((x) => x.vehicleReference !== drop);
    await route.fulfill({ response: r, json: j });
  });
  await ready(page);
  drop = await page.locator('.card.hero').first().getAttribute('data-veh');
  console.log(trip, 'mock: hero targets vehicle', drop);
  await page.click('header button[aria-label="새로고침"]');
  await page.waitForTimeout(3500);
  const pb = page.locator('.planb');
  if (await pb.count()) { console.log(trip, 'MOCK plan B:', await txt(pb)); await pb.scrollIntoViewIfNeeded(); }
  else console.log(trip, 'MOCK plan B: not shown');
  await label(page, '🧪 모의 상태: 다음 갱신에서 첫 차를 지나간 것으로 뺌(놓침 강제)');
  await page.screenshot({ path: out(`${trip}-mock-planb`) });
  await page.close();
}

// 4) 모의: 내 기록 3회(지금 시간대·평일/주말·같은 방향) → '내 기록 기반 (3회)'
{
  const cl = await (await fetch(new URL('/api/candidates?trip=reverse', url))).json();
  const now = Math.floor(Date.now() / 1000), wk = 7 * 86400;
  const recs = cl.candidates.flatMap((c) => [1, 2, 3].map((k) => ({ id: `mock-${c.id}-${k}`, trip: 'reverse', candidateId: c.id, routeNo: c.legs[0].routeNo, boardArs: c.legs[0].board.ars, vehicleRef: null, leftAt: now - k * wk, atStopAt: now - k * wk + 270 + k * 15, boardedAt: now - k * wk + 420 + k * 20, arrivedAt: now - k * wk + 420 + k * 20 + 1500 + k * 60 })));
  const page = await newPage('reverse', { 'bbt.history': JSON.stringify(recs) });
  await ready(page);
  const hero = page.locator('.card.hero').first();
  console.log('MOCK history card:', (await txt(hero)).slice(0, 600));
  await label(page, '🧪 모의 기록: 경로마다 3회(지난 3주 같은 시간대) 넣음 → 내 기록 기반 표시');
  await page.screenshot({ path: out('mock-history-card') });
  await page.click('header button[aria-label="설정"]');
  await page.waitForSelector('.settings');
  await page.waitForTimeout(400);
  await page.locator('.settings').evaluate((e) => e.scrollIntoView({ block: 'end' }));
  console.log('MOCK history settings:', (await txt(page.locator('.settings'))).slice(-260));
  await label(page, '🧪 모의 기록(경로마다 3회)');
  await page.screenshot({ path: out('mock-history-settings') });
  await page.close();
}
await browser.close();
