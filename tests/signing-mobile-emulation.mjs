/**
 * Headless iOS Chrome emulation for the signing submit fix.
 * Run: NODE_PATH=/tmp/bsd-test-deps/node_modules node tests/signing-mobile-emulation.mjs
 * Serves this repo and never calls the real Supabase / FormSubmit endpoints.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function loadPuppeteer() {
  const bases = [process.env.PUPPETEER_REQUIRE_FROM, import.meta.url].filter(Boolean);
  const errors = [];
  for (const base of bases) {
    try { return createRequire(base)('puppeteer-core'); } catch (err) { errors.push(err.message); }
  }
  throw new Error('puppeteer-core is not installed. ' + errors.join(' | '));
}
const puppeteer = loadPuppeteer();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1';

const PROGRESS = 'שומר את ההסכם... נא לא לצאת מהדף';
const FAILURE = 'ההסכם לא נשמר – נסו שוב';
const WA_LABEL = 'שלח לברוך בוואטסאפ';

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function boot(browser, server, { backoffMs }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const posts = [];
  let mode = 'fail';
  await page.setUserAgent(IOS_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((ms) => {
    window.__opens = [];
    window.open = function (url) {
      window.__opens.push(String(url));
      return null;
    };
    window.__fetches = [];
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const body = init && init.body ? String(init.body) : '';
      window.__fetches.push({ url: String(url), keepalive: !!(init && init.keepalive), len: body.length });
      return orig(input, init);
    };
    window.BSD_SIGNING_BACKOFF_MS = ms;
  }, backoffMs);
  await page.setRequestInterception(true);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, accept, apikey, authorization',
    'Content-Type': 'application/json'
  };
  page.on('request', (req) => {
    const url = req.url();
    const hit = url.includes('complete-signed-agreement') || url.includes('formsubmit.co');
    if (!hit) { req.continue(); return; }
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: cors });
      return;
    }
    posts.push({ url, body: req.postData() || '', mode });
    if (mode === 'fail') {
      req.respond({ status: 500, headers: cors, body: JSON.stringify({ ok: false, error: 'simulated' }) });
      return;
    }
    if (url.includes('formsubmit')) {
      req.respond({ status: 200, headers: cors, body: JSON.stringify({ success: 'true' }) });
      return;
    }
    req.respond({ status: 200, headers: cors, body: JSON.stringify({ ok: true, email_sent: true }) });
  });
  const port = server.address().port;
  return {
    context, page, posts,
    origin: `http://127.0.0.1:${port}`,
    setMode(next) { mode = next; }
  };
}

async function fillAndSign(page, fields) {
  await page.waitForFunction(() => window.BsdSigningDelivery && window.jspdf);
  await page.evaluate((fields) => {
    for (const [id, value] of Object.entries(fields)) {
      const el = document.getElementById(id);
      if (!el) throw new Error('missing field ' + id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const cb = document.getElementById('confirmCheck');
    cb.checked = true;
    if (typeof onConfirmChange === 'function') onConfirmChange();
  }, fields);
  await page.evaluate(() => document.getElementById('sigCanvas').scrollIntoView({ block: 'center' }));
  const canvas = await page.$('#sigCanvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 24, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 20, 220), box.y + 110, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('sigWrap').classList.contains('signed'));
}

async function clickSubmit(page) {
  await page.evaluate(() => {
    document.querySelector('#mainContent button.btn-submit').click();
  });
}

const baseFields = {
  f_name: 'ישראל ישראלי',
  f_id: '123456789',
  f_phone: '0521234567',
  f_email: 'signer@example.com',
  f_address: 'הרצל 1',
  f_city: 'תל אביב'
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function run() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none']
  });
  const results = [];
  try {
    results.push(await testLegacyFailureRetry(browser, server));
    results.push(await testLegacyAutoBackoff(browser, server));
    results.push(await testLegacyVisibilityResume(browser, server));
    results.push(await testBuyerRealPdf(browser, server));
    results.push(await testReloadResume(browser, server, 'bsd-contract-signing-seller.html', 'seller', {
      ...baseFields, f_biz: 'עסק לדוגמה', f_entity: 'עוסק מורשה'
    }, 'businesses'));
    results.push(await testStubRetry(browser, server, 'bsd-contract-signing-broker.html', 'broker', baseFields, 'brokers'));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

async function openSigning(page, origin, file) {
  await page.goto(`${origin}/${file}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.BsdSigningDelivery && window.jspdf, { timeout: 90000 });
}

async function testLegacyFailureRetry(browser, server) {
  const session = await boot(browser, server, { backoffMs: 60000 });
  try {
    await openSigning(session.page, session.origin, 'bsd-contract-signing.html');
    await fillAndSign(session.page, { ...baseFields, f_biz: 'עסק לדוגמה', f_entity: 'חברה בע״מ' });
    await clickSubmit(session.page);
    await session.page.waitForFunction((text) => {
      const el = document.getElementById('saveProgress');
      return el && getComputedStyle(el).display !== 'none' && document.getElementById('saveProgressText').textContent === text;
    }, { timeout: 20000 }, PROGRESS);
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('saveFailure')).display !== 'none', { timeout: 20000 });
    const failure = await session.page.evaluate((expected, wa) => ({
      message: document.getElementById('saveFailureMessage').textContent,
      retry: document.getElementById('retrySaveBtn').textContent,
      pdf: document.getElementById('failPdfBtn').textContent,
      success: getComputedStyle(document.getElementById('successScreen')).display,
      opens: window.__opens.slice(),
      partial: document.body.innerText.includes('החתימה נשמרה חלקית'),
      waVisible: getComputedStyle(document.getElementById('waShareBtn')).display,
      waText: document.getElementById('waShareBtn').textContent,
      fetch: window.__fetches.filter((f) => f.url.includes('formsubmit'))[0] || null
    }), FAILURE, WA_LABEL);
    assert(failure.message === FAILURE, 'legacy failure message: ' + failure.message);
    assert(failure.retry === 'נסו שוב', 'legacy retry label');
    assert(failure.pdf.includes('PDF'), 'legacy pdf button');
    assert(failure.success === 'none', 'legacy success shown too early');
    assert(failure.opens.length === 0, 'legacy opened WhatsApp on failure');
    assert(failure.partial === false, 'misleading partial message still present');
    assert(failure.waVisible === 'none', 'WhatsApp button visible before save');
    assert(failure.waText === WA_LABEL, 'WhatsApp label');
    assert(failure.fetch && failure.fetch.keepalive === true, 'small FormSubmit body should use keepalive');
    assert(session.posts.length === 1, 'expected one failed post');
    const body = JSON.parse(session.posts[0].body);
    assert(body['שם'] === 'ישראל ישראלי', 'formsubmit name changed');
    assert(body['_captcha'] === 'false', 'formsubmit captcha field changed');
    session.setMode('ok');
    await session.page.click('#retrySaveBtn');
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('successScreen')).display !== 'none', { timeout: 20000 });
    const done = await session.page.evaluate(() => ({
      name: document.getElementById('suc_name').textContent,
      href: document.getElementById('waShareBtn').href,
      waDisplay: getComputedStyle(document.getElementById('waShareBtn')).display,
      opens: window.__opens.slice(),
      main: getComputedStyle(document.getElementById('mainContent')).display
    }));
    assert(done.name === 'ישראל ישראלי', 'success name');
    assert(done.href.startsWith('https://wa.me/972542424999'), 'wa href ' + done.href);
    assert(done.waDisplay !== 'none', 'wa button hidden after success');
    assert(done.opens.length === 0, 'WhatsApp opened without a tap');
    assert(done.main === 'none', 'form still visible after success');
    assert(session.posts.length === 2, 'retry did not post');
    return { name: 'legacy failure then retry', posts: session.posts.length, keepalive: true };
  } finally {
    await session.context.close();
  }
}

async function testLegacyAutoBackoff(browser, server) {
  const session = await boot(browser, server, { backoffMs: 400 });
  try {
    await openSigning(session.page, session.origin, 'bsd-contract-signing.html');
    await fillAndSign(session.page, { ...baseFields, f_biz: 'עסק לדוגמה', f_entity: 'חברה בע״מ' });
    await clickSubmit(session.page);
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('saveFailure')).display !== 'none', { timeout: 20000 });
    session.setMode('ok');
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('successScreen')).display !== 'none', { timeout: 20000 });
    assert(session.posts.length >= 2, 'automatic backoff did not resubmit, posts=' + session.posts.length);
    const opens = await session.page.evaluate(() => window.__opens.slice());
    assert(opens.length === 0, 'auto retry opened WhatsApp');
    return { name: 'legacy automatic backoff', posts: session.posts.length };
  } finally {
    await session.context.close();
  }
}

async function testLegacyVisibilityResume(browser, server) {
  const session = await boot(browser, server, { backoffMs: 60000 });
  try {
    await openSigning(session.page, session.origin, 'bsd-contract-signing.html');
    await fillAndSign(session.page, { ...baseFields, f_biz: 'עסק לדוגמה', f_entity: 'חברה בע״מ' });
    await clickSubmit(session.page);
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('saveFailure')).display !== 'none', { timeout: 20000 });
    const before = session.posts.length;
    session.setMode('ok');
    await session.page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('successScreen')).display !== 'none', { timeout: 20000 });
    assert(session.posts.length > before, 'visibilitychange did not resubmit');
    return { name: 'legacy visibilitychange resume', posts: session.posts.length };
  } finally {
    await session.context.close();
  }
}

async function testBuyerRealPdf(browser, server) {
  const session = await boot(browser, server, { backoffMs: 60000 });
  try {
    await openSigning(session.page, session.origin, 'bsd-contract-signing-buyer.html');
    await session.page.waitForFunction(() => window.html2canvas, { timeout: 90000 });
    await fillAndSign(session.page, baseFields);
    const started = Date.now();
    await clickSubmit(session.page);
    await session.page.waitForFunction((text) => {
      const el = document.getElementById('saveProgress');
      return el && getComputedStyle(el).display !== 'none' && document.getElementById('saveProgressText').textContent === text;
    }, { timeout: 20000 }, PROGRESS);
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('saveFailure')).display !== 'none', { timeout: 180000 });
    const pdfMs = Date.now() - started;
    const failure = await session.page.evaluate((expected) => ({
      message: document.getElementById('saveFailureMessage').textContent,
      retry: document.getElementById('retrySaveBtn').textContent.trim(),
      pdf: document.getElementById('failPdfBtn').textContent.trim(),
      opens: window.__opens.length,
      pendingMeta: localStorage.getItem('bsdPendingAgreement:buyer')
    }), FAILURE);
    assert(failure.message === FAILURE, 'buyer failure message ' + failure.message);
    assert(failure.retry === 'נסו שוב', 'buyer retry');
    assert(failure.pdf === 'הורד PDF של ההסכם', 'buyer pdf button ' + failure.pdf);
    assert(failure.opens === 0, 'buyer opened WhatsApp before confirm');
    assert(failure.pendingMeta && failure.pendingMeta.includes('"pageKey":"buyer"'), 'pending meta missing');
    const stored = await session.page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('bsd-signed-agreements', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('pending', 'readonly');
        const get = tx.objectStore('pending').get('buyer');
        get.onsuccess = () => { db.close(); resolve(get.result || null); };
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    }));
    assert(stored && stored.body && stored.body.table_name === 'leads', 'stored table');
    assert(stored.body.lead_type === 'buyer', 'stored lead type');
    assert(typeof stored.body.pdf_base64 === 'string' && stored.body.pdf_base64.startsWith('data:application/pdf'), 'pdf data uri');
    const pdfLen = stored.body.pdf_base64.length;
    assert(pdfLen < 1_800_000, 'PDF was not shrunk enough: ' + pdfLen);
    assert(pdfLen > 20_000, 'PDF looks empty: ' + pdfLen);
    const fetchInfo = await session.page.evaluate(() => window.__fetches.filter((f) => f.url.includes('complete-signed-agreement')).pop());
    assert(fetchInfo, 'missing fetch record');
    assert(fetchInfo.keepalive === (fetchInfo.len <= 60 * 1024), 'keepalive did not follow body size ' + fetchInfo.len);
    session.setMode('ok');
    await session.page.click('#retrySaveBtn');
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('successScreen')).display !== 'none', { timeout: 30000 });
    const done = await session.page.evaluate(() => ({
      href: document.getElementById('waShareBtn').href,
      text: document.getElementById('waShareBtn').textContent.trim(),
      opens: window.__opens.length,
      meta: localStorage.getItem('bsdPendingAgreement:buyer')
    }));
    assert(done.text === WA_LABEL, 'wa label after success');
    assert(done.href.includes('wa.me/972542424999'), done.href);
    assert(done.opens === 0, 'success screen opened WhatsApp by itself');
    assert(!done.meta, 'pending meta was not cleared after confirm');
    const posted = JSON.parse(session.posts[session.posts.length - 1].body);
    assert(posted.table_name === 'leads' && posted.lead_type === 'buyer', 'retry payload contract');
    assert(posted.signer_email === 'signer@example.com', 'email field');
    return { name: 'buyer real pdf failure then retry', pdfBytes: pdfLen, pdfMs, keepalive: fetchInfo.keepalive, posts: session.posts.length };
  } finally {
    await session.context.close();
  }
}

async function testReloadResume(browser, server, file, pageKey, fields, table) {
  const session = await boot(browser, server, { backoffMs: 60000 });
  try {
    await openSigning(session.page, session.origin, file);
    await session.page.evaluate(() => {
      window.buildPdfDocument = async () => {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF();
        pdf.text('BSD', 20, 20);
        return { pdf, filename: 'stub.pdf' };
      };
    });
    await fillAndSign(session.page, fields);
    await clickSubmit(session.page);
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('saveFailure')).display !== 'none', { timeout: 30000 });
    assert(session.posts.length === 1, pageKey + ' did not post before reload');
    session.setMode('ok');
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('successScreen')).display !== 'none', { timeout: 30000 });
    const href = await session.page.$eval('#waShareBtn', (el) => el.href);
    const opens = await session.page.evaluate(() => window.__opens.length);
    assert(href.includes('wa.me/972542424999'), pageKey + ' wa href after reload');
    assert(opens === 0, pageKey + ' reload opened WhatsApp');
    const posted = JSON.parse(session.posts[session.posts.length - 1].body);
    assert(posted.table_name === table, pageKey + ' table ' + posted.table_name);
    return { name: pageKey + ' reload auto-resubmit', posts: session.posts.length, table };
  } finally {
    await session.context.close();
  }
}

async function testStubRetry(browser, server, file, pageKey, fields, table) {
  const session = await boot(browser, server, { backoffMs: 60000 });
  try {
    await openSigning(session.page, session.origin, file);
    await session.page.evaluate(() => {
      window.buildPdfDocument = async () => {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF();
        pdf.text('BSD', 20, 20);
        return { pdf, filename: 'stub.pdf' };
      };
    });
    await fillAndSign(session.page, fields);
    await clickSubmit(session.page);
    await session.page.waitForFunction((text) => {
      const fail = document.getElementById('saveFailure');
      return fail && getComputedStyle(fail).display !== 'none' && document.getElementById('saveFailureMessage').textContent === text;
    }, { timeout: 30000 }, FAILURE);
    session.setMode('ok');
    await session.page.click('#retrySaveBtn');
    await session.page.waitForFunction(() => getComputedStyle(document.getElementById('successScreen')).display !== 'none', { timeout: 30000 });
    const posted = JSON.parse(session.posts[session.posts.length - 1].body);
    assert(posted.table_name === table, pageKey + ' table');
    const opens = await session.page.evaluate(() => window.__opens.length);
    assert(opens === 0, pageKey + ' opened WhatsApp');
    return { name: pageKey + ' stub failure then retry', posts: session.posts.length, table };
  } finally {
    await session.context.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
