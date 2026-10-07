// 현장 보정 확인: 방향별 '평소 경로' 카드(메인 또는 다른 후보) + 설정 시트. 예전 저장값(exitMin 2)을 미리 넣어 이관도 확인
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://localhost:5179/';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const trip of ['forward', 'reverse']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await page.addInitScript((t) => { try {
    localStorage.setItem('bbt.trip', t);
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem(t === 'forward' ? 'bbt.prefs' : 'bbt.prefs.reverse', JSON.stringify({ exitMin: 2, walkMult: 1 })); sessionStorage.setItem('seeded', '1'); }
  } catch {} }, trip);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card.hero, .card.alt', { timeout: 60000 });
  await page.waitForTimeout(2000);
  console.log(trip, 'stored prefs after load', await page.evaluate((t) => localStorage.getItem(t === 'forward' ? 'bbt.prefs' : 'bbt.prefs.reverse'), trip));
  const usualCard = page.locator('article.card').filter({ has: page.locator('.badge-usual') }).first();
  let where = 'main';
  if (await usualCard.count()) {
    await usualCard.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -60));
    await page.waitForTimeout(400);
    console.log(trip, 'main usual card:', (await usualCard.innerText()).replace(/\s+/g, ' ').slice(0, 400));
  } else {
    where = 'others';
    await page.click('nav.quick button >> text=다른 후보');
    await page.waitForSelector('.others');
    await page.waitForTimeout(800);
    const li = page.locator('.others li').filter({ has: page.locator('.badge-usual') }).first();
    await li.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    console.log(trip, 'others usual entry:', (await li.innerText()).replace(/\s+/g, ' ').slice(0, 400));
  }
  console.log(trip, 'helper:', await page.$$eval('.stops-helper', (e) => e.map((x) => x.textContent)));
  await page.screenshot({ path: `screenshot-calib-${trip}.png` });
  console.log(trip, 'usual card shown in', where, '→', `screenshot-calib-${trip}.png`);
  // 펼쳐서 시간표(문→정류장 실측 라벨) 확인
  if (where === 'main') {
    await usualCard.locator('.card-tap').click();
    await page.waitForTimeout(800);
    const tl = usualCard.locator('.timeline li').nth(1);
    console.log(trip, 'timeline walk:', (await tl.innerText()).replace(/\s+/g, ' ').slice(0, 160));
    await usualCard.locator('.timeline').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `screenshot-calib-${trip}-timeline.png` });
    await usualCard.locator('.card-tap').click();
  } else {
    await page.click('.sheet-head button[aria-label="닫기"]');
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('header button[aria-label="설정"], button.icon-btn[aria-label="설정"]');
  await page.waitForSelector('.settings');
  await page.waitForTimeout(500);
  console.log(trip, 'settings:', (await page.locator('.settings').innerText()).replace(/\s+/g, ' ').slice(0, 300));
  await page.screenshot({ path: `screenshot-calib-${trip}-settings.png` });
  await page.close();
}
await browser.close();
