const fs = require('fs');
const path = require('path');

const { renderTemplate, loadAsset } = require('./lib/render');

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

  const tableRows = allRows.length > 0
    ? allRows.map(issue => {
        let pagePath;
        try { pagePath = new URL(issue.pageUrl).pathname || issue.pageUrl; } catch (e) { pagePath = issue.pageUrl; }
        const impact = issue.runnerExtras?.impact || 'minor';
        const std = issue.standard || 'WCAG2AA';
        return `<tr class="row-${issue.status}">
            <td><span class="status-badge badge-${issue.status}">${issue.status}</span></td>
            <td><a href="${issue.pageUrl}">${pagePath}</a></td>
            <td><code class="issue-code">${issue.code || ''}</code></td>
            <td><span class="impact-badge impact-${impact}">${impact}</span></td>
            <td><span class="std-chip" style="${standardChipStyle(std)}">${std}</span></td>
            <td>${issue.message || ''}</td>
          </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="empty">No differences found between these two reports.</td></tr>';

  const html = renderTemplate('diff.html', {
    STYLE:          loadAsset('diff.css'),
    GENERATED_AT:   new Date().toISOString(),
    NEWER_NAME:     newerName,
    OLDER_NAME:     olderName,
    NEW_COUNT:      newIssues.length,
    RESOLVED_COUNT: resolvedIssues.length,
    PERSISTING_COUNT: persistingIssues.length,
    TABLE_ROWS:     tableRows
  });

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
