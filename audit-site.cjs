#!/usr/bin/env node
/**
 * Redbank III — end-to-end site audit.
 * Serves dist/ and drives it with Puppeteer across three viewports.
 * Reports: console/page errors, failed requests, broken images, dead links,
 * broken anchors, horizontal overflow, element overlap, i18n leakage, a11y basics.
 */
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const PORT = 8911;
const PAGES = ['/zh/', '/en/', '/fr/'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
  { name: 'tablet', width: 1024, height: 768, isMobile: false },
  { name: 'half', width: 1100, height: 900, isMobile: false }, // the 900–1400 gap
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};

const findings = [];
const add = (sev, page, viewport, kind, detail) =>
  findings.push({ sev, page, viewport, kind, detail });

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const fp = path.join(DIST, p);
      if (!fp.startsWith(DIST) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function auditPage(browser, pagePath, vp) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile, hasTouch: vp.isMobile });

  const consoleErrors = [], failedReqs = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', (r) => {
    const u = r.url();
    // Google Fonts is offline-unreachable in this harness; not a site defect.
    if (!u.includes('fonts.googleapis') && !u.includes('fonts.gstatic')) {
      failedReqs.push(`${u} — ${r.failure()?.errorText}`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(`http://localhost:${PORT}`)) {
      failedReqs.push(`${r.url()} — HTTP ${r.status()}`);
    }
  });

  await page.goto(`http://localhost:${PORT}${pagePath}`, { waitUntil: 'networkidle2', timeout: 60000 });
  // let IntersectionObserver fade-ins settle
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 400));

  consoleErrors.forEach((e) => add('high', pagePath, vp.name, 'console-error', e));
  [...new Set(failedReqs)].forEach((e) => add('high', pagePath, vp.name, 'failed-request', e));

  const res = await page.evaluate(() => {
    const out = {
      overflow: null, brokenImages: [], noAlt: [], deadLinks: [], badAnchors: [],
      dupIds: [], overlaps: [], emptyButtons: [], headings: [], lang: document.documentElement.lang,
      title: document.title, desc: document.querySelector('meta[name=description]')?.content || '',
      externals: [], hiddenNav: null, tinyTap: [],
    };
    // horizontal overflow
    const de = document.documentElement;
    if (de.scrollWidth > window.innerWidth + 1) {
      const offenders = [...document.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > window.innerWidth + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed';
      }).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
      out.overflow = { scrollWidth: de.scrollWidth, inner: window.innerWidth, offenders };
    }
    // images
    document.querySelectorAll('img').forEach((img) => {
      if (img.complete && img.naturalWidth === 0) out.brokenImages.push(img.getAttribute('src'));
      if (!img.hasAttribute('alt')) out.noAlt.push(img.getAttribute('src'));
    });
    // links
    const ids = new Set([...document.querySelectorAll('[id]')].map((e) => e.id));
    document.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (h === '#' || h === '') out.deadLinks.push(a.textContent.trim().slice(0, 40));
      else if (h.startsWith('#') && !ids.has(h.slice(1))) out.badAnchors.push(`${h} ← "${a.textContent.trim().slice(0, 30)}"`);
      else if (/^https?:\/\//.test(h)) out.externals.push(h);
    });
    // duplicate ids
    const seen = {};
    [...document.querySelectorAll('[id]')].forEach((e) => { seen[e.id] = (seen[e.id] || 0) + 1; });
    out.dupIds = Object.entries(seen).filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
    // buttons without accessible name
    document.querySelectorAll('button').forEach((b) => {
      if (!b.textContent.trim() && !b.getAttribute('aria-label')) out.emptyButtons.push(b.outerHTML.slice(0, 60));
    });
    // heading order
    out.headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => +h.tagName[1]);
    // nav overlap: any two nav children whose boxes intersect
    const navEls = [...document.querySelectorAll('.nav-inner > *, .nav-links > a, .lang-switcher')];
    for (let i = 0; i < navEls.length; i++) {
      for (let j = i + 1; j < navEls.length; j++) {
        const a = navEls[i].getBoundingClientRect(), b = navEls[j].getBoundingClientRect();
        if (a.width && b.width && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) {
          if (!navEls[i].contains(navEls[j]) && !navEls[j].contains(navEls[i])) {
            out.overlaps.push(`${navEls[i].className || navEls[i].tagName} ↔ ${navEls[j].className || navEls[j].tagName}`);
          }
        }
      }
    }
    // tap target size on mobile
    if (window.innerWidth < 500) {
      document.querySelectorAll('a,button').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24)) {
          out.tinyTap.push(`${el.textContent.trim().slice(0, 20)} (${Math.round(r.width)}×${Math.round(r.height)})`);
        }
      });
    }
    return out;
  });

  if (res.overflow) add('high', pagePath, vp.name, 'h-overflow',
    `scrollWidth ${res.overflow.scrollWidth} > viewport ${res.overflow.inner}; offenders: ${res.overflow.offenders.join(', ')}`);
  res.brokenImages.forEach((s) => add('high', pagePath, vp.name, 'broken-image', s));
  res.noAlt.forEach((s) => add('med', pagePath, vp.name, 'img-no-alt', s));
  [...new Set(res.deadLinks)].forEach((s) => add('med', pagePath, vp.name, 'dead-link', `href="#" on "${s}"`));
  [...new Set(res.badAnchors)].forEach((s) => add('high', pagePath, vp.name, 'broken-anchor', s));
  res.dupIds.forEach((s) => add('med', pagePath, vp.name, 'duplicate-id', s));
  res.emptyButtons.forEach((s) => add('med', pagePath, vp.name, 'button-no-name', s));
  [...new Set(res.overlaps)].forEach((s) => add('high', pagePath, vp.name, 'nav-overlap', s));
  [...new Set(res.tinyTap)].forEach((s) => add('low', pagePath, vp.name, 'tiny-tap-target', s));

  // heading hierarchy jumps
  for (let i = 1; i < res.headings.length; i++) {
    if (res.headings[i] - res.headings[i - 1] > 1) {
      add('low', pagePath, vp.name, 'heading-jump', `h${res.headings[i - 1]} → h${res.headings[i]}`);
      break;
    }
  }

  // i18n: CJK leaking into en/fr pages
  if (pagePath !== '/zh/') {
    const leaks = await page.evaluate(() => {
      const cjk = /[一-鿿]/;
      // Intentional by design, not leakage:
      //  - `.section-eyebrow` is a bilingual motif used on every locale ("MISSION · 使命")
      //  - the brand name itself, and the 红岸基地 gloss in the Three-Body story paragraph
      //  - the language switcher's own labels
      const BRAND = /^(红岸三号|红岸|红岸基地|Redbank)$/;
      const out = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walk.nextNode())) {
        const t = n.textContent.trim();
        if (!t || !cjk.test(t)) continue;
        const p = n.parentElement;
        if (p.closest('.lang-switcher') || p.closest('.section-eyebrow')) continue;
        // a parenthetical gloss of the brand inside otherwise-Latin prose is fine
        const stripped = t.replace(/[（(]?(红岸三号|红岸基地|红岸)[）)]?/g, '').trim();
        if (!cjk.test(stripped) || BRAND.test(t)) continue;
        out.push({ text: t.slice(0, 70), el: p.tagName.toLowerCase() + '.' + (p.className || '').toString().split(' ')[0] });
      }
      return out;
    });
    leaks.forEach((l) => add('high', pagePath, vp.name, 'cjk-leak', `${l.el}: "${l.text}"`));
    const brandOnly = (s) => !/[一-鿿]/.test(s.replace(/红岸三号|红岸基地|红岸/g, ''));
    if (/[一-鿿]/.test(res.title) && !brandOnly(res.title)) add('high', pagePath, vp.name, 'cjk-leak-title', res.title);
    if (/[一-鿿]/.test(res.desc) && !brandOnly(res.desc)) add('high', pagePath, vp.name, 'cjk-leak-desc', res.desc);
  }

  // lang attribute
  const want = pagePath.replace(/\//g, '');
  if (res.lang !== want) add('med', pagePath, vp.name, 'html-lang', `got "${res.lang}", want "${want}"`);

  // mobile nav toggle behaviour
  if (vp.isMobile) {
    const nav = await page.evaluate(() => {
      const t = document.getElementById('nav-toggle');
      const l = document.getElementById('nav-links');
      if (!t || !l) return { missing: true };
      const visBefore = getComputedStyle(l).display !== 'none' && l.getBoundingClientRect().height > 0;
      t.click();
      const openCls = l.classList.contains('open');
      const visAfter = getComputedStyle(l).display !== 'none' && l.getBoundingClientRect().height > 0;
      const aria = t.getAttribute('aria-expanded');
      t.click();
      return { missing: false, visBefore, openCls, visAfter, aria };
    });
    if (nav.missing) add('high', pagePath, vp.name, 'nav-toggle-missing', 'no #nav-toggle / #nav-links');
    else if (!nav.visAfter) add('high', pagePath, vp.name, 'nav-toggle-broken', `click did not reveal menu (open=${nav.openCls}, aria=${nav.aria})`);
    else if (nav.aria !== 'true') add('med', pagePath, vp.name, 'nav-aria', `aria-expanded="${nav.aria}" after open`);
  }

  await page.close();
  return res.externals;
}

