const fs = require('fs');
const path = require('path');

const { renderTemplate, loadAsset } = require('./lib/render');

const ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');

function parseTimestamp(filename) {
  // 'wcag-report-2026-02-22T07-36-32.json' → '2026-02-22T07:36:32'
  const raw = filename.replace('wcag-report-', '').replace('.json', '');
  // Last two '-' separators are HH-MM-SS — replace them with ':'
  return raw.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
}

function extractSummary(report, filename) {
  const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const ruleCounts = {};
  const pagesWithIssues = new Set();

  Object.entries(report.results || {}).forEach(([url, issues]) => {
    if (Array.isArray(issues) && issues.length > 0) {
      pagesWithIssues.add(url);
      issues.forEach(issue => {
        const impact = issue.runnerExtras?.impact || 'minor';
        impactCounts[impact] = (impactCounts[impact] || 0) + 1;
        ruleCounts[issue.code] = (ruleCounts[issue.code] || 0) + 1;
      });
    }
  });

  const totalPages = Object.keys(report.results || {}).length;
  const totalIssues = Object.values(impactCounts).reduce((a, b) => a + b, 0);

  const topRules = Object.entries(ruleCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));

  const tsStr = parseTimestamp(filename);
  const displayDate = tsStr.replace('T', ' ');

  return {
    filename,
    timestamp: tsStr,
    displayDate,
    standards: report.standards || ['WCAG2AA'],
    totalIssues,
    critical:  impactCounts.critical,
    serious:   impactCounts.serious,
    moderate:  impactCounts.moderate,
    minor:     impactCounts.minor,
    totalPages,
    pagesWithIssues: pagesWithIssues.size,
    pagesPassed: totalPages - pagesWithIssues.size,
    topRules
  };
}

function aggregateTopRules(summaries) {
  const totals = {};
  summaries.forEach(s => {
    s.topRules.forEach(({ code, count }) => {
      totals[code] = (totals[code] || 0) + count;
    });
  });
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, total]) => ({
      code,
      total,
      avg: (total / summaries.length).toFixed(1)
    }));
}

function generateDashboardHtml(summaries) {
  const recent = summaries.slice(-30); // chart: up to 30 most recent
  const newest = [...summaries].reverse(); // table: newest first

  const labels      = JSON.stringify(recent.map(s => s.displayDate));
  const totals      = JSON.stringify(recent.map(s => s.totalIssues));
  const criticals   = JSON.stringify(recent.map(s => s.critical));
  const seriouses   = JSON.stringify(recent.map(s => s.serious));
  const moderates   = JSON.stringify(recent.map(s => s.moderate));
  const minors      = JSON.stringify(recent.map(s => s.minor));

  const topRules = aggregateTopRules(summaries);

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const tableRows = newest.map(s => {
    const reportHtml = s.filename.replace('.json', '.html');
    return `
    <tr>
      <td>${esc(s.displayDate)}</td>
      <td>${s.standards.map(std => `<span class="std-chip std-${std}">${std}</span>`).join(' ')}</td>
      <td class="num">${s.totalIssues}</td>
      <td class="num c-critical">${s.critical}</td>
      <td class="num c-serious">${s.serious}</td>
      <td class="num c-moderate">${s.moderate}</td>
      <td class="num c-minor">${s.minor}</td>
      <td class="num">${s.totalPages}</td>
      <td class="num c-passed">${s.pagesPassed}</td>
      <td><a href="${esc(reportHtml)}" class="report-link">View &#x2197;</a></td>
    </tr>`;
  }).join('');

  const topRulesRows = topRules.map(r => `
    <tr>
      <td><code class="rule-code">${esc(r.code)}</code></td>
      <td class="num">${r.total}</td>
      <td class="num">${r.avg}</td>
    </tr>`).join('');

  return renderTemplate('dashboard.html', {
    STYLE:              loadAsset('dashboard.css'),
    GENERATED_AT:       new Date().toISOString(),
    SCAN_COUNT:         summaries.length,
    SCAN_COUNT_SUFFIX:  summaries.length !== 1 ? 's' : '',
    RECENT_COUNT:       recent.length,
    RECENT_COUNT_SUFFIX: recent.length !== 1 ? 's' : '',
    LABELS:             labels,
    TOTALS:             totals,
    CRITICALS:          criticals,
    SERIOUSES:          seriouses,
    MODERATES:          moderates,
    MINORS:             minors,
    TABLE_ROWS:         tableRows || '<tr><td colspan="10" style="text-align:center;color:#888;padding:24px">No scans found.</td></tr>',
    TOP_RULES_ROWS:     topRulesRows || '<tr><td colspan="3" style="text-align:center;color:#888;padding:24px">No data.</td></tr>'
  });
}

function runDashboard() {
  console.log('=== WCAG Trend Dashboard ===\n');

  const reportsPath = REPORTS_DIR;
  if (!fs.existsSync(reportsPath)) {
    console.error('No reports directory found. Run "npm run scan" first.');
    process.exit(1);
  }

  const files = fs.readdirSync(reportsPath)
    .filter(f => /^wcag-report-.*\.json$/.test(f))
    .sort(); // oldest first

  if (files.length === 0) {
    console.error('No scan reports found in reports/. Run "npm run scan" first.');
    process.exit(1);
  }

  console.log(`Loading ${files.length} report${files.length !== 1 ? 's' : ''}...`);

  const summaries = files.map(f => {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(reportsPath, f), 'utf-8'));
      return extractSummary(report, f);
    } catch (e) {
      console.warn(`  Skipping ${f}: ${e.message}`);
      return null;
    }
  }).filter(Boolean);

  if (summaries.length === 0) {
    console.error('Could not load any reports.');
    process.exit(1);
  }

  const html = generateDashboardHtml(summaries);
  const outPath = path.join(reportsPath, 'wcag-dashboard.html');
  fs.writeFileSync(outPath, html);

  const latest = summaries[summaries.length - 1];
  console.log(`\nScans analysed: ${summaries.length}`);
  console.log(`Latest total issues: ${latest.totalIssues} (Critical: ${latest.critical}, Serious: ${latest.serious})`);
  console.log(`\nDashboard saved to: ${outPath}`);
}

if (require.main === module) {
  runDashboard();
}

module.exports = { runDashboard, extractSummary };
