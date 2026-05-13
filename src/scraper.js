const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { URL } = require('url');

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance && browserInstance.connected) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Fetch a page with Puppeteer, returning rich data about the page.
 * The Puppeteer page is kept open and returned as `page` so audit modules
 * can capture targeted screenshots before it's closed.
 */
async function scrapePage(url, options = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const timeout = options.timeout || 30000;

  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const resourceData = { images: [], scripts: [], stylesheets: [], fonts: [] };
  const requests = [];
  const responses = [];
  let redirectChain = [];

  page.on('request', req => {
    requests.push({ url: req.url(), type: req.resourceType(), method: req.method() });
  });

  page.on('response', resp => {
    responses.push({
      url: resp.url(),
      status: resp.status(),
      headers: resp.headers(),
      type: resp.request().resourceType()
    });
    const type = resp.request().resourceType();
    const entry = { url: resp.url(), status: resp.status(), size: parseInt(resp.headers()['content-length'] || '0', 10) };
    if (type === 'image') resourceData.images.push(entry);
    else if (type === 'script') resourceData.scripts.push(entry);
    else if (type === 'stylesheet') resourceData.stylesheets.push(entry);
    else if (type === 'font') resourceData.fonts.push(entry);
  });

  const startTime = Date.now();
  let navigationResponse;
  try {
    navigationResponse = await page.goto(url, { waitUntil: 'networkidle2', timeout });
  } catch (err) {
    await page.close();
    throw new Error(`Failed to load ${url}: ${err.message}`);
  }
  const loadTime = Date.now() - startTime;

  if (navigationResponse) {
    redirectChain = navigationResponse.request().redirectChain().map(r => ({
      url: r.url(),
      status: r.response()?.status()
    }));
  }

  const html = await page.content();
  const $ = cheerio.load(html);

  const performanceTiming = await page.evaluate(() => {
    const timing = performance.getEntriesByType('navigation')[0];
    if (!timing) return null;
    return {
      domContentLoaded: timing.domContentLoadedEventEnd - timing.startTime,
      domInteractive: timing.domInteractive - timing.startTime,
      loadComplete: timing.loadEventEnd - timing.startTime,
      ttfb: timing.responseStart - timing.startTime,
      transferSize: timing.transferSize,
      encodedBodySize: timing.encodedBodySize,
      decodedBodySize: timing.decodedBodySize
    };
  });

  const pageMetrics = await page.evaluate(() => {
    const body = document.body;
    const allElements = document.querySelectorAll('*');
    const fonts = new Set();
    const colors = new Set();
    const fontSizes = new Set();

    for (let i = 0; i < Math.min(allElements.length, 500); i++) {
      const computed = window.getComputedStyle(allElements[i]);
      fonts.add(computed.fontFamily.split(',')[0].trim().replace(/['"]/g, ''));
      colors.add(computed.color);
      colors.add(computed.backgroundColor);
      fontSizes.add(computed.fontSize);
    }

    return {
      fonts: [...fonts],
      colors: [...colors],
      fontSizes: [...fontSizes],
      viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null,
      bodyText: body?.innerText?.substring(0, 50000) || '',
      title: document.title,
      lang: document.documentElement.lang || null
    };
  });

  // Take a full-page screenshot for reference
  let fullPageScreenshot = null;
  try {
    const ssBuffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    fullPageScreenshot = Buffer.from(ssBuffer).toString('base64');
  } catch { /* non-fatal */ }

  const result = {
    url,
    html,
    $,
    page,  // Keep page open for element screenshots
    loadTime,
    performanceTiming,
    resources: resourceData,
    requests,
    responses,
    redirectChain,
    pageMetrics,
    fullPageScreenshot,
    responseHeaders: navigationResponse ? Object.fromEntries(
      Object.entries(navigationResponse.headers())
    ) : {},
    statusCode: navigationResponse?.status() || 0
  };

  // NOTE: page is NOT closed here — caller must call closePage(pageData) when done
  return result;
}

/**
 * Close the Puppeteer page after screenshots are captured
 */
async function closePage(pageData) {
  if (pageData && pageData.page && !pageData.page.isClosed()) {
    await pageData.page.close();
  }
}

/**
 * Capture a screenshot of a specific CSS selector on the live page.
 * Returns base64 JPEG string or null if element not found / error.
 */
async function screenshotElement(page, selector, options = {}) {
  try {
    const el = await page.$(selector);
    if (!el) return null;

    // Scroll element into view
    await el.scrollIntoView();
    await new Promise(r => setTimeout(r, 200));

    const ssBuffer = await el.screenshot({
      type: 'jpeg',
      quality: options.quality || 65
    });
    return Buffer.from(ssBuffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Capture a screenshot of a page region (clip area).
 * Returns base64 JPEG string or null on error.
 */
async function screenshotRegion(page, clip, options = {}) {
  try {
    const ssBuffer = await page.screenshot({
      type: 'jpeg',
      quality: options.quality || 65,
      clip
    });
    return Buffer.from(ssBuffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Capture above-the-fold screenshot (first viewport).
 */
async function screenshotAboveFold(page) {
  try {
    // Scroll to top first
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 300));
    const ssBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 65,
      clip: { x: 0, y: 0, width: 1440, height: 900 }
    });
    return Buffer.from(ssBuffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Capture multiple elements matching a selector (max N).
 * Returns array of { selector, index, base64 }.
 */
async function screenshotElements(page, selector, maxCount = 3) {
  const results = [];
  try {
    const elements = await page.$$(selector);
    for (let i = 0; i < Math.min(elements.length, maxCount); i++) {
      try {
        await elements[i].scrollIntoView();
        await new Promise(r => setTimeout(r, 150));
        const ssBuffer = await elements[i].screenshot({ type: 'jpeg', quality: 60 });
        results.push({
          index: i,
          base64: Buffer.from(ssBuffer).toString('base64')
        });
      } catch { /* skip this element */ }
    }
  } catch { /* non-fatal */ }
  return results;
}

/**
 * Quick HTTP HEAD/GET check for a URL — returns status code
 */
function checkUrl(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(targetUrl, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        resolve({ url: targetUrl, status: res.statusCode, ok: res.statusCode < 400 });
      });
      req.on('error', () => resolve({ url: targetUrl, status: 0, ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ url: targetUrl, status: 0, ok: false }); });
      req.end();
    } catch {
      resolve({ url: targetUrl, status: 0, ok: false });
    }
  });
}

/**
 * Crawl links from a page up to a given depth
 */
async function crawlLinks(baseUrl, $, depth = 1) {
  const base = new URL(baseUrl);
  const links = new Set();
  const internal = [];
  const external = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const resolved = new URL(href, baseUrl);
      const link = resolved.origin + resolved.pathname;
      if (!links.has(link)) {
        links.add(link);
        if (resolved.hostname === base.hostname) {
          internal.push(link);
        } else {
          external.push(link);
        }
      }
    } catch { /* skip malformed */ }
  });

  const allLinks = [...internal, ...external].slice(0, 100);
  const results = [];
  const batchSize = 10;
  for (let i = 0; i < allLinks.length; i += batchSize) {
    const batch = allLinks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(l => checkUrl(l)));
    results.push(...batchResults);
  }

  const broken = results.filter(r => !r.ok);

  return { internal, external, broken, allChecked: results };
}

module.exports = {
  scrapePage, closePage, closeBrowser, checkUrl, crawlLinks, getBrowser,
  screenshotElement, screenshotRegion, screenshotAboveFold, screenshotElements
};