(async () => {
  if (!fs.existsSync(DIST)) { console.error('dist/ missing — run `npm run build` first'); process.exit(2); }
  const server = await serve();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const allExternals = new Set();

  for (const p of PAGES) {
    for (const vp of VIEWPORTS) {
      try {
        const ext = await auditPage(browser, p, vp);
        ext.forEach((u) => allExternals.add(u));
      } catch (e) {
        add('high', p, vp.name, 'audit-crash', e.message);
      }
    }
  }

  // root redirect
  try {
    const page = await browser.newPage();
    const r = await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    const delay = (html.match(/http-equiv="refresh" content="(\d+)/i) || [])[1];
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    const final = page.url();
    // the root picks a locale from navigator.languages, so any of the three is correct
    if (!/\/(zh|en|fr)\/$/.test(final)) add('high', '/', '-', 'root-redirect', `landed on ${final} (status ${r.status()})`);
    if (delay && +delay > 0) add('high', '/', '-', 'root-redirect-delay', `meta refresh waits ${delay}s before moving`);
    await page.close();
  } catch (e) { add('high', '/', '-', 'root-redirect', e.message); }

  await browser.close();
  server.close();

  fs.writeFileSync(path.join(__dirname, 'e2e-externals.txt'), [...allExternals].sort().join('\n'));

  // ---- report ----
  const order = { high: 0, med: 1, low: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev] || a.kind.localeCompare(b.kind));
  // collapse identical findings across viewports
  const grouped = {};
  for (const f of findings) {
    const k = `${f.sev}|${f.kind}|${f.page}|${f.detail}`;
    (grouped[k] = grouped[k] || { ...f, vps: [] }).vps.push(f.viewport);
  }
  const rows = Object.values(grouped);
  console.log(`\n=== ${rows.length} distinct findings (${findings.length} raw) ===\n`);
  for (const f of rows) {
    console.log(`[${f.sev.toUpperCase()}] ${f.kind}  ${f.page}  (${[...new Set(f.vps)].join(',')})`);
    console.log(`    ${f.detail}`);
  }
  const counts = rows.reduce((a, f) => ((a[f.sev] = (a[f.sev] || 0) + 1), a), {});
  console.log(`\nSUMMARY high=${counts.high || 0} med=${counts.med || 0} low=${counts.low || 0}`);
  console.log(`external URLs collected: ${allExternals.size} → e2e-externals.txt`);
})();
