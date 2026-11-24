// Screenshot and smoke-test script for the front end against the stub server. Dev only.
// NODE_PATH=$(npm root -g) node public-dev/shots.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const USERS = {
  Manager: ['maria@centrex.test', 'manager-code-1'],
  Sales: ['sam@centrex.test', 'sales-code-1'],
  Outside: ['olive@centrex.test', 'outside-code-1'],
};
const problems = [];
const checks = [];
function check(name, ok, extra) { checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); }

async function dev(p) { await fetch(BASE + p); }

async function newPage(browser, width) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${width}] console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${width}] pageerror: ${e.message}`));
  page.on('dialog', (d) => { problems.push(`[${width}] unexpected dialog: ${d.message()}`); d.dismiss(); });
  return page;
}

async function signIn(page, role) {
  await page.goto(`${BASE}/#/signin`);
  await page.fill('input[name=email]', USERS[role][0]);
  await page.fill('input[name=code]', USERS[role][1]);
  await page.click('button[type=submit]');
  await page.waitForSelector('#page-h1:not(:has-text("Sign in"))');
}

async function shot(page, name, full = true) {
  if (full) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  await dev('/__dev/reset');

  for (const width of [390, 1280]) {
    const tag = width;
    let page = await newPage(browser, width);
    await page.goto(`${BASE}/`);
    await page.waitForSelector('input[name=email]');
    await shot(page, `${tag}-signin`, false);

    // Wrong code
    await page.fill('input[name=email]', 'maria@centrex.test');
    await page.fill('input[name=code]', 'wrong-code-x');
    await page.click('button[type=submit]');
    await page.waitForSelector('.form-error:not([hidden])');
    check(`${tag} bad login message`, (await page.textContent('.form-error')).includes('do not match'));

    await signIn(page, 'Manager');
    await page.waitForSelector('.lead-card, .empty');
    await shot(page, `${tag}-today-manager`);
    check(`${tag} manager sees Add lead nav`, await page.isVisible('.app-nav a[href="#/add"]'));

    await page.goto(`${BASE}/#/pipeline`);
    await page.waitForSelector('.summary');
    await shot(page, `${tag}-pipeline-manager`);
    // XSS probe: project name with markup must render as text
    check(`${tag} no injected img`, (await page.$$('img')).length === 0);

    await page.goto(`${BASE}/#/lead/L-0001?log=1`);
    await page.waitForSelector('.log-form');
    await page.fill('.log-form textarea[name=note]', 'Talked to Dana; bid schedule set for January.');
    await page.click('.log-form .pick >> nth=1');
    await shot(page, `${tag}-lead-log-open`);

    // Failed save keeps text
    await dev('/__dev/fail?n=1');
    await page.click('.log-form button[type=submit]');
    await page.waitForSelector('.log-form .form-error:not([hidden])');
    const kept = await page.inputValue('.log-form textarea[name=note]');
    check(`${tag} failed save keeps note`, kept.startsWith('Talked to Dana'), kept);
    await shot(page, `${tag}-lead-log-failed`, false);
    await page.click('.log-form button[type=submit]');
    await page.waitForSelector('.log-form', { state: 'detached' });
    check(`${tag} saved activity appears`, (await page.textContent('.timeline')).includes('bid schedule set for January'));

    // Edit details form (Manager)
    await page.click('button:has-text("Edit details")');
    await page.waitForSelector('.details-form');
    await shot(page, `${tag}-lead-edit-details`);
    await page.click('.details-form button:has-text("Cancel")');

    // Unsafe source link must not be a link
    await page.goto(`${BASE}/#/lead/L-0004`);
    await page.waitForSelector('.facts');
    const jsLinks = await page.$$eval('a', (as) => as.filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length);
    check(`${tag} no javascript: links`, jsLinks === 0);

    await page.goto(`${BASE}/#/add`);
    await page.waitForSelector('.add-form');
    await shot(page, `${tag}-add-lead`);

    await page.goto(`${BASE}/#/bids`);
    await page.waitForSelector('.bid-card');
    await shot(page, `${tag}-bids`);

    // Log from a Today card (one tap + form)
    await page.goto(`${BASE}/#/today`);
    await page.waitForSelector('.btn-log');
    await page.click('.btn-log >> nth=0');
    await page.waitForSelector('dialog.sheet[open]');
    await shot(page, `${tag}-today-log-sheet`, false);
    await page.keyboard.press('Escape');

    // 401 mid-session: go to sign-in, then come back
    await page.goto(`${BASE}/#/lead/L-0002`);
    await page.waitForSelector('.next-block');
    await page.click('button:has-text("Change next step")');
    await page.fill('textarea[name=nextStep]', 'Typed before session expired');
    await dev('/__dev/expire');
    await page.click('.next-block button[type=submit]');
    await page.waitForSelector('input[name=code]');
    await shot(page, `${tag}-signin-after-401`, false);
    await page.fill('input[name=code]', USERS.Manager[1]);
    await page.click('button[type=submit]');
    await page.waitForSelector('.next-block textarea[name=nextStep]');
    check(`${tag} 401 returns to lead with draft`, page.url().endsWith('#/lead/L-0002') && (await page.inputValue('textarea[name=nextStep]')) === 'Typed before session expired', page.url());
    await page.click('.next-block button:has-text("Cancel")');
    await page.context().close();

    // Sales
    page = await newPage(browser, width);
    await signIn(page, 'Sales');
    await page.waitForSelector('.lead-card');
    await shot(page, `${tag}-today-sales`);
    check(`${tag} sales sees claim section`, await page.isVisible('#g-unassigned'));
    await page.goto(`${BASE}/#/pipeline`);
    await page.waitForSelector('.filters');
    check(`${tag} sales no summary strip`, !(await page.$('.summary')));
    await page.goto(`${BASE}/#/lead/L-0004`);
    await page.waitForSelector('.next-block');
    check(`${tag} sales no edit details`, !(await page.$('button:has-text("Edit details")')));
    check(`${tag} sales can claim`, await page.isVisible('button:has-text("Claim this lead")'));
    await page.context().close();

    // Outside
    page = await newPage(browser, width);
    await signIn(page, 'Outside');
    await page.waitForSelector('.lead-card, .empty');
    await shot(page, `${tag}-today-outside`);
    check(`${tag} outside no add/bids nav`, !(await page.$('.app-nav a[href="#/add"]')) && !(await page.$('.app-nav a[href="#/bids"]')));
    await page.goto(`${BASE}/#/pipeline`);
    await page.waitForSelector('.filters');
    check(`${tag} outside no owner filter`, !(await page.$('select[name=owner]')));
    await page.goto(`${BASE}/#/lead/L-0006`);
    await page.waitForSelector('.next-block');
    await page.click('button:has-text("Change next step")');
    check(`${tag} outside no owner picker`, !(await page.$('select[name=nextOwner]')));
    await page.goto(`${BASE}/#/lead/L-0001`);
    await page.waitForSelector('.empty');
    check(`${tag} outside 404 lead message`, (await page.textContent('.empty')).includes('not available'));
    await page.context().close();

    // Not configured
    await dev('/__dev/not-configured?on=1');
    page = await newPage(browser, width);
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.signin-notice');
    check(`${tag} not_configured message`, (await page.textContent('.signin-notice')).includes('Michael Mason'));
    await shot(page, `${tag}-signin-not-configured`, false);
    await page.context().close();
    await dev('/__dev/not-configured?on=0');
    await dev('/__dev/reset');
  }

  await browser.close();
  console.log(checks.join('\n'));
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'No console errors.');
})().catch((e) => { console.error(e); process.exit(1); });
