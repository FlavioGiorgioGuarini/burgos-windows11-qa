#!/usr/bin/env node
'use strict';

/* Anonymous, read-only desktop checks. No install, shared profile or device/UA override.
 * node burgos-desktop-smoke.cjs firefox --out ./firefox-linux.json
 * node burgos-desktop-smoke.cjs --engine chromium --headed --out ./chromium-windows.json
 * Optional: PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright
 * PowerShell: $env:PLAYWRIGHT_MODULE='C:\path\to\node_modules\playwright'
 * Preinstalled Edge: BURGOS_BROWSER_CHANNEL=msedge (Chromium engine only).
 * Requires an existing Playwright/browser installation with routeWebSocket support.
 * Only local JSON evidence is written; HTTP mutations and WebSockets are blocked.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const ORIGIN = 'https://latejadeburgos.es';
const ARANDA = ORIGIN + '/aranda-de-duero/';
const MIRANDA = ORIGIN + '/miranda-de-ebro/';
const BASELINE = '0.4.6';
const allowedDocuments = new Set([ARANDA, MIRANDA]);

function options(argv) {
  const result = {engine: null, headed: false, out: null};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node burgos-desktop-smoke.cjs firefox|chromium [--headed] [--out report.json]\nSet PLAYWRIGHT_MODULE to an installed Playwright module path if needed. Set BURGOS_BROWSER_CHANNEL=msedge for preinstalled Edge with Chromium. No browsers are installed.');
      process.exit(0);
    } else if (arg === '--headed') result.headed = true;
    else if (arg === '--out' || arg === '--engine') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(arg + ' requires a value.');
      result[arg === '--out' ? 'out' : 'engine'] = value;
    } else if (!arg.startsWith('-') && !result.engine) result.engine = arg;
    else throw Error('Unknown or duplicate argument: ' + arg);
  }
  if (!['firefox', 'chromium'].includes(result.engine)) throw Error('Choose firefox or chromium explicitly.');
  result.out = path.resolve(result.out || ('burgos-' + result.engine + '-' + os.platform() + '-' + Date.now() + '.json'));
  if (fs.existsSync(result.out)) throw Error('Report already exists; use a new --out path: ' + result.out);
  return result;
}
function must(condition, message) { if (!condition) throw Error(message); }
function hostFacts() {
  const facts = {platform: os.platform(), type: os.type(), release: os.release(), version: os.version(), arch: os.arch(), node: process.version};
  if (process.platform === 'win32') {
    try {
      const command = 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | ConvertTo-Json -Compress';
      const raw = process.env.BURGOS_WINDOWS_FACTS || execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        {encoding: 'utf8', timeout: 20000, maxBuffer: 65536, windowsHide: true});
      facts.windows = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    } catch (error) { facts.windowsProbeError = error.message.split('\n')[0]; }
  } else if (process.platform === 'linux' && fs.existsSync('/etc/os-release')) {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    facts.distribution = text.match(/^PRETTY_NAME=(.*)$/m)?.[1].replace(/^"|"$/g, '') || null;
  }
  return facts;
}
const geometry = page => page.evaluate(() => ({client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, inner: innerWidth}));
async function settleMap(page) {
  await page.waitForFunction(() => {
    const map = document.querySelector('.abm-map');
    return map?.dataset.abmReady === 'true' && map.dataset.abmMotion !== 'running';
  }, null, {timeout: 10000});
}
async function card(page) {
  const cards = page.locator('.ltb-team-profile');
  const count = await cards.count();
  must(count === 1, 'Expected one Flavio card; found ' + count + '. Check duplicate injection and cached HTML.');
  const headings = await cards.locator('h1,h2,h3').allTextContents();
  must(headings.some(text => /Flavio Giorgio Guarini/i.test(text)), 'The unique team card does not name Flavio Giorgio Guarini.');
  return {count, headings};
}
async function image(page, person, selector) {
  const locator = page.locator(selector);
  must(await locator.count() === 1, 'Expected one ' + person + ' portrait at selector ' + selector + '.');
  await locator.scrollIntoViewIfNeeded();
  const handle = await locator.elementHandle();
  await page.waitForFunction(img => img.complete && img.naturalWidth > 1 && img.currentSrc && !/lazy_placeholder|^data:image\//.test(img.currentSrc), handle, {timeout: 12000});
  const result = await locator.evaluate(async img => {
    const outcome = await Promise.race([img.decode().then(() => 'decoded').catch(error => error.message), new Promise(resolve => setTimeout(() => resolve('decode timeout'), 5000))]);
    const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left, right:r.right, width:r.width, height:r.height}; };
    const box = rect(img), owner = rect(img.closest('.ltb-team-profile') || img.closest('.wp-block-column') || img.parentElement);
    return {decode: outcome, currentSrc: img.currentSrc, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes'), lazySrc: img.getAttribute('data-src'), lazySrcset: img.getAttribute('data-srcset'),
      objectFit: getComputedStyle(img).objectFit, image: box, owner, client: document.documentElement.clientWidth};
  });
  must(result.decode === 'decoded', person + ' portrait did not decode: ' + result.decode);
  const expected = new RegExp('/wp-content/plugins/aron-burgos-tools/portraits/' + person + '-(320|480|640)\\.webp$');
  must(expected.test(new URL(result.currentSrc).pathname), person + ' is not using the optimized plugin portrait: ' + result.currentSrc);
  must(result.image.width > 1 && result.image.height > 1, person + ' portrait has no visible geometry.');
  must(Math.abs(result.image.width / result.image.height - result.naturalWidth / result.naturalHeight) < .02, person + ' portrait aspect ratio is distorted.');
  must(result.image.left >= -1 && result.image.right <= result.client + 1, person + ' portrait overflows the viewport.');
  must(result.image.left >= result.owner.left - 1 && result.image.right <= result.owner.right + 1, person + ' portrait overflows its card/column.');
  return result;
}
async function destination(page) {
  must(page.url() === MIRANDA, 'Expected Miranda URL; received ' + page.url());
  const headings = await page.locator('main h1').allTextContents();
  must(headings.length === 1 && headings[0].includes('Miranda de Ebro'), 'Miranda must have one matching main H1; received ' + JSON.stringify(headings));
  return {url: page.url(), h1: headings, flavio: await card(page)};
}

(async () => {
  let config;
  try { config = options(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  const report = {utc: new Date().toISOString(), baseline: BASELINE, engine: config.engine, host: hostFacts(),
    mode: 'Actual Node host OS and desktop browser engine; no OS/device/user-agent emulation. VM status and physical hardware are not certified.',
    anonymous: true, viewport: {width: 1280, height: 900}, checks: [], pageErrors: [], documents: [], blocked: [], requestCount: 0};
  let browser, context, page;
  const check = async (name, fn) => {
    try { const details = await fn(); report.checks.push({name, pass: true, details}); console.log('PASS ' + name); return true; }
    catch (error) { report.checks.push({name, pass: false, error: error.message.slice(0, 4000)}); console.error('FAIL ' + name + ': ' + error.message.split('\n')[0]); return false; }
  };
  try {
    if (process.platform === 'win32') await check('Windows OS caption/build from PowerShell', async () => {
      must(report.host.windows?.Caption && report.host.windows?.BuildNumber, 'PowerShell OS probe failed: ' + (report.host.windowsProbeError || 'missing Caption/BuildNumber'));
      return report.host.windows;
    });
    const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    must(pw[config.engine], 'Installed module does not expose ' + config.engine + '.');
    const channel = process.env.BURGOS_BROWSER_CHANNEL || null;
    must(!channel || (config.engine === 'chromium' && channel === 'msedge'), 'BURGOS_BROWSER_CHANNEL supports msedge with the chromium engine only.');
    report.browserChannel = channel;
    browser = await pw[config.engine].launch({headless: !config.headed, ...(channel ? {channel} : {})});
    report.browserVersion = browser.version();
    context = await browser.newContext({viewport: report.viewport, serviceWorkers: 'block', extraHTTPHeaders: {'Cache-Control': 'no-cache', Pragma: 'no-cache'}});
    must(typeof context.routeWebSocket === 'function', 'Use an installed Playwright with routeWebSocket support; no navigation attempted.');
    await context.routeWebSocket('**/*', socket => { report.blocked.push({kind: 'websocket'}); socket.close(); });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      report.requestCount++;
      const mainDocument = req.isNavigationRequest() && req.frame().parentFrame() === null;
      const clean = new URL(url.href); clean.hash = '';
      const reason = !['GET', 'HEAD'].includes(req.method()) ? 'mutation' : mainDocument && !allowedDocuments.has(clean.href) ? 'unapproved document' : report.requestCount > 600 ? 'request budget' : null;
      if (reason) { report.blocked.push({reason, method: req.method(), origin: url.origin, path: url.pathname, resourceType: req.resourceType()}); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('response', response => { if (response.request().resourceType() === 'document') {
      const headers = response.headers(); report.documents.push({url: response.url(), status: response.status(), cache: headers['x-litespeed-cache'] || null, age: headers.age || null});
    }});
    const gotoAranda = async () => {
      const response = await page.goto(ARANDA, {waitUntil: 'load'});
      must(response?.status() === 200 && page.url() === ARANDA,
        'Aranda returned HTTP ' + (response?.status() ?? 'unknown') + ' at ' + page.url() + ' (expected 200 at ' + ARANDA + ').');
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]));
      const deny = page.locator('#cmplz-cookiebanner-1-optin .cmplz-deny');
      if (await deny.isVisible()) await deny.click();
      await settleMap(page);
    };
    if (!await check('Aranda anonymous page, release and desktop layout', async () => {
      await gotoAranda();
      report.browserOS = await page.evaluate(() => ({userAgent: navigator.userAgent, platform: navigator.platform}));
      const css = await page.locator('link[href*="/aron-burgos-tools/site-ux.css"]').getAttribute('href');
      must(css && new URL(css, ARANDA).searchParams.get('ver') === BASELINE, 'Expected site-ux.css release ' + BASELINE + '; received ' + css + '. Check cache/deployment.');
      const size = await geometry(page); must(size.scroll <= size.client + 1, 'Aranda has horizontal overflow: ' + JSON.stringify(size));
      return {css, viewport: size, flavio: await card(page)};
    })) throw Error('Initial Aranda check failed; dependent navigation tests were not attempted.');
    await check('Aranda optimized Aron portrait decode and geometry', () => image(page, 'aron', '.uagb-block-3bd5a837 img.wp-image-460'));
    await check('Aranda optimized Flavio portrait decode and geometry', () => image(page, 'flavio', '.ltb-team-profile img'));
    await check('Map search, selection zoom, zoom controls and Miranda CTA', async () => {
      const map = page.locator('.abm-map'); must(await map.count() === 1, 'Expected exactly one shared map.');
      const links = await map.locator('a.abm-municipality[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
      const directory = await map.locator('.abm-directory a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
      const directoryLinks = new Set(directory);
      must(links.length === 371 && new Set(links).size === 371 && directory.length === 371
        && links.every(url => directoryLinks.has(url)), 'Map polygons and directory must expose the same 371 unique municipality links.');
      const svg = map.locator('.abm-svg'), initial = await svg.getAttribute('viewBox');
      await map.locator('.abm-query').fill('Miranda de Ebro');
      const result = map.locator('.abm-results [role="option"]').filter({hasText: /^Miranda de Ebro$/});
      must(await result.count() === 1, 'Search did not produce one exact Miranda option.');
      await result.click(); await settleMap(page);
      must((await map.locator('.abm-place').textContent()).trim() === 'Miranda de Ebro', 'Map selection label is incorrect.');
      const selected = await svg.getAttribute('viewBox');
      must(selected !== initial, 'Selecting Miranda did not change the viewBox.');
      await map.locator('[data-abm-zoom="in"]').click(); await settleMap(page);
      const zoomed = await svg.getAttribute('viewBox');
      must(Number(zoomed.split(/\s+/)[2]) < Number(selected.split(/\s+/)[2]), 'Zoom + did not reduce viewBox width.');
      await map.locator('[data-abm-zoom="reset"]').click(); await settleMap(page);
      must(await svg.getAttribute('viewBox') === initial, 'Reset did not restore the initial viewBox.');
      const cta = map.locator('.abm-open'); must(await cta.getAttribute('href') === MIRANDA, 'Selected-map CTA has an unexpected URL.');
      await Promise.all([page.waitForURL(MIRANDA, {waitUntil: 'load'}), cta.click()]);
      return {links: links.length, directory: directory.length, initial, selected, zoomed, destination: await destination(page)};
    });
    await check('Actual SVG polygon click opens Miranda with one Flavio card', async () => {
      await gotoAranda();
      const map = page.locator('.abm-map'), link = map.locator('.abm-municipality[data-name="Miranda de Ebro"]');
      must(await link.count() === 1 && await link.getAttribute('href') === MIRANDA, 'Miranda polygon must have one native anchor with the exact URL.');
      await link.scrollIntoViewIfNeeded(); await settleMap(page);
      const point = await link.locator('path').evaluate(shape => {
        const b = shape.getBBox(), matrix = shape.getScreenCTM(); if (!matrix) return null;
        for (const x of [.5,.35,.65,.2,.8,.1,.9]) for (const y of [.5,.35,.65,.2,.8,.1,.9]) {
          const p = new DOMPoint(b.x + b.width*x, b.y + b.height*y);
          if (!shape.isPointInFill(p)) continue;
          const q = p.matrixTransform(matrix), hit = document.elementFromPoint(q.x, q.y);
          if (hit && (hit === shape || hit.closest('.abm-municipality') === shape.closest('.abm-municipality'))) return {x:q.x,y:q.y};
        } return null;
      });
      must(point, 'No visible interior point hit the Miranda polygon; inspect overlays, geometry or scroll position.');
      await Promise.all([page.waitForURL(MIRANDA, {waitUntil:'load'}), page.mouse.click(point.x, point.y)]);
      const result = await destination(page);
      const last = report.documents.filter(document => document.url === MIRANDA).at(-1);
      must(last?.status === 200, 'Miranda navigation did not return HTTP 200.');
      return {point, destination: result};
    });
    await check('No uncaught page JavaScript errors or unapproved navigation', async () => {
      must(report.pageErrors.length === 0, 'Page errors: ' + report.pageErrors.join(' | '));
      must(!report.blocked.some(item => ['unapproved document','request budget'].includes(item.reason)), 'Unexpected navigation or request budget exceeded; inspect blocked entries.');
      return {pageErrors: [], requests: report.requestCount, blockedMutations: report.blocked.filter(item => item.reason === 'mutation').length};
    });
  } catch (error) { report.fatal = error.message.slice(0, 4000); console.error('STOP ' + error.message.split('\n')[0]); }
  finally {
    try { if (context) await context.close(); } catch (error) { report.contextCloseError = error.message; }
    try { if (browser) await browser.close(); report.ownedBrowserClosed = true; } catch (error) { report.browserCloseError = error.message; }
    report.finishedUtc = new Date().toISOString();
    report.pass = !report.fatal && !report.contextCloseError && !report.browserCloseError && report.checks.length >= 6 && report.checks.every(check => check.pass);
    try { fs.mkdirSync(path.dirname(config.out), {recursive:true}); fs.writeFileSync(config.out, JSON.stringify(report, null, 2) + '\n', {encoding:'utf8',flag:'wx'}); }
    catch (error) { console.error('Cannot write evidence: ' + error.message); process.exitCode = 1; return; }
    console.log(JSON.stringify({pass:report.pass, engine:config.engine, platform:report.host.platform, report:config.out}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
