const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');

const { renderTemplate, loadAsset } = require('./lib/render');

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

  const standardsBarHtml = standards.map(s => `<span class="standard-chip" style="${stdStyle(s)}">${s}</span>`).join('');

  const tableRows = allIssues.length > 0
    ? allIssues.map((issue, idx) => {
        let pagePath;
        try { pagePath = new URL(issue.pageUrl).pathname || issue.pageUrl; } catch (e) { pagePath = issue.pageUrl; }
        const shortMsg = issue.message.split('(http')[0].trim();
        return `<tr class="issue-row" data-index="${idx}" data-impact="${issue.impact}">
          <td><a href="${esc(issue.pageUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(pagePath)}</a></td>
          <td><code class="issue-code">${esc(issue.code)}</code></td>
          <td><span class="impact-badge impact-${issue.impact}">${issue.impact}</span></td>
          ${multiStandard ? `<td><span class="std-chip" style="${stdStyle(issue.standard)}">${issue.standard}</span></td>` : ''}
          <td class="msg-cell">${esc(shortMsg)}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="${multiStandard ? 5 : 4}" style="text-align:center;padding:32px;color:#888">No issues found.</td></tr>`;

  const html = renderTemplate('report.html', {
    STYLE:              loadAsset('report.css'),
    REPORT_TITLE:       esc(reportTitle),
    GENERATED_AT:       new Date().toISOString(),
    STANDARDS_BAR:      standardsBarHtml,
    DIFF_SECTION:       diffSectionHtml,
    TOTAL_PAGES:        totalPages,
    PAGES_PASSED:       pagesPassed,
    PAGES_WITH_ISSUES:  pagesWithIssues.size,
    TOTAL_ISSUES:       totalIssueCount,
    CRITICAL_COUNT:     impactCounts.critical,
    SERIOUS_COUNT:      impactCounts.serious,
    MODERATE_COUNT:     impactCounts.moderate,
    MINOR_COUNT:        impactCounts.minor,
    MULTI_STANDARD_TH:   multiStandard ? '<th>Standard</th>' : '',
    TABLE_ROWS:         tableRows,
    ISSUES_JSON:        issuesJson,
    VISUALS_JSON:       visualsJson,
    MULTI_STANDARD:     JSON.stringify(multiStandard),
    CLIENT_JS:          loadAsset('report-client.js')
  });

  fs.writeFileSync(htmlPath, html);
  console.log(`HTML report generated: ${htmlPath}`);
}

if (require.main === module) {
  runScan();
}

module.exports = { runScan };
