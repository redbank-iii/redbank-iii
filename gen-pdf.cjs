// Generate PDF for one locale using Puppeteer — waits for full render, then prints.
const puppeteer = require('puppeteer');

(async () => {
  const lang = process.argv[2] || 'zh';
  const out = `redbank-iii-${lang}.pdf`;
  const url = `http://127.0.0.1:8934/${lang}/`;

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // Set a large viewport so the layout doesn't collapse into mobile
  await page.setViewport({ width: 1400, height: 2000, deviceScaleFactor: 2 });

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  // Force all lazy images to load (they're below the fold so lazy-load
  // never triggers during print). Scroll through the page first.
  await page.evaluate(async () => {
    // eagerly load every image
    document.querySelectorAll('img[loading="lazy"]').forEach(img => {
      img.loading = 'eager';
      // force a re-fetch by touching src
      const src = img.getAttribute('src');
      if (src) img.src = src;
    });
    // scroll to bottom then top to trigger any lazy loading
    await new Promise(r => {
      let y = 0;
      const step = () => {
        y += window.innerHeight;
        window.scrollTo(0, y);
        if (y < document.body.scrollHeight) setTimeout(step, 100);
        else { window.scrollTo(0, 0); setTimeout(r, 300); }
      };
      step();
    });
  });

  // wait for all images to be complete
  await page.waitForFunction(
    () => Array.from(document.images).every(img => img.complete && img.naturalWidth > 0),
    { timeout: 15000 }
  ).catch(() => console.log('warn: some images may not have loaded'));

  // Let animations settle
  await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));

  // Freeze the canvas animation: replace the live <canvas> with a static
  // snapshot (data-URL <img>) so Skia print actually rasterizes the dark
  // starfield background instead of dropping the GPU canvas layer.
  await page.evaluate(() => {
    const canvas = document.getElementById('starfield');
    if (canvas) {
      try {
        const url = canvas.toDataURL('image/png');
        const img = document.createElement('img');
        img.src = url;
        img.style.cssText = 'width:100%;height:100%;display:block;object-fit:cover;';
        canvas.parentNode.replaceChild(img, canvas);
      } catch (e) {
        // canvas tainted or empty — fall back to solid dark bg
        canvas.parentNode.style.background = '#0a0e1a';
      }
    }
  });

  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', right: '16mm', bottom: '20mm', left: '16mm' },
  });

  console.log(`✓ ${out}`);
  await browser.close();
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
