const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');

const ROOT = path.join(__dirname, '..');

const CONFIG_FILE = 'pa11yci.json';
const URLS_FILE = 'urls.txt';
const REPORTS_DIR = path.join(ROOT, 'reports');
const SITEMAP_URL = process.env.SITEMAP_URL || '';
const SKIP_VISUALS = process.env.SKIP_VISUALS === 'true';
const WCAG_STANDARDS = (process.env.WCAG_STANDARDS || 'WCAG2AA')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

async function loadUrlsFromSitemap(sitemapUrl) {
  try {
    console.log(`Fetching sitemap from: ${sitemapUrl}`);
    const response = await axios.get(sitemapUrl);
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    const urls = [];

    if (result.sitemapurlset && result.sitemapurlset.url) {
      result.sitemapurlset.url.forEach(entry => {
        if (entry.loc && entry.loc[0]) urls.push(entry.loc[0]);
      });
    } else if (result.urlset && result.urlset.url) {
      result.urlset.url.forEach(entry => {
        if (entry.loc && entry.loc[0]) urls.push(entry.loc[0]);
      });
    }

    console.log(`Found ${urls.length} URLs from sitemap`);
    return urls;
  } catch (error) {
    console.error(`Error fetching sitemap: ${error.message}`);
    return [];
  }
}

function loadUrlsFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (error) {
    console.error(`Error reading URLs file: ${error.message}`);
    return [];
  }
}

function mergeUrls(urlsFromFile, urlsFromSitemap) {
  return [...new Set([...urlsFromFile, ...urlsFromSitemap])];
}

function buildConfig(urls, standard) {
  const configPath = path.join(ROOT, CONFIG_FILE);
  let base = {};
  if (fs.existsSync(configPath)) {
    base = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  const config = JSON.parse(JSON.stringify(base));
  config.defaults = config.defaults || {};
  config.defaults.standard = standard;
  config.urls = urls;
  return config;
}

function getChromeArgs() {
  const configPath = path.join(ROOT, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.defaults?.chromeLaunchConfig?.args || [];
    } catch (e) { /* ignore */ }
  }
  return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
}

function urlToFilename(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 16) + '.jpg';
}

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function generateReportFilename() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `wcag-report-${timestamp}`;
}

async function runScanForStandard(standard, urls) {
  const tempConfigName = `pa11yci-${standard}.json`;
  const tempConfigPath = path.join(ROOT, tempConfigName);
  const config = buildConfig(urls, standard);
  fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

  try {
    return await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const child = spawn('npx', ['pa11y-ci', '-c', tempConfigName, '--reporter', 'json'], {
        cwd: ROOT,
        shell: true
      });

      let stdout = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(text);
      });

      child.stderr.on('data', (data) => {
        process.stderr.write(data.toString());
      });

      child.on('close', () => {
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*"results"[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : stdout);
          Object.values(parsed.results || {}).forEach(issues => {
            if (Array.isArray(issues)) {
              issues.forEach(issue => { issue.standard = standard; });
            }
          });
          resolve(parsed);
        } catch (e) {
          resolve({ results: {}, passes: 0, errors: 0 });
        }
      });

      child.on('error', reject);
    });
  } finally {
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }
  }
}

