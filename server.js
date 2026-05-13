require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { runAudit } = require('./src/auditor');
const { generateHTML } = require('./src/report');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory audit store
const audits = new Map();

// Start an audit
app.post('/api/audit', (req, res) => {
  const { url, competitors } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const id = uuidv4();
  const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;

  audits.set(id, {
    id,
    url: normalizedUrl,
    competitors: competitors || [],
    status: 'running',
    progress: [],
    result: null,
    error: null,
    sseClients: []
  });

  // Run audit in background
  runAudit(normalizedUrl, competitors || [], (event) => {
    const audit = audits.get(id);
    if (!audit) return;
    audit.progress.push(event);
    // Notify SSE clients
    for (const client of audit.sseClients) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }).then(result => {
    const audit = audits.get(id);
    if (audit) {
      audit.status = 'complete';
      audit.result = result;
      for (const client of audit.sseClients) {
        client.write(`data: ${JSON.stringify({ type: 'complete', result })}\n\n`);
        client.end();
      }
      audit.sseClients = [];
    }
  }).catch(err => {
    const audit = audits.get(id);
    if (audit) {
      audit.status = 'error';
      audit.error = err.message;
      for (const client of audit.sseClients) {
        client.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        client.end();
      }
      audit.sseClients = [];
    }
  });

  res.json({ id });
});

// SSE progress stream
app.get('/api/audit/:id/progress', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send existing progress
  for (const event of audit.progress) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (audit.status === 'complete') {
    res.write(`data: ${JSON.stringify({ type: 'complete', result: audit.result })}\n\n`);
    return res.end();
  }
  if (audit.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: audit.error })}\n\n`);
    return res.end();
  }

  audit.sseClients.push(res);
  req.on('close', () => {
    audit.sseClients = audit.sseClients.filter(c => c !== res);
  });
});

// Get report
app.get('/api/audit/:id/report', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.status !== 'complete') return res.status(202).json({ status: audit.status });
  res.json(audit.result);
});

// Export PDF — render the HTML report as a real PDF using Puppeteer
app.get('/api/audit/:id/export/pdf', async (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit || audit.status !== 'complete') {
    return res.status(404).json({ error: 'Report not ready' });
  }
  try {
    const puppeteer = require('puppeteer');
    const html = generateHTML(audit.result);
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Expand all collapsed sections so full report is visible in the PDF
    await page.evaluate(() => {
      document.querySelectorAll('.module-section.collapsed').forEach(el => el.classList.remove('collapsed'));
    });
    await new Promise(r => setTimeout(r, 1000));

    // Measure the full content height so the PDF becomes a single tall page (no A4 breaks)
    const { height, width } = await page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      return {
        height: Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight),
        width: Math.max(body.scrollWidth, html.scrollWidth, 1440)
      };
    });

    const pdf = await page.pdf({
      printBackground: true,
      width: `${width}px`,
      height: `${height + 40}px`,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      preferCSSPageSize: false
    });
    await page.close();
    await browser.close();

    const pdfBuffer = Buffer.from(pdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="audit-report-${Date.now()}.pdf"`);
    res.end(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// Export HTML
app.get('/api/audit/:id/export/html', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit || audit.status !== 'complete') {
    return res.status(404).json({ error: 'Report not ready' });
  }
  const html = generateHTML(audit.result);
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="audit-report-${Date.now()}.html"`);
  res.send(html);
});

// Export full-page screenshot as JPEG
app.get('/api/audit/:id/export/screenshot', async (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit || audit.status !== 'complete') {
    return res.status(404).json({ error: 'Report not ready' });
  }
  try {
    const puppeteer = require('puppeteer');
    const html = generateHTML(audit.result);
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Expand all collapsed sections so full report is visible
    await page.evaluate(() => {
      document.querySelectorAll('.module-section.collapsed').forEach(el => el.classList.remove('collapsed'));
    });
    await new Promise(r => setTimeout(r, 800));
    const screenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 90 });
    await page.close();
    await browser.close();
    const buf = Buffer.from(screenshot);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', `attachment; filename="audit-report-${Date.now()}.jpg"`);
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: 'Screenshot failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Website Audit Tool running at http://localhost:${PORT}\n`);
  // Auto-open browser
  const opener = process.platform === 'win32' ? 'start' :
    process.platform === 'darwin' ? 'open' : 'xdg-open';
  require('child_process').exec(`${opener} http://localhost:${PORT}`);
});
