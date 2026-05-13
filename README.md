# Website Audit Tool

A comprehensive website audit tool that analyzes sites across 10 modules — heuristics, UX, UI, performance, SEO, content, technical, CRO, security, and competitor benchmarking — with AI-powered analysis and professional PDF/HTML report export.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure API keys

Copy the example env file and add your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...    # Required — powers AI heuristic analysis
PAGESPEED_API_KEY=               # Optional — enables Core Web Vitals data
PORT=3000                        # Optional — default 3000
```

### 3. Run

```bash
npm start
```

The app opens automatically in your default browser at `http://localhost:3000`.

## Audit Modules

| Module | What it checks |
|--------|---------------|
| **Nielsen's Heuristics** | AI + rule-based evaluation against all 10 Nielsen Norman heuristics |
| **UX** | Navigation, CTAs, mobile viewport, accessibility (alt text, ARIA, keyboard nav) |
| **UI / Visual Design** | Typography, color palette, contrast (WCAG), heading hierarchy, image quality |
| **Performance** | Load time, TTFB, resource counts, lazy loading, PageSpeed Insights (optional) |
| **SEO** | Meta tags, OG tags, heading structure, sitemap, robots.txt, broken links, structured data |
| **Content** | Word count, Flesch-Kincaid readability, CTA language, content density |
| **Technical** | Broken links, HTTPS redirects, redirect chains, schema markup, charset, favicon |
| **CRO** | CTA analysis, form usability, trust signals, funnel clarity |
| **Security** | HTTPS/SSL, security headers (CSP, HSTS, X-Frame-Options), mixed content, outdated libraries |
| **Competitor** | Side-by-side comparison of performance, SEO, and security scores |

## Features

- Real-time progress indicators via Server-Sent Events
- Overall score (0-100) with weighted module scores
- Severity badges (Critical / Warning / Good) per finding
- Collapsible report sections
- Executive summary with top 5 priority fixes
- Export as styled PDF or standalone HTML
- Optional competitor benchmarking (up to 2 URLs)

## Tech Stack

- **Backend**: Node.js + Express
- **Scraping**: Puppeteer (headless Chrome) + Cheerio
- **AI Analysis**: Anthropic Claude API
- **Performance**: Google PageSpeed Insights API (optional)
- **PDF Export**: Puppeteer PDF rendering
- **Frontend**: Vanilla HTML/CSS/JS
