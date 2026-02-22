const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');

const CONFIG_FILE = '.pa11yci.json';
const URLS_FILE = 'urls.txt';
const REPORTS_DIR = 'reports';
const SITEMAP_URL = process.env.SITEMAP_URL || '';

async function loadUrlsFromSitemap(sitemapUrl) {
  try {
    console.log(`Fetching sitemap from: ${sitemapUrl}`);
    const response = await axios.get(sitemapUrl);
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);
    
    const urls = [];
    
    if (result.sitemapurlset && result.sitemapurlset.url) {
      result.sitemapurlset.url.forEach(entry => {
        if (entry.loc && entry.loc[0]) {
          urls.push(entry.loc[0]);
        }
      });
    } else if (result.urlset && result.urlset.url) {
      result.urlset.url.forEach(entry => {
        if (entry.loc && entry.loc[0]) {
          urls.push(entry.loc[0]);
        }
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
    if (!fs.existsSync(filePath)) {
      return [];
    }
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
  const allUrls = [...new Set([...urlsFromFile, ...urlsFromSitemap])];
  return allUrls;
}

async function updateConfigWithUrls(urls) {
  const configPath = path.join(__dirname, CONFIG_FILE);
  let config = {};
  
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  
  config.urls = urls;
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Updated config with ${urls.length} URLs`);
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

async function runScan() {
  console.log('=== WCAG 2.1 AA Compliance Scanner ===\n');
  
  const startTime = new Date();
  
  // Load URLs
  let urlsFromFile = loadUrlsFromFile(path.join(__dirname, URLS_FILE));
  let urlsFromSitemap = [];
  
  if (SITEMAP_URL) {
    urlsFromSitemap = await loadUrlsFromSitemap(SITEMAP_URL);
  }
  
  const allUrls = mergeUrls(urlsFromFile, urlsFromSitemap);
  
  if (allUrls.length === 0) {
    console.error('No URLs to scan. Add URLs to urls.txt or set SITEMAP_URL environment variable.');
    process.exit(1);
  }
  
  console.log(`Total URLs to scan: ${allUrls.length}\n`);
  
  // Update config with URLs
  await updateConfigWithUrls(allUrls);
  
  // Ensure reports directory exists
  ensureReportsDir();
  
  // Run pa11y-ci scan
  const reportFilename = generateReportFilename();
  const reportPath = path.join(REPORTS_DIR, `${reportFilename}.json`);
  
  console.log('Starting scan...\n');

  try {
    const { spawn } = require('child_process');
    const jsonOutput = [];
    
    await new Promise((resolve, reject) => {
      const child = spawn('npx', ['pa11y-ci', '-c', '.pa11yci.json', '--reporter', 'json'], {
        cwd: __dirname,
        shell: true
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(text);
      });
      
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      child.on('close', (code) => {
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*"results"[\s\S]*\}/);
          if (jsonMatch) {
            fs.writeFileSync(reportPath, jsonMatch[0]);
          } else {
            fs.writeFileSync(reportPath, stdout);
          }
          resolve();
        } catch (e) {
          fs.writeFileSync(reportPath, stdout);
          resolve();
        }
      });
      
      child.on('error', reject);
    });
    
    console.log(`\nScan complete! Results saved to: ${reportPath}`);
    
    // Generate HTML report
    const htmlReportPath = path.join(REPORTS_DIR, `${reportFilename}.html`);
    generateHtmlReport(reportPath, htmlReportPath, allUrls.length);
    
    const endTime = new Date();
    const duration = Math.round((endTime - startTime) / 1000);
    
    console.log(`Total scan time: ${duration} seconds`);
    console.log(`HTML Report: ${htmlReportPath}`);
    
  } catch (error) {
    console.error(`Scan error: ${error.message}`);
    process.exit(1);
  }
}

function generateHtmlReport(jsonPath, htmlPath, totalUrls) {
  let results = { results: {}, total: 0, passes: 0, errors: 0 };
  
  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    results = JSON.parse(content);
  } catch (error) {
    console.error(`Error reading results: ${error.message}`);
    return;
  }
  
  const issues = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0
  };
  
  const pagesWithIssues = new Set();
  const allIssues = [];
  
  Object.entries(results.results).forEach(([url, pageIssues]) => {
    if (pageIssues && pageIssues.length > 0) {
      pagesWithIssues.add(url);
      pageIssues.forEach(issue => {
        const impact = issue.runnerExtras?.impact || 'minor';
        issues[impact] = (issues[impact] || 0) + 1;
        allIssues.push({
          pageUrl: url,
          code: issue.code,
          impact: impact,
          message: issue.message,
          runner: issue.runner,
          wcagTags: issue.runnerExtras?.description || ''
        });
      });
    }
  });
  
  const totalPages = Object.keys(results.results).length;
  const pagesPassed = totalPages - pagesWithIssues.size;
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WCAG 2.1 AA Compliance Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #333; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin: 30px 0; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h3 { margin: 0 0 10px 0; color: #666; font-size: 14px; }
    .card .value { font-size: 32px; font-weight: bold; }
    .critical { color: #d32f2f; }
    .serious { color: #f57c00; }
    .moderate { color: #fbc02d; }
    .minor { color: #388e3c; }
    .passed { color: #388e3c; }
    .failed { color: #d32f2f; }
    table { width: 100%; border-collapse: collapse; background: white; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; font-weight: 600; }
    .issue-code { font-family: monospace; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .issue-impact { padding: 2px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
    .impact-critical { background: #ffebee; color: #c62828; }
    .impact-serious { background: #fff3e0; color: #e65100; }
    .impact-moderate { background: #fffde7; color: #f9a825; }
    .impact-minor { background: #e8f5e9; color: #2e7d32; }
    .timestamp { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>WCAG 2.1 AA Compliance Report</h1>
    <p class="timestamp">Generated: ${new Date().toISOString()}</p>
    
    <div class="summary">
      <div class="card">
        <h3>Total Pages Scanned</h3>
        <div class="value">${totalPages}</div>
      </div>
      <div class="card">
        <h3>Pages Passed</h3>
        <div class="value passed">${pagesPassed}</div>
      </div>
      <div class="card">
        <h3>Pages with Issues</h3>
        <div class="value failed">${pagesWithIssues.size}</div>
      </div>
      <div class="card">
        <h3>Total Issues</h3>
        <div class="value">${Object.values(issues).reduce((a, b) => a + b, 0)}</div>
      </div>
    </div>
    
    <div class="summary">
      <div class="card">
        <h3>Critical Issues</h3>
        <div class="value critical">${issues.critical}</div>
      </div>
      <div class="card">
        <h3>Serious Issues</h3>
        <div class="value serious">${issues.serious}</div>
      </div>
      <div class="card">
        <h3>Moderate Issues</h3>
        <div class="value moderate">${issues.moderate}</div>
      </div>
      <div class="card">
        <h3>Minor Issues</h3>
        <div class="value minor">${issues.minor}</div>
      </div>
    </div>
    
    <h2>Detailed Issues</h2>
    <table>
      <thead>
        <tr>
          <th>Page URL</th>
          <th>Issue</th>
          <th>Impact</th>
          <th>WCAG Criteria</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${allIssues.length > 0 ? allIssues.map(issue => `
            <tr>
              <td><a href="${issue.pageUrl}">${new URL(issue.pageUrl).pathname || issue.pageUrl}</a></td>
              <td><code class="issue-code">${issue.code}</code></td>
              <td><span class="issue-impact impact-${issue.impact}">${issue.impact}</span></td>
              <td>${issue.wcgTags || issue.code.split('.')[0] || 'WCAG'}</td>
              <td>${issue.message || ''}</td>
            </tr>
          `).join('') : '<tr><td colspan="5">No issues found!</td></tr>'}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  
  fs.writeFileSync(htmlPath, html);
  console.log(`HTML report generated: ${htmlPath}`);
}

// Run if executed directly
if (require.main === module) {
  runScan();
}

module.exports = { runScan };
