const fs = require('fs');
const path = require('path');

const REPORTS_DIR = 'reports';

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WCAG Scan Trend Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           margin: 40px; background: #f0f2f5; color: #222; }
    .container { max-width: 1300px; margin: 0 auto; }
    h1 { color: #1a1a2e; border-bottom: 3px solid #0066cc; padding-bottom: 12px; margin-bottom: 4px; }
    h2 { color: #333; margin-top: 40px; margin-bottom: 16px; }
    .timestamp { color: #888; font-size: 13px; margin-bottom: 32px; }
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 8px; }
    .chart-card { background: white; border-radius: 10px; padding: 24px;
                  box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .chart-card h3 { margin: 0 0 16px; font-size: 14px; color: #555;
                     text-transform: uppercase; letter-spacing: .4px; }
    .chart-note { font-size: 12px; color: #bbb; text-align: center; margin-top: 8px; }
    .table-card { background: white; border-radius: 10px; overflow: hidden;
                  box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #f0f0f0; }
    th { background: #fafafa; font-size: 11px; text-transform: uppercase;
         letter-spacing: .4px; color: #666; font-weight: 600; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafcff; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .c-critical { color: #d32f2f; font-weight: 600; }
    .c-serious  { color: #f57c00; font-weight: 600; }
    .c-moderate { color: #f9a825; font-weight: 600; }
    .c-minor    { color: #388e3c; font-weight: 600; }
    .c-passed   { color: #388e3c; }
    .std-chip { display: inline-block; padding: 2px 8px; border-radius: 3px;
                font-size: 11px; font-weight: 600; }
    .std-WCAG2A    { background: #e8f5e9; color: #2e7d32; }
    .std-WCAG2AA   { background: #e3f2fd; color: #1565c0; }
    .std-WCAG2AAA  { background: #f3e5f5; color: #6a1b9a; }
    .std-SECTION508{ background: #fff3e0; color: #e65100; }
    .report-link { color: #0066cc; text-decoration: none; font-size: 13px; }
    .report-link:hover { text-decoration: underline; }
    .rule-code { font-family: monospace; background: #f5f5f5; padding: 2px 6px;
                 border-radius: 3px; font-size: 11px; color: #444; }
    .no-charts { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px;
                 padding: 14px 20px; font-size: 14px; color: #795548; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>WCAG Scan Trend Dashboard</h1>
    <p class="timestamp">Generated: ${new Date().toISOString()} &nbsp;|&nbsp; ${summaries.length} scan${summaries.length !== 1 ? 's' : ''} analysed</p>

    <p class="no-charts" id="offlineNote" style="display:none">
      Charts require an internet connection to load Chart.js. The tables below are always available.
    </p>

    <div class="chart-grid">
      <div class="chart-card">
        <h3>Total Issues Over Time</h3>
        <canvas id="lineChart"></canvas>
        <p class="chart-note">Last ${recent.length} scan${recent.length !== 1 ? 's' : ''}</p>
      </div>
      <div class="chart-card">
        <h3>Issues by Severity</h3>
        <canvas id="barChart"></canvas>
        <p class="chart-note">Stacked &mdash; last ${recent.length} scan${recent.length !== 1 ? 's' : ''}</p>
      </div>
    </div>

    <h2>Scan History</h2>
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Standards</th>
            <th class="num">Total</th>
            <th class="num">Critical</th>
            <th class="num">Serious</th>
            <th class="num">Moderate</th>
            <th class="num">Minor</th>
            <th class="num">Pages</th>
            <th class="num">Passed</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="10" style="text-align:center;color:#888;padding:24px">No scans found.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2>Top Recurring Rules</h2>
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th>Rule Code</th>
            <th class="num">Total Hits</th>
            <th class="num">Avg per Scan</th>
          </tr>
        </thead>
        <tbody>
          ${topRulesRows || '<tr><td colspan="3" style="text-align:center;color:#888;padding:24px">No data.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"
          onerror="document.getElementById('offlineNote').style.display='block'"></script>
  <script>
    var LABELS    = ${labels};
    var TOTALS    = ${totals};
    var CRITICALS = ${criticals};
    var SERIOUSES = ${seriouses};
    var MODERATES = ${moderates};
    var MINORS    = ${minors};

    if (typeof Chart !== 'undefined') {
      var commonOptions = {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } },
        scales: {
          x: { ticks: { font: { size: 11 }, maxRotation: 45 } },
          y: { beginAtZero: true, ticks: { font: { size: 11 } } }
        }
      };

      // Line chart — total + breakdown lines
      new Chart(document.getElementById('lineChart'), {
        type: 'line',
        data: {
          labels: LABELS,
          datasets: [
            { label: 'Total',    data: TOTALS,    borderColor: '#1a1a2e', backgroundColor: 'rgba(26,26,46,.08)',  fill: true, tension: .3, pointRadius: 3 },
            { label: 'Critical', data: CRITICALS, borderColor: '#d32f2f', backgroundColor: 'transparent', tension: .3, pointRadius: 3 },
            { label: 'Serious',  data: SERIOUSES, borderColor: '#f57c00', backgroundColor: 'transparent', tension: .3, pointRadius: 3 },
            { label: 'Moderate', data: MODERATES, borderColor: '#f9a825', backgroundColor: 'transparent', tension: .3, pointRadius: 3 }
          ]
        },
        options: commonOptions
      });

      // Stacked bar chart
      new Chart(document.getElementById('barChart'), {
        type: 'bar',
        data: {
          labels: LABELS,
          datasets: [
            { label: 'Critical', data: CRITICALS, backgroundColor: '#ef9a9a' },
            { label: 'Serious',  data: SERIOUSES, backgroundColor: '#ffcc80' },
            { label: 'Moderate', data: MODERATES, backgroundColor: '#fff176' },
            { label: 'Minor',    data: MINORS,    backgroundColor: '#a5d6a7' }
          ]
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            x: { ...commonOptions.scales.x, stacked: true },
            y: { ...commonOptions.scales.y, stacked: true }
          }
        }
      });
    }
  </script>
</body>
</html>`;
}

function runDashboard() {
  console.log('=== WCAG Trend Dashboard ===\n');

  const reportsPath = path.join(__dirname, REPORTS_DIR);
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
