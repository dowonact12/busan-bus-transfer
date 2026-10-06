// 사용: node scripts/screenshot.mjs [url] [forward|reverse]
// 390x844 모바일 스크린샷: 첫 화면, 3점 도식, 지도 (+ 가로 넘침·작은 터치 영역 점검)
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://localhost:5179/';
const trip = process.argv[3] === 'reverse' ? 'reverse' : 'forward';
const name = (s) => `screenshot-${trip}${s}.png`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
await page.addInitScript((t) => { try { localStorage.setItem('bbt.trip', t); } catch {} }, trip);
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.card.hero .eta-clock, .empty-card', { timeout: 60000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: name('') });
console.log('horizontal overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
const card = (await page.$('.card.hero .card-tap')) ?? (await page.$('.card.alt .card-tap'));
let inSheet = false;
if (card) {
  await card.click();
  await page.waitForSelector('.schem', { timeout: 10000 });
  await page.waitForTimeout(4000); // 차량 위치 + 지도 타일
} else {
  // 추천이 없을 때(심야 등): '다른 후보'에서 버스가 가장 많이 잡힌 경로를 펼침
  inSheet = true;
  await page.click('.empty-card .btn');
  await page.waitForSelector('.others li');
  const n = await page.$$eval('.others li > button', (b) => b.length);
  let best = { i: -1, c: -1 };
  for (let i = 0; i < n; i++) {
    try {
      await page.locator('.others li > button').nth(i).click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      const c = await page.$$eval('.schem-list li:not(.bus-stale)', (els) => els.length);
      if (c > best.c) best = { i, c };
      await page.locator('.others li > button').nth(i).click({ timeout: 5000 });
      if (c >= 3) break;
    } catch { /* 다음 후보 */ }
  }
  console.log('expanded other candidate', best);
  await page.locator('.others li > button').nth(best.i).click();
  await page.waitForTimeout(3500);
}
if (await page.$('.schem')) {
  const scrollTo = async (sel, off) => page.evaluate(([sel, off]) => {
    const el = document.querySelector(sel); const sc = document.querySelector('.sheet-body');
    if (sc && sc.contains(el)) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - off;
    else window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off);
  }, [sel, off]);
  await scrollTo(inSheet ? '.others li:has(.schem)' : '.schem', inSheet ? 8 : 70);
  await page.waitForTimeout(500);
  await page.screenshot({ path: name('-schematic') });
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 15000 }).catch(() => console.log('tiles not loaded'));
  await page.waitForTimeout(1500);
  await scrollTo(inSheet ? '.tripmap' : '.map-box', inSheet ? 60 : 140);
  await page.waitForTimeout(800);
  await page.screenshot({ path: name('-map') });
  console.log('buses in schematic:', await page.$$eval('.schem-list li', (els) => els.map((e) => e.textContent)));
  console.log('buses on map:', await page.$$eval('.map-bus span', (els) => els.map((e) => e.textContent)));
}
await page.screenshot({ path: name('-full'), fullPage: true });
await page.addStyleTag({ content: 'html{font-size:125%}' });
await page.waitForTimeout(300);
console.log('overflow @125% text:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
const small = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter((e) => { if (e.closest('.leaflet-control-attribution')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 32 || r.width < 32); }).map((e) => e.textContent?.trim().slice(0, 20)));
console.log('small targets:', small);
await browser.close();
