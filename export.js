const fs = require('fs');
const path = require('path');

const REPORTS_DIR = 'reports';

/**
 * Convert a flat array of issue objects to RFC 4180 CSV.
 * Prepends a UTF-8 BOM so Excel opens the file without encoding prompts.
 *
 * Expected issue shape (same as allIssues built in generateHtmlReport):
 *   { pageUrl, code, impact, standard, runner, message, helpUrl, ... }
 */
function issuesToCsv(issues) {
  const HEADERS = [
    'Page URL', 'Page Path', 'Rule Code', 'Impact',
    'Standard', 'Runner', 'Description', 'Help URL'
  ];

  // RFC 4180: wrap every field in quotes, escape embedded quotes by doubling
  const q = v => '"' + String(v || '').replace(/"/g, '""') + '"';

  const rows = issues.map(issue => {
    let pagePath = issue.pageUrl;
    try { pagePath = new URL(issue.pageUrl).pathname; } catch (e) {}

    // Strip trailing help-URL reference that pa11y appends to messages
    const description = (issue.message || '').split('(http')[0].trim();

    return [
      q(issue.pageUrl),
      q(pagePath),
      q(issue.code),
      q(issue.impact),
      q(issue.standard),
      q(issue.runner),
      q(description),
      q(issue.helpUrl || '')
    ].join(',');
  });

  const BOM = '\uFEFF';
  return BOM + [HEADERS.map(h => '"' + h + '"').join(','), ...rows].join('\r\n');
}

function findMostRecentReport(reportsDir) {
  const reportsPath = path.join(__dirname, reportsDir);
  if (!fs.existsSync(reportsPath)) {
    throw new Error(`Reports directory not found: ${reportsPath}`);
  }

  const files = fs.readdirSync(reportsPath)
    .filter(f => /^wcag-report-.*\.json$/.test(f))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error('No scan reports found. Run "npm run scan" first.');
  }

  return path.join(reportsPath, files[0]);
}

function flattenIssues(report) {
  const standards = report.standards || ['WCAG2AA'];
  const issues = [];

  Object.entries(report.results || {}).forEach(([url, pageIssues]) => {
    if (!Array.isArray(pageIssues)) return;
    pageIssues.forEach(issue => {
      issues.push({
        pageUrl:  url,
        code:     issue.code     || '',
        impact:   issue.runnerExtras?.impact || 'minor',
        standard: issue.standard || standards[0] || 'WCAG2AA',
        runner:   issue.runner   || '',
        message:  issue.message  || '',
        helpUrl:  issue.runnerExtras?.helpUrl || ''
      });
    });
  });

  return issues;
}

function runExport() {
  console.log('=== WCAG CSV Export ===\n');

  let jsonPath;

  if (process.argv[2]) {
    jsonPath = path.resolve(process.argv[2]);
    if (!fs.existsSync(jsonPath)) {
      console.error(`File not found: ${jsonPath}`);
      process.exit(1);
    }
  } else {
    try {
      jsonPath = findMostRecentReport(REPORTS_DIR);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log(`Source: ${path.basename(jsonPath)}`);

  let report;
  try {
    report = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (e) {
    console.error(`Failed to parse JSON: ${e.message}`);
    process.exit(1);
  }

  const issues = flattenIssues(report);
  const csv = issuesToCsv(issues);

  const csvPath = jsonPath.replace(/\.json$/, '.csv');
  fs.writeFileSync(csvPath, csv);

  console.log(`Rows exported: ${issues.length}`);
  console.log(`CSV saved to:  ${csvPath}`);
}

if (require.main === module) {
  runExport();
}

module.exports = { issuesToCsv };
