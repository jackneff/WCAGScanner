const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');

function findLatestReports(reportsDir) {
  const reportsPath = reportsDir;
  if (!fs.existsSync(reportsPath)) {
    throw new Error(`Reports directory not found: ${reportsPath}`);
  }

  const files = fs.readdirSync(reportsPath)
    .filter(f => /^wcag-report-.*\.json$/.test(f))
    .sort()
    .reverse();

  if (files.length < 2) {
    throw new Error(
      `Need at least 2 scan reports to compare. Found ${files.length}. Run "npm run scan" more than once first.`
    );
  }

  return [
    path.join(reportsPath, files[0]),
    path.join(reportsPath, files[1])
  ];
}

function loadReport(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

function buildIssueMap(report) {
  const map = new Map();
  Object.entries(report.results || {}).forEach(([url, issues]) => {
    if (Array.isArray(issues)) {
      issues.forEach(issue => {
        const key = `${url}|${issue.code}`;
        if (!map.has(key)) {
          map.set(key, { ...issue, pageUrl: url });
        }
      });
    }
  });
  return map;
}

function compareReports(olderReport, newerReport) {
  const olderMap = buildIssueMap(olderReport);
  const newerMap = buildIssueMap(newerReport);

  const newIssues = [];
  const resolvedIssues = [];
  const persistingIssues = [];

  newerMap.forEach((issue, key) => {
    if (olderMap.has(key)) {
      persistingIssues.push(issue);
    } else {
      newIssues.push(issue);
    }
  });

  olderMap.forEach((issue, key) => {
    if (!newerMap.has(key)) {
      resolvedIssues.push(issue);
    }
  });

  return { newIssues, resolvedIssues, persistingIssues };
}

function generateDiffHtml(comparison, olderPath, newerPath) {
  const { newIssues, resolvedIssues, persistingIssues } = comparison;
  const olderName = path.basename(olderPath);
  const newerName = path.basename(newerPath);

  const statusOrder = { new: 0, resolved: 1, persisting: 2 };
  const allRows = [
    ...newIssues.map(i => ({ ...i, status: 'new' })),
    ...resolvedIssues.map(i => ({ ...i, status: 'resolved' })),
    ...persistingIssues.map(i => ({ ...i, status: 'persisting' }))
  ].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const standardChipColors = {
    WCAG2A:    { bg: '#e8f5e9', fg: '#2e7d32' },
    WCAG2AA:   { bg: '#e3f2fd', fg: '#1565c0' },
    WCAG2AAA:  { bg: '#f3e5f5', fg: '#6a1b9a' },
    SECTION508:{ bg: '#fff3e0', fg: '#e65100' }
  };

  function standardChipStyle(std) {
    const c = standardChipColors[(std || '').toUpperCase()] || { bg: '#f5f5f5', fg: '#616161' };
    return `background:${c.bg};color:${c.fg}`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WCAG Scan Diff Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #333; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    .meta { background: white; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); font-size: 14px; color: #555; }
    .meta strong { color: #333; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 30px 0; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h3 { margin: 0 0 10px 0; color: #666; font-size: 14px; }
    .card .value { font-size: 32px; font-weight: bold; }
    .new { color: #d32f2f; }
    .resolved { color: #388e3c; }
    .persisting { color: #757575; }
    table { width: 100%; border-collapse: collapse; background: white; margin-top: 20px; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
    th { background: #f5f5f5; font-weight: 600; }
    tr.row-new { background: #fff8f8; }
    tr.row-resolved { background: #f8fff8; }
    tr.row-persisting { background: #fafafa; }
    .status-badge { padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .badge-new { background: #ffebee; color: #c62828; }
    .badge-resolved { background: #e8f5e9; color: #2e7d32; }
    .badge-persisting { background: #f5f5f5; color: #616161; }
    .issue-code { font-family: monospace; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .impact-badge { padding: 2px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
    .impact-critical { background: #ffebee; color: #c62828; }
    .impact-serious { background: #fff3e0; color: #e65100; }
    .impact-moderate { background: #fffde7; color: #f9a825; }
    .impact-minor { background: #e8f5e9; color: #2e7d32; }
    .std-chip { padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .timestamp { color: #666; font-size: 14px; }
    .empty { text-align: center; padding: 30px; color: #888; }
  </style>
</head>
<body>
  <div class="container">
    <h1>WCAG Scan Diff Report</h1>
    <p class="timestamp">Generated: ${new Date().toISOString()}</p>

    <div class="meta">
      <strong>Newer:</strong> ${newerName}<br>
      <strong>Older:</strong> ${olderName}
    </div>

    <div class="summary">
      <div class="card">
        <h3>New Issues</h3>
        <div class="value new">${newIssues.length}</div>
      </div>
      <div class="card">
        <h3>Resolved Issues</h3>
        <div class="value resolved">${resolvedIssues.length}</div>
      </div>
      <div class="card">
        <h3>Persisting Issues</h3>
        <div class="value persisting">${persistingIssues.length}</div>
      </div>
    </div>

    <h2>All Changes</h2>
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Page URL</th>
          <th>Rule Code</th>
          <th>Impact</th>
          <th>Standard</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${allRows.length > 0 ? allRows.map(issue => {
          let pagePath;
          try { pagePath = new URL(issue.pageUrl).pathname || issue.pageUrl; } catch (e) { pagePath = issue.pageUrl; }
          const impact = issue.runnerExtras?.impact || 'minor';
          const std = issue.standard || 'WCAG2AA';
          return `
          <tr class="row-${issue.status}">
            <td><span class="status-badge badge-${issue.status}">${issue.status}</span></td>
            <td><a href="${issue.pageUrl}">${pagePath}</a></td>
            <td><code class="issue-code">${issue.code || ''}</code></td>
            <td><span class="impact-badge impact-${impact}">${impact}</span></td>
            <td><span class="std-chip" style="${standardChipStyle(std)}">${std}</span></td>
            <td>${issue.message || ''}</td>
          </tr>`;
        }).join('') : '<tr><td colspan="6" class="empty">No differences found between these two reports.</td></tr>'}
      </tbody>
    </table>
  </div>
</body>
</html>`;

  return html;
}

function runDiff() {
  console.log('=== WCAG Scan Diff ===\n');

  let newerPath, olderPath;
  try {
    [newerPath, olderPath] = findLatestReports(REPORTS_DIR);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Newer: ${path.basename(newerPath)}`);
  console.log(`Older: ${path.basename(olderPath)}\n`);

  const newerReport = loadReport(newerPath);
  const olderReport = loadReport(olderPath);

  const comparison = compareReports(olderReport, newerReport);

  console.log(`New issues:        ${comparison.newIssues.length}`);
  console.log(`Resolved issues:   ${comparison.resolvedIssues.length}`);
  console.log(`Persisting issues: ${comparison.persistingIssues.length}`);

  const html = generateDiffHtml(comparison, olderPath, newerPath);

  const newerTs = path.basename(newerPath).replace('wcag-report-', '').replace('.json', '');
  const olderTs = path.basename(olderPath).replace('wcag-report-', '').replace('.json', '');
  const diffFilename = `wcag-diff-${newerTs}-vs-${olderTs}.html`;
  const diffPath = path.join(REPORTS_DIR, diffFilename);

  fs.writeFileSync(diffPath, html);
  console.log(`\nDiff report saved to: ${diffPath}`);
}

if (require.main === module) {
  runDiff();
}

module.exports = { runDiff, compareReports };
