<<<<<<< HEAD
# WCAGScanner
=======
# WCAG Validation Scanner

Automated accessibility scanner for WCAG 2.1 AA compliance using Pa11y.

## Prerequisites

- Node.js 20+ 
- Google Chrome (installed automatically with Chromium)

## Installation

```bash
cd WebMonitoring/WCAGScanner
npm install
```

## Configuration

### 1. Add URLs to Scan

Edit `urls.txt` - add one URL per line:

```
https://yoursite.com/
https://yoursite.com/about
https://yoursite.com/contact
```

### 2. Use Sitemap (Optional)

Set the `SITEMAP_URL` environment variable to auto-discover URLs:

```bash
set SITEMAP_URL=https://yoursite.com/sitemap.xml
```

Or run with both URL list and sitemap - they will be merged.

### 3. Customize Settings

Edit `.pa11yci.json` to adjust:
- WCAG standard (WCAG2A, WCAG2AA, WCAG2AAA)
- Timeout values
- Runners (axe, htmlcs)

## Usage

### Quick Ad-Hoc Scan

```bash
npm run scan
```

### Run with Sitemap Only

```bash
set SITEMAP_URL=https://yoursite.com/sitemap.xml
npm run scan
```

### Use Pa11y CI Directly

```bash
npx pa11y-ci -c .pa11yci.json
```

### View Results

After scanning, check the `reports/` folder for:
- `wcag-report-*.json` - Raw JSON results
- `wcag-report-*.html` - Human-readable HTML report

## Scheduled Scans (Windows)

Use Windows Task Scheduler to run scans on schedule:

1. Open Task Scheduler
2. Create Basic Task
3. Set trigger (daily/weekly)
4. Program: `cmd.exe`
5. Arguments: `/c cd /d "C:\jack\dev\SysOps\WebMonitoring\WCAGScanner" && npm run scan`

## Report Structure

The HTML report shows:
- Total pages scanned
- Pages passed/failed
- Issues by severity (Critical, Serious, Moderate, Minor)
- Detailed issue list with WCAG criteria references

## Custom Runners

The scanner uses both axe and HTML CodeSniffer for maximum coverage:

- **axe**: Modern, comprehensive ruleset
- **htmlcs**: Additional WCAG checks

## Troubleshooting

### Chrome not found
```bash
npx playwright install chromium
```

### Timeout errors
Increase timeout in `.pa11yci.json`:
```json
{
  "defaults": {
    "timeout": 120000
  }
}
```

### Memory issues with large sites
Scan in batches using URL subsets or limit sitemap depth.

## License

GPL-3.0 - See package.json for details.
>>>>>>> 05ca1f7 (First)
# WCAGScanner
# WCAGScanner
