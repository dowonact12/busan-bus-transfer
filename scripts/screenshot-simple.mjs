// 단순화 확인(390x844): 방향별 메인(고정 카드), '자세히' 펼침, '지도로 보기'
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://localhost:5179/';
const tag = process.argv[3] ?? 'local';
const out = `screenshots/simple/${tag}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
for (const trip of ['forward', 'reverse']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript((t) => { try { localStorage.setItem('bbt.trip', t); } catch {} }, trip);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card.pinned', { timeout: 90000 });
  await page.waitForTimeout(2500);
  const card = page.locator('.card.pinned');
  console.log(trip, 'pill:', await page.locator('.top-sub .pill').innerText());
  console.log(trip, 'pinned cand:', await card.getAttribute('data-cand'));
  console.log(trip, 'pinned text:', (await card.innerText()).replace(/\s+/g, ' '));
  console.log(trip, 'better line:', await page.locator('.better-line').count() ? (await page.locator('.better-line').innerText()).replace(/\s+/g, ' ') : '(none)');
  await page.screenshot({ path: `${out}-${trip}-main.png` });
  if (trip === 'forward' || process.argv[4] === 'all') {
    await page.click('.card.pinned .more-btn');
    await page.waitForTimeout(800);
    await card.screenshot({ path: `${out}-${trip}-details.png` });
    await page.click('.card.pinned .map-toggle');
    await page.waitForSelector('.tripmap', { timeout: 20000 });
    await page.waitForTimeout(7000);
    const gl = await page.locator('.maplibregl-canvas').count(), lf = await page.locator('.leaflet-container').count();
    console.log(trip, 'map engine:', gl ? 'maplibre (OpenFreeMap positron)' : lf ? 'leaflet fallback' : 'none');
    await page.evaluate(() => document.querySelector('.map-toggle').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}-${trip}-map.png` });
  }
  console.log(trip, 'errors:', errs.length ? errs.slice(0, 5) : 'none');
  await page.close();
}
await browser.close();
