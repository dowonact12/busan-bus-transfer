import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://localhost:5179/';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const trip of ['forward', 'reverse']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await page.addInitScript((t) => { try { localStorage.setItem('bbt.trip', t); } catch {} }, trip);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card.hero', { timeout: 60000 });
  await page.waitForTimeout(2000);
  // 메인: 추천 + 평소 대안(있으면)
  await page.evaluate(() => window.scrollTo(0, 0));
  const altUsual = page.locator('.card.alt').filter({ has: page.locator('.badge-usual') }).first();
  if (await altUsual.count()) {
    await altUsual.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }
  console.log(trip, 'main badges', await page.$$eval('.badge-usual', (e) => e.map((x) => x.textContent)));
  console.log(trip, 'diff labels', await page.$$eval('.diff', (e) => e.map((x) => x.textContent)));
  await page.screenshot({ path: `screenshot-pref-${trip}.png` });

  // 다른 후보 시트에서 평소 경로 확인
  await page.click('nav.quick button >> text=다른 후보');
  await page.waitForSelector('.others');
  await page.waitForTimeout(800);
  const prefLi = page.locator('.others li').filter({ has: page.locator('.badge-usual') }).first();
  if (await prefLi.count()) {
    await prefLi.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    console.log(trip, 'others usual', await prefLi.innerText().then((t) => t.slice(0, 100)));
  } else {
    console.log(trip, 'others: no usual badge visible');
  }
  await page.screenshot({ path: `screenshot-pref-${trip}-others.png` });
  await page.close();
}
await browser.close();