async function capturePageVisuals(url, issues, screenshotsDir) {
  const puppeteer = require('puppeteer');
  const chromeArgs = getChromeArgs();
  let browser;

  try {
    browser = await puppeteer.launch({ headless: true, args: chromeArgs });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    const dims = await page.evaluate(() => ({
      pageWidth: Math.max(
        document.documentElement.scrollWidth,
        (document.body || {}).scrollWidth || 0
      ),
      pageHeight: Math.max(
        document.documentElement.scrollHeight,
        (document.body || {}).scrollHeight || 0
      )
    }));

    // Collect unique selectors and resolve all bounding boxes in one evaluate call
    const uniqueSelectors = [...new Set(issues.map(i => i.selector).filter(Boolean))];
    const rectMap = await page.evaluate((selectors) => {
      const result = {};
      selectors.forEach(sel => {
        try {
          const el = document.querySelector(sel);
          if (!el) { result[sel] = null; return; }
          const r = el.getBoundingClientRect();
          result[sel] = {
            x: Math.round(r.left + window.scrollX),
            y: Math.round(r.top + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height)
          };
        } catch (e) {
          result[sel] = null;
        }
      });
      return result;
    }, uniqueSelectors);

    issues.forEach(issue => {
      issue.rect = issue.selector ? (rectMap[issue.selector] || null) : null;
    });

    const screenshotFile = urlToFilename(url);
    const screenshotPath = path.join(screenshotsDir, screenshotFile);
    await page.screenshot({ path: screenshotPath, fullPage: true, type: 'jpeg', quality: 80 });

    return { screenshotFile, pageWidth: dims.pageWidth, pageHeight: dims.pageHeight };
  } catch (error) {
    console.error('  Visual capture failed for ' + url + ': ' + error.message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function runScan() {
  console.log('=== WCAG Compliance Scanner ===\n');
  console.log(`Standards: ${WCAG_STANDARDS.join(', ')}\n`);

  const startTime = new Date();

  // First-run: if urls.txt doesn't exist, create it from the template
  const urlsFilePath    = path.join(ROOT, URLS_FILE);
  const urlsExamplePath = path.join(ROOT, 'urls.example.txt');
  if (!fs.existsSync(urlsFilePath) && fs.existsSync(urlsExamplePath)) {
    fs.copyFileSync(urlsExamplePath, urlsFilePath);
    console.log('\n  No urls.txt found — created one from the template.');
    console.log('  \u279c Open urls.txt, replace the example URLs with your own, then run again.\n');
    process.exit(0);
  }

  let urlsFromFile = loadUrlsFromFile(path.join(ROOT, URLS_FILE));
  let urlsFromSitemap = [];

  if (SITEMAP_URL) {
    urlsFromSitemap = await loadUrlsFromSitemap(SITEMAP_URL);
  }

  const allUrls = mergeUrls(urlsFromFile, urlsFromSitemap);

  if (allUrls.length === 0) {
    console.error('No URLs to scan. Add URLs to urls.txt or set SITEMAP_URL environment variable.');
    process.exit(1);
  }

  console.log(`Total URLs to scan: ${allUrls.length}`);
  console.log(`Running ${WCAG_STANDARDS.length} standard(s)...\n`);

  ensureReportsDir();

  const mergedResults = {
    results: {},
    passes: 0,
    errors: 0,
    standards: WCAG_STANDARDS
  };

  for (const standard of WCAG_STANDARDS) {
    console.log(`\n--- Scanning standard: ${standard} ---\n`);
    const scanResults = await runScanForStandard(standard, allUrls);

    Object.entries(scanResults.results || {}).forEach(([url, issues]) => {
      if (!mergedResults.results[url]) mergedResults.results[url] = [];
      if (Array.isArray(issues)) mergedResults.results[url].push(...issues);
    });

    mergedResults.passes += scanResults.passes || 0;
    mergedResults.errors += scanResults.errors || 0;
  }

  // Visual capture pass
  if (!SKIP_VISUALS) {
    const screenshotsDir = path.join(REPORTS_DIR, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const urlsWithIssues = Object.entries(mergedResults.results)
      .filter(([, issues]) => Array.isArray(issues) && issues.length > 0)
      .map(([url]) => url);

    if (urlsWithIssues.length > 0) {
      console.log('\n--- Capturing visual data ---\n');
      const visuals = {};
      for (const url of urlsWithIssues) {
        console.log('  Capturing: ' + url);
        const result = await capturePageVisuals(url, mergedResults.results[url], screenshotsDir);
        if (result) visuals[url] = result;
      }
      mergedResults.visuals = visuals;
    }
  }

  // Auto-diff against previous report
  let prevDiff = null;
  const existingReports = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter(f => /^wcag-report-.*\.json$/.test(f)).sort().reverse()
    : [];
  if (existingReports.length > 0) {
    try {
      const prevPath = path.join(REPORTS_DIR, existingReports[0]);
      const prevReport = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));
      const { compareReports } = require('./diff.js');
      const comparison = compareReports(prevReport, mergedResults);
      prevDiff = { ...comparison, previousFilename: existingReports[0] };
      console.log(`\nAuto-diff vs ${existingReports[0]}: +${prevDiff.newIssues.length} new, -${prevDiff.resolvedIssues.length} resolved`);
    } catch (e) {
      console.warn('Could not compute auto-diff:', e.message);
    }
  }

  const reportFilename = generateReportFilename();
  const reportPath = path.join(REPORTS_DIR, `${reportFilename}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(mergedResults, null, 2));
  console.log(`\nScan complete! Results saved to: ${reportPath}`);

  const htmlReportPath = path.join(REPORTS_DIR, `${reportFilename}.html`);
  generateHtmlReport(reportPath, htmlReportPath, prevDiff);

  const endTime = new Date();
  const duration = Math.round((endTime - startTime) / 1000);
  console.log(`Total scan time: ${duration} seconds`);
  console.log(`HTML Report: ${htmlReportPath}`);
}

function generateHtmlReport(jsonPath, htmlPath, prevDiff = null) {
  let results = { results: {}, passes: 0, errors: 0, standards: ['WCAG2AA'], visuals: {} };

  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    results = JSON.parse(content);
  } catch (error) {
    console.error(`Error reading results: ${error.message}`);
    return;
  }

  const standards = results.standards || ['WCAG2AA'];
  const multiStandard = standards.length > 1;
  const visuals = results.visuals || {};

  const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const pagesWithIssues = new Set();
  const allIssues = [];

  Object.entries(results.results).forEach(([url, pageIssues]) => {
    if (pageIssues && pageIssues.length > 0) {
      pagesWithIssues.add(url);
      pageIssues.forEach(issue => {
        const impact = issue.runnerExtras?.impact || 'minor';
        impactCounts[impact] = (impactCounts[impact] || 0) + 1;
        allIssues.push({
          pageUrl: url,
          code: issue.code,
          impact,
          message: issue.message || '',
          runner: issue.runner,
          standard: issue.standard || standards[0],
          wcagTags: issue.runnerExtras?.description || '',
          helpUrl: issue.runnerExtras?.helpUrl || '',
          selector: issue.selector || '',
          context: issue.context || '',
          rect: issue.rect || null
        });
      });
    }
  });

  const totalPages = Object.keys(results.results).length;
  const pagesPassed = totalPages - pagesWithIssues.size;
  const totalIssueCount = Object.values(impactCounts).reduce((a, b) => a + b, 0);
  const reportTitle = 'WCAG Compliance Report \u2014 ' + standards.join(', ');

  const standardColors = {
    WCAG2A:    { bg: '#e8f5e9', fg: '#2e7d32' },
    WCAG2AA:   { bg: '#e3f2fd', fg: '#1565c0' },
    WCAG2AAA:  { bg: '#f3e5f5', fg: '#6a1b9a' },
    SECTION508:{ bg: '#fff3e0', fg: '#e65100' }
  };

  function stdStyle(std) {
    const c = standardColors[std] || { bg: '#f5f5f5', fg: '#616161' };
    return 'background:' + c.bg + ';color:' + c.fg;
  }

  // Escape for safe HTML insertion in table cells
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Auto-diff section ──────────────────────────────────────────
  const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

  function buildDiffTable(issues, maxRows) {
    const rows = issues.slice(0, maxRows);
    if (rows.length === 0) return '<p style="color:#888;padding:8px 0;margin:0">None.</p>';
    const more = issues.length > maxRows
      ? `<tr><td colspan="4" style="color:#888;font-style:italic;padding:8px 14px">… and ${issues.length - maxRows} more</td></tr>`
      : '';
    return `<table class="diff-mini-table">
      <thead><tr><th>Page</th><th>Rule</th><th>Impact</th><th>Description</th></tr></thead>
      <tbody>
        ${rows.map(issue => {
          const impact = issue.runnerExtras?.impact || 'minor';
          let pagePath;
          try { pagePath = new URL(issue.pageUrl).pathname || issue.pageUrl; } catch (e) { pagePath = issue.pageUrl; }
          return `<tr>
            <td><a href="${esc(issue.pageUrl)}" target="_blank" rel="noopener">${esc(pagePath)}</a></td>
            <td><code class="issue-code">${esc(issue.code)}</code></td>
            <td><span class="impact-badge impact-${impact}">${impact}</span></td>
            <td style="font-size:13px;color:#444">${esc((issue.message || '').split('(http')[0].trim())}</td>
          </tr>`;
        }).join('')}
        ${more}
      </tbody>
    </table>`;
  }

  let diffSectionHtml = '';
  if (prevDiff) {
    const sortByImpact = arr => [...arr].sort((a, b) =>
      (IMPACT_ORDER[a.runnerExtras?.impact || 'minor'] ?? 3) -
      (IMPACT_ORDER[b.runnerExtras?.impact || 'minor'] ?? 3)
    );
    const newSorted  = sortByImpact(prevDiff.newIssues);
    const resSorted  = sortByImpact(prevDiff.resolvedIssues);

    diffSectionHtml = `
    <div class="diff-section">
      <div class="diff-header">
        <h2 style="margin:0">Changes Since Last Scan</h2>
        <span class="diff-compared">vs <code>${esc(prevDiff.previousFilename)}</code></span>
      </div>
      <div class="diff-chips">
        <span class="diff-chip diff-chip-new">&#x25B2; ${prevDiff.newIssues.length} New</span>
        <span class="diff-chip diff-chip-resolved">&#x25BC; ${prevDiff.resolvedIssues.length} Resolved</span>
        <span class="diff-chip diff-chip-persisting">&#x2192; ${prevDiff.persistingIssues.length} Persisting</span>
      </div>
      ${prevDiff.newIssues.length > 0 ? `
      <details open>
        <summary class="diff-summary">New Issues (${prevDiff.newIssues.length})</summary>
        ${buildDiffTable(newSorted, 20)}
      </details>` : ''}
      ${prevDiff.resolvedIssues.length > 0 ? `
      <details>
        <summary class="diff-summary">Resolved Issues (${prevDiff.resolvedIssues.length})</summary>
        ${buildDiffTable(resSorted, 20)}
      </details>` : ''}
      ${prevDiff.newIssues.length === 0 && prevDiff.resolvedIssues.length === 0 ? `
      <p style="color:#388e3c;font-weight:600;margin:0">&#x2713; No changes from previous scan.</p>` : ''}
    </div>`;
  }

  // Serialize data for embedding — guard against </script> in values
  const issuesJson = JSON.stringify(allIssues).replace(/<\/script>/gi, '<\\/script>');
  const visualsJson = JSON.stringify(visuals).replace(/<\/script>/gi, '<\\/script>');

  // Build table rows
  const tableRows = allIssues.map((issue, idx) => {
    let pagePath;
    try { pagePath = new URL(issue.pageUrl).pathname || issue.pageUrl; } catch (e) { pagePath = issue.pageUrl; }
    const shortMsg = issue.message.split('(http')[0].trim();
    return `
        <tr class="issue-row" data-index="${idx}" data-impact="${issue.impact}">
          <td><a href="${esc(issue.pageUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(pagePath)}</a></td>
          <td><code class="issue-code">${esc(issue.code)}</code></td>
          <td><span class="impact-badge impact-${issue.impact}">${issue.impact}</span></td>
          ${multiStandard ? `<td><span class="std-chip" style="${stdStyle(issue.standard)}">${issue.standard}</span></td>` : ''}
          <td class="msg-cell">${esc(shortMsg)}</td>
        </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(reportTitle)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           margin: 40px; background: #f0f2f5; color: #222; }
    .container { max-width: 1300px; margin: 0 auto; }
    h1 { color: #1a1a2e; border-bottom: 3px solid #0066cc; padding-bottom: 12px; margin-bottom: 4px; }
    h2 { color: #333; margin-top: 32px; }
    .timestamp { color: #888; font-size: 13px; margin-bottom: 20px; }
    .standards-bar { display: flex; gap: 8px; margin-bottom: 28px; flex-wrap: wrap; }
    .standard-chip { padding: 4px 14px; border-radius: 12px; font-size: 13px; font-weight: 600; }

    /* Stat cards */
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 16px; }
    .card { background: white; padding: 20px 24px; border-radius: 10px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.08); border: 2px solid transparent; }
    .card h3 { margin: 0 0 8px; color: #777; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
    .card .value { font-size: 36px; font-weight: 700; line-height: 1; }
    .card-filterable { cursor: pointer; transition: transform .15s, box-shadow .15s, border-color .15s, opacity .15s; }
    .card-filterable:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,0.13); }
    .card-filterable.active { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,0.18); }
    .card-filterable.active.critical-card { border-color: #d32f2f; }
    .card-filterable.active.serious-card  { border-color: #f57c00; }
    .card-filterable.active.moderate-card { border-color: #fbc02d; }
    .card-filterable.active.minor-card    { border-color: #388e3c; }
    .filters-active .card-filterable:not(.active) { opacity: .45; }
    .filter-hint { font-size: 12px; color: #aaa; margin-top: -8px; margin-bottom: 16px; }

    /* Colour values */
    .c-critical { color: #d32f2f; }
    .c-serious  { color: #f57c00; }
    .c-moderate { color: #f9a825; }
    .c-minor    { color: #388e3c; }
    .c-passed   { color: #388e3c; }
    .c-failed   { color: #d32f2f; }

    /* Issues table */
    .table-wrap { background: white; border-radius: 10px; overflow: hidden;
                  box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid #f0f0f0; }
    th { background: #fafafa; font-size: 12px; text-transform: uppercase;
         letter-spacing: .4px; color: #666; font-weight: 600; }
    .issue-row { cursor: pointer; transition: background .1s; }
    .issue-row:hover td { background: #f0f7ff; }
    .issue-row[hidden] { display: none; }
    .issue-code { font-family: monospace; background: #f5f5f5; padding: 2px 6px;
                  border-radius: 3px; font-size: 11px; color: #444; }
    .impact-badge { padding: 2px 9px; border-radius: 3px; font-size: 11px; font-weight: 600;
                    white-space: nowrap; }
    .impact-critical { background: #ffebee; color: #c62828; }
    .impact-serious  { background: #fff3e0; color: #e65100; }
    .impact-moderate { background: #fffde7; color: #f9a825; }
    .impact-minor    { background: #e8f5e9; color: #2e7d32; }
    .std-chip { padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .msg-cell { font-size: 13px; color: #444; max-width: 480px; }
    .row-click-hint { font-size: 12px; color: #aaa; margin-top: 6px; }

    /* ── Modal ────────────────────────────────────────────────── */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.72);
                     z-index: 1000; display: flex; align-items: stretch;
                     justify-content: center; padding: 24px; }
    .modal-overlay[hidden] { display: none; }
    .modal-content { background: white; border-radius: 12px; display: flex;
                     flex-direction: column; width: 100%; max-width: 1400px;
                     max-height: 100%; overflow: hidden;
                     box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    .modal-header { display: flex; align-items: flex-start; gap: 12px;
                    padding: 14px 20px; border-bottom: 1px solid #eee; flex-shrink: 0;
                    background: #fafafa; }
    .modal-header-info { flex: 1; min-width: 0; }
    .modal-issue-title { font-size: 15px; font-weight: 700; color: #1a1a2e;
                         margin: 0 0 4px; word-break: break-all; }
    .modal-page-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .modal-url-text { font-size: 13px; color: #555; overflow: hidden;
                      text-overflow: ellipsis; white-space: nowrap; max-width: 600px; }
    .modal-url-link { font-size: 13px; color: #0066cc; white-space: nowrap;
                      text-decoration: none; flex-shrink: 0; }
    .modal-url-link:hover { text-decoration: underline; }
    .modal-close-btn { background: none; border: none; font-size: 20px; cursor: pointer;
                       color: #888; padding: 4px 8px; border-radius: 4px; flex-shrink: 0;
                       line-height: 1; margin-top: -2px; }
    .modal-close-btn:hover { background: #eee; color: #333; }
    .modal-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }

    /* Screenshot panel */
    .screenshot-panel { flex: 3; overflow-y: auto; background: #1a1a2e;
                        position: relative; min-width: 0; }
    .screenshot-container { position: relative; display: inline-block;
                             width: 100%; vertical-align: top; }
    .screenshot-container img { width: 100%; display: block; }
    .issue-overlay { position: absolute; box-sizing: border-box; cursor: pointer;
                     transition: opacity .12s; border-radius: 2px; }
    .issue-overlay.other  { border: 2px solid rgba(255,165,0,.9);
                             background: rgba(255,165,0,.18); }
    .issue-overlay.active { border: 3px solid rgba(220,20,60,1);
                             background: rgba(220,20,60,.22); z-index: 10; }
    .issue-overlay:hover  { opacity: .75; }

    /* Context fallback (no screenshot) */
    .context-fallback { flex: 3; overflow-y: auto; padding: 24px;
                        background: #fafafa; min-width: 0; }
    .context-fallback[hidden] { display: none; }
    .context-fallback h3 { margin: 0 0 8px; font-size: 13px;
                           text-transform: uppercase; color: #888; }
    .selector-display { display: block; font-family: monospace; font-size: 12px;
                        background: #fff; border: 1px solid #ddd; border-radius: 4px;
                        padding: 10px 12px; margin-bottom: 20px;
                        word-break: break-all; color: #333; }
    .context-fallback pre { font-size: 12px; background: white; border: 1px solid #ddd;
                            border-radius: 4px; padding: 12px; overflow-x: auto;
                            white-space: pre-wrap; word-break: break-all;
                            line-height: 1.5; color: #333; margin: 0; }

    /* Issue list panel */
    .issue-list-panel { flex: 0 0 300px; overflow-y: auto; border-left: 1px solid #eee;
                        background: white; }
    .issue-list-header { padding: 10px 14px; font-size: 11px; text-transform: uppercase;
                         letter-spacing: .5px; color: #888; background: #fafafa;
                         border-bottom: 1px solid #eee; font-weight: 600; position: sticky;
                         top: 0; z-index: 1; }
    .issue-item { padding: 11px 14px; border-bottom: 1px solid #f0f0f0;
                  cursor: pointer; transition: background .1s; }
    .issue-item:hover { background: #f5f5f5; }
    .issue-item.active { background: #fff8e1; border-left: 3px solid #f57c00;
                         padding-left: 11px; }
    .issue-item-code { font-family: monospace; font-size: 11px; color: #666;
                       margin: 3px 0; word-break: break-all; }
    .issue-item-msg { font-size: 12px; color: #444; line-height: 1.4;
                      margin: 4px 0 0; }
    .issue-item-link { font-size: 11px; color: #0066cc; }

    /* Floating tooltip */
    .overlay-tooltip { position: fixed; background: rgba(20,20,40,.92); color: #fff;
                       padding: 8px 12px; border-radius: 6px; font-size: 13px;
                       max-width: 320px; pointer-events: none; z-index: 1100;
                       display: none; line-height: 1.5; }

    /* ── Auto-diff section ───────────────────────────────────── */
    .diff-section { background: white; border-radius: 10px;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.08); padding: 20px 24px;
                    margin-bottom: 28px; border-left: 4px solid #0066cc; }
    .diff-header { display: flex; align-items: baseline; gap: 16px;
                   flex-wrap: wrap; margin-bottom: 14px; }
    .diff-compared { font-size: 13px; color: #888; }
    .diff-compared code { background: #f0f0f0; padding: 2px 6px;
                          border-radius: 3px; font-size: 11px; }
    .diff-chips { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .diff-chip { padding: 5px 16px; border-radius: 20px; font-size: 13px; font-weight: 700; }
    .diff-chip-new        { background: #ffebee; color: #c62828; }
    .diff-chip-resolved   { background: #e8f5e9; color: #2e7d32; }
    .diff-chip-persisting { background: #f5f5f5; color: #757575; }
    details { margin-bottom: 10px; }
    .diff-summary { cursor: pointer; font-weight: 600; color: #333; padding: 8px 0;
                    font-size: 14px; user-select: none; }
    .diff-summary::marker { content: ''; }
    .diff-summary::before { content: '\\25B6\\00A0'; font-size: 10px; }
    details[open] .diff-summary::before { content: '\\25BC\\00A0'; }
    .diff-mini-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .diff-mini-table th, .diff-mini-table td { padding: 8px 12px; text-align: left;
                                               border-bottom: 1px solid #f0f0f0; }
    .diff-mini-table th { background: #fafafa; font-size: 11px; text-transform: uppercase;
                          color: #888; font-weight: 600; letter-spacing: .3px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${esc(reportTitle)}</h1>
    <p class="timestamp">Generated: ${new Date().toISOString()}</p>
    <div class="standards-bar">
      ${standards.map(s => `<span class="standard-chip" style="${stdStyle(s)}">${s}</span>`).join('')}
    </div>

    ${diffSectionHtml}

    <div class="stats-row">
      <div class="card">
        <h3>Total Pages</h3>
        <div class="value">${totalPages}</div>
      </div>
      <div class="card">
        <h3>Pages Passed</h3>
        <div class="value c-passed">${pagesPassed}</div>
      </div>
      <div class="card">
        <h3>Pages with Issues</h3>
        <div class="value c-failed">${pagesWithIssues.size}</div>
      </div>
      <div class="card">
        <h3>Total Issues</h3>
        <div class="value">${totalIssueCount}</div>
      </div>
    </div>

    <div class="stats-row">
      <div class="card card-filterable critical-card" data-filter="critical" role="button" tabindex="0" aria-pressed="false">
        <h3>Critical</h3>
        <div class="value c-critical">${impactCounts.critical}</div>
      </div>
      <div class="card card-filterable serious-card" data-filter="serious" role="button" tabindex="0" aria-pressed="false">
        <h3>Serious</h3>
        <div class="value c-serious">${impactCounts.serious}</div>
      </div>
      <div class="card card-filterable moderate-card" data-filter="moderate" role="button" tabindex="0" aria-pressed="false">
        <h3>Moderate</h3>
        <div class="value c-moderate">${impactCounts.moderate}</div>
      </div>
      <div class="card card-filterable minor-card" data-filter="minor" role="button" tabindex="0" aria-pressed="false">
        <h3>Minor</h3>
        <div class="value c-minor">${impactCounts.minor}</div>
      </div>
    </div>
    <p class="filter-hint">Click an impact card to filter the table. Click again to clear.</p>

    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:32px;margin-bottom:0">
      <h2 style="margin:0">Issues <span id="issueCountBadge" style="font-size:14px;font-weight:400;color:#888"></span></h2>
      <button id="exportCsvBtn" style="margin-left:auto;padding:7px 18px;border:1.5px solid #0066cc;border-radius:6px;background:white;color:#0066cc;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
        &#x2B07; Download CSV
      </button>
    </div>
    <p class="row-click-hint">Click any row to view a visual representation of the issue on the page.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Rule</th>
            <th>Impact</th>
            ${multiStandard ? '<th>Standard</th>' : ''}
            <th>Description</th>
          </tr>
        </thead>
        <tbody id="issuesTbody">
          ${allIssues.length > 0 ? tableRows : `<tr><td colspan="${multiStandard ? 5 : 4}" style="text-align:center;padding:32px;color:#888">No issues found.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <!-- ── Visual Modal ─────────────────────────────────────────── -->
  <div id="modal" class="modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="modalIssueTitle">
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-header-info">
          <p id="modalIssueTitle" class="modal-issue-title"></p>
          <div class="modal-page-row">
            <span id="modalUrl" class="modal-url-text"></span>
            <a id="modalUrlLink" href="#" target="_blank" rel="noopener" class="modal-url-link">Open page ↗</a>
          </div>
        </div>
        <button id="modalClose" class="modal-close-btn" aria-label="Close visual viewer">&#x2715;</button>
      </div>
      <div class="modal-body">
        <div id="screenshotPanel" class="screenshot-panel">
          <div id="screenshotContainer" class="screenshot-container">
            <img id="screenshotImg" src="" alt="Page screenshot">
          </div>
        </div>
        <div id="contextFallback" class="context-fallback" hidden>
          <h3>Selector</h3>
          <code id="selectorPath" class="selector-display"></code>
          <h3>Element HTML</h3>
          <pre id="contextCode"></pre>
        </div>
        <div class="issue-list-panel">
          <div class="issue-list-header" id="issueListHeader">Issues on this page</div>
          <div id="issueList"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="overlay-tooltip" id="overlayTooltip"></div>

  <script>
    var ISSUES = ${issuesJson};
    var VISUALS = ${visualsJson};
    var MULTI_STANDARD = ${JSON.stringify(multiStandard)};

    // ── Helpers ──────────────────────────────────────────────────
    function escHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var STD_COLORS = {
      WCAG2A:    { bg:'#e8f5e9', fg:'#2e7d32' },
      WCAG2AA:   { bg:'#e3f2fd', fg:'#1565c0' },
      WCAG2AAA:  { bg:'#f3e5f5', fg:'#6a1b9a' },
      SECTION508:{ bg:'#fff3e0', fg:'#e65100' }
    };
    function stdStyle(s) {
      var c = STD_COLORS[s] || { bg:'#f5f5f5', fg:'#616161' };
      return 'background:' + c.bg + ';color:' + c.fg;
    }

    var IMPACT_COLORS = {
      critical: { bg:'#ffebee', fg:'#c62828' },
      serious:  { bg:'#fff3e0', fg:'#e65100' },
      moderate: { bg:'#fffde7', fg:'#f9a825' },
      minor:    { bg:'#e8f5e9', fg:'#2e7d32' }
    };
    function impactStyle(imp) {
      var c = IMPACT_COLORS[imp] || { bg:'#f5f5f5', fg:'#616161' };
      return 'background:' + c.bg + ';color:' + c.fg;
    }

    // ── Filtering ────────────────────────────────────────────────
    var activeFilters = new Set();

    function toggleFilter(impact) {
      if (activeFilters.has(impact)) {
        activeFilters.delete(impact);
      } else {
        activeFilters.add(impact);
      }
      applyFilters();
    }

    function applyFilters() {
      var hasFilters = activeFilters.size > 0;
      document.body.classList.toggle('filters-active', hasFilters);

      document.querySelectorAll('.card-filterable').forEach(function(card) {
        var isActive = activeFilters.has(card.dataset.filter);
        card.classList.toggle('active', isActive);
        card.setAttribute('aria-pressed', String(isActive));
      });

      var rows = document.querySelectorAll('.issue-row');
      var visible = 0;
      rows.forEach(function(row) {
        var show = !hasFilters || activeFilters.has(row.dataset.impact);
        row.toggleAttribute('hidden', !show);
        if (show) visible++;
      });

      var badge = document.getElementById('issueCountBadge');
      if (badge) {
        badge.textContent = hasFilters
          ? '(' + visible + ' of ' + ISSUES.length + ' shown)'
          : '(' + ISSUES.length + ' total)';
      }
    }

    document.querySelectorAll('.card-filterable').forEach(function(card) {
      card.addEventListener('click', function() { toggleFilter(card.dataset.filter); });
      card.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFilter(card.dataset.filter); }
      });
    });

    // Init badge
    applyFilters();

    // ── Tooltip ──────────────────────────────────────────────────
    var tooltip = document.getElementById('overlayTooltip');

    function showTooltip(e, issue) {
      tooltip.innerHTML = '<strong>' + escHtml(issue.code) + '</strong><br>' +
        escHtml(issue.message.split('(http')[0].trim());
      tooltip.style.display = 'block';
      positionTooltip(e);
    }
    function positionTooltip(e) {
      var x = e.clientX + 16, y = e.clientY - 10;
      var tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 16;
      if (y + th > window.innerHeight - 8) y = e.clientY - th - 10;
      tooltip.style.left = x + 'px';
      tooltip.style.top  = y + 'px';
    }
    function hideTooltip() { tooltip.style.display = 'none'; }

    // ── Modal ────────────────────────────────────────────────────
    var currentIndex = -1;

    function openModal(index) {
      currentIndex = index;
      var issue = ISSUES[index];
      if (!issue) return;

      document.getElementById('modalIssueTitle').textContent = issue.code;
      document.getElementById('modalUrl').textContent = issue.pageUrl;
      document.getElementById('modalUrlLink').href = issue.pageUrl;

      var visual = VISUALS[issue.pageUrl];
      if (visual && visual.screenshotFile) {
        renderScreenshot(issue.pageUrl, index, visual);
      } else {
        renderContextFallback(issue);
      }

      renderIssueList(issue.pageUrl, index);

      var modal = document.getElementById('modal');
      modal.removeAttribute('hidden');
      document.body.style.overflow = 'hidden';
    }

    function closeModal() {
      document.getElementById('modal').setAttribute('hidden', '');
      document.body.style.overflow = '';
      hideTooltip();
    }

    function renderScreenshot(pageUrl, activeIndex, visual) {
      document.getElementById('screenshotPanel').removeAttribute('hidden');
      document.getElementById('contextFallback').setAttribute('hidden', '');

      var container = document.getElementById('screenshotContainer');
      container.querySelectorAll('.issue-overlay').forEach(function(el) { el.remove(); });

      var img = document.getElementById('screenshotImg');
      img.src = '';

      img.onload = function() {
        var scale = img.offsetWidth / visual.pageWidth;

        var pageIssues = [];
        ISSUES.forEach(function(iss, i) {
          if (iss.pageUrl === pageUrl) pageIssues.push({ iss: iss, idx: i });
        });

        var activeEl = null;

        pageIssues.forEach(function(item) {
          var iss = item.iss;
          var i   = item.idx;
          if (!iss.rect || !iss.rect.w || !iss.rect.h) return;

          var isActive = i === activeIndex;
          var div = document.createElement('div');
          div.className = 'issue-overlay ' + (isActive ? 'active' : 'other');
          div.style.left   = (iss.rect.x * scale) + 'px';
          div.style.top    = (iss.rect.y * scale) + 'px';
          div.style.width  = Math.max(iss.rect.w * scale, 6) + 'px';
          div.style.height = Math.max(iss.rect.h * scale, 6) + 'px';
          div.title = iss.code;

          div.addEventListener('mouseenter', function(e) { showTooltip(e, iss); });
          div.addEventListener('mousemove',  positionTooltip);
          div.addEventListener('mouseleave', hideTooltip);
          div.addEventListener('click', function() { openModal(i); });

          container.appendChild(div);
          if (isActive) activeEl = div;
        });

        if (activeEl) {
          var panel = document.getElementById('screenshotPanel');
          var targetTop = parseFloat(activeEl.style.top);
          panel.scrollTop = Math.max(0, targetTop - panel.clientHeight / 3);
        }
      };

      img.src = 'screenshots/' + visual.screenshotFile;
    }

    function renderContextFallback(issue) {
      document.getElementById('screenshotPanel').setAttribute('hidden', '');
      document.getElementById('contextFallback').removeAttribute('hidden');
      document.getElementById('selectorPath').textContent = issue.selector || '(no selector)';
      document.getElementById('contextCode').textContent  = issue.context  || '(no context available)';
    }

    function renderIssueList(pageUrl, activeIndex) {
      var container = document.getElementById('issueList');
      container.innerHTML = '';

      var pageIssues = [];
      ISSUES.forEach(function(iss, i) {
        if (iss.pageUrl === pageUrl) pageIssues.push({ iss: iss, idx: i });
      });

      var header = document.getElementById('issueListHeader');
      if (header) header.textContent = pageIssues.length + ' issue' + (pageIssues.length !== 1 ? 's' : '') + ' on this page';

      pageIssues.forEach(function(item) {
        var iss = item.iss;
        var i   = item.idx;
        var div = document.createElement('div');
        div.className = 'issue-item' + (i === activeIndex ? ' active' : '');

        var impBadge = '<span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;' +
          impactStyle(iss.impact) + '">' + escHtml(iss.impact) + '</span>';
        var stdBadge = MULTI_STANDARD
          ? ' <span style="display:inline-block;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:600;' + stdStyle(iss.standard) + '">' + escHtml(iss.standard) + '</span>'
          : '';
        var shortMsg = escHtml(iss.message.split('(http')[0].trim());
        var learnMore = iss.helpUrl
          ? '<br><a class="issue-item-link" href="' + escHtml(iss.helpUrl) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Learn more &#x2197;</a>'
          : '';

        div.innerHTML = impBadge + stdBadge +
          '<div class="issue-item-code">' + escHtml(iss.code) + '</div>' +
          '<div class="issue-item-msg">' + shortMsg + '</div>' +
          learnMore;

        div.addEventListener('click', function() { openModal(i); });
        container.appendChild(div);
      });
    }

    // ── Row click listeners ──────────────────────────────────────
    document.querySelectorAll('.issue-row').forEach(function(row) {
      row.addEventListener('click', function() { openModal(+row.dataset.index); });
    });

    // ── Modal close listeners ────────────────────────────────────
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modal').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });

    // ── CSV Export ───────────────────────────────────────────────
    function exportCsv() {
      var HEADERS = ['Page URL','Page Path','Rule Code','Impact',
                     'Standard','Runner','Description','Help URL'];
      var q = function(v) { return '"' + String(v||'').replace(/"/g,'""') + '"'; };
      var rows = ISSUES.map(function(issue) {
        var pagePath = issue.pageUrl;
        try { pagePath = new URL(issue.pageUrl).pathname; } catch(e) {}
        var description = (issue.message||'').split('(http')[0].trim();
        return [
          q(issue.pageUrl), q(pagePath), q(issue.code), q(issue.impact),
          q(issue.standard), q(issue.runner), q(description), q(issue.helpUrl||'')
        ].join(',');
      });
      var BOM = '\uFEFF';
      var csv = BOM + [HEADERS.map(function(h){return '"'+h+'"';}).join(',')]
                        .concat(rows).join('\r\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'wcag-export.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    var exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportCsv);
      exportBtn.addEventListener('mouseenter', function() {
        this.style.background = '#e8f0fe';
      });
      exportBtn.addEventListener('mouseleave', function() {
        this.style.background = 'white';
      });
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(htmlPath, html);
  console.log(`HTML report generated: ${htmlPath}`);
}

if (require.main === module) {
  runScan();
}

module.exports = { runScan };
