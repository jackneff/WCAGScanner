# WCAG Scanner

Automated web accessibility compliance scanner for WCAG 2.1 (A / AA / AAA) and Section 508.
Scans pages using two independent rule engines, produces interactive HTML reports with visual
issue highlighting, tracks progress over time with a trend dashboard, and exports results to CSV
for spreadsheet or ticketing-system import.

---

## How it works

### What is WCAG?

The **Web Content Accessibility Guidelines (WCAG)** are a set of internationally recognised
technical standards published by the W3C (World Wide Web Consortium). They define how web
content should be built so that it is perceivable, operable, understandable, and robust for
all users — including those who use screen readers, keyboard-only navigation, or other
assistive technologies.

WCAG criteria are organised into three **conformance levels**:

| Level | Meaning |
| ----- | ------- |
| **A** | Minimum baseline — the most critical barriers |
| **AA** | Widely adopted legal standard (e.g. ADA, Section 508, EN 301 549) |
| **AAA** | Enhanced accessibility — not required for entire sites but encouraged where possible |

Most government and commercial sites target **WCAG 2.1 AA** compliance.

### Where do the rules come from?

This scanner uses **two independent rule engines** that both map to the WCAG specification:

| Engine | Provider | What it tests |
| ------ | -------- | ------------- |
| **axe-core** | Deque Systems | Modern, high-precision ruleset. Returns a `helpUrl` link to detailed remediation guidance on `dequeuniversity.com`. Classifies issues as critical / serious / moderate / minor. |
| **HTML CodeSniffer (htmlcs)** | Squiz Labs | Translates each WCAG success criterion directly into a machine-checkable test. Rule codes encode the exact WCAG reference (e.g. `WCAG2AA.Principle1.Guideline1_3.1_3_1.F68`). |

Running both engines in combination maximises coverage — some issues are caught by one engine
but not the other.

### What the scanner actually does

1. **Collects URLs** from `urls.txt` and/or a sitemap specified by `SITEMAP_URL`.
2. **Launches Chromium** (via Puppeteer / pa11y) to render each page exactly as a browser
   would, including JavaScript-driven content.
3. **Runs pa11y-ci** once per requested WCAG standard, injecting both axe-core and HTML
   CodeSniffer into the rendered page and collecting every violation.
4. **Merges results** from all standards into a single timestamped JSON report.
5. **Captures visual data** — takes a full-page JPEG screenshot and records the bounding-box
   coordinates of every violating element so they can be highlighted in the HTML report.
6. **Computes an auto-diff** against the previous report, surfacing new and resolved issues.
7. **Generates an interactive HTML report** with clickable severity filters, a visual overlay
   modal, and a "Download CSV" button.

> **Note:** The scanner tests the *rendered* page, not just the raw HTML source. This means
> dynamically injected content (modals, lazy-loaded components, single-page-app routes) is
> tested as a real user would experience it.

---

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- Chromium is downloaded automatically by Puppeteer on first `npm install` — no manual
  Chrome installation needed.

## Installation

```bash
cd WCAGScanner
npm install
```

---

## Configuration

### 1. Add URLs to scan

On first run the scanner creates `urls.txt` automatically from the included template and
exits with instructions. Open `urls.txt` in any text editor, replace the example lines with
your own URLs (one per line), then run again.

```
https://yoursite.com/
https://yoursite.com/about
https://yoursite.com/contact
# https://yoursite.com/wip  ← lines starting with # are ignored
```

`urls.txt` is excluded from version control — your URLs will never be accidentally committed.

### 2. Use a sitemap (optional)

Set `SITEMAP_URL` to auto-discover all URLs. Sitemap URLs and `urls.txt` URLs are merged and
de-duplicated automatically.

```bash
# Windows
set SITEMAP_URL=https://yoursite.com/sitemap.xml
npm run scan

# macOS / Linux
SITEMAP_URL=https://yoursite.com/sitemap.xml npm run scan
```

### 3. Choose WCAG standards

By default the scanner tests against **WCAG 2.1 AA**. Use `WCAG_STANDARDS` to scan multiple
standards in one run (results are merged into one report).

```bash
# Windows
set WCAG_STANDARDS=WCAG2A,WCAG2AA
npm run scan

# macOS / Linux
WCAG_STANDARDS=WCAG2A,WCAG2AA npm run scan
```

Supported values: `WCAG2A`, `WCAG2AA`, `WCAG2AAA`, `SECTION508`

### 4. Skip visual capture (faster CI runs)

Visual screenshots and bounding-box data can be skipped when you only need the raw findings.

```bash
set SKIP_VISUALS=true
npm run scan
```

### 5. Advanced settings (`pa11yci.json`)

```json
{
  "defaults": {
    "standard": "WCAG2AA",
    "runners": ["axe", "htmlcs"],
    "timeout": 60000,
    "wait": 2000,
    "chromeLaunchConfig": {
      "args": ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  }
}
```

- **`timeout`** — milliseconds to wait for each page to load (default 60 s)
- **`wait`** — additional milliseconds to pause after load before testing (useful for SPAs)
- **`runners`** — remove `"htmlcs"` or `"axe"` to use only one engine

---

## Usage

### Run a scan

```bash
npm run scan
```

Reports are saved to `reports/` with a UTC timestamp in the filename:

```
reports/
  wcag-report-2026-02-22T09-00-00.json   ← raw data
  wcag-report-2026-02-22T09-00-00.html   ← interactive report
  screenshots/                            ← page screenshots (if SKIP_VISUALS not set)
```

### Compare two scans (diff)

```bash
npm run diff
```

Automatically compares the two most recent JSON reports and saves a diff HTML report showing
**New**, **Resolved**, and **Persisting** issues to `reports/wcag-diff-[newer]-vs-[older].html`.

### Trend dashboard

```bash
npm run dashboard
```

Reads all `wcag-report-*.json` files and generates `reports/wcag-dashboard.html` — a trend
dashboard with:

- Line chart — total issues over time with critical/serious/moderate breakdown
- Stacked bar chart — issue severity mix per scan
- Scan history table — links to every individual report
- Top recurring rules — the most frequently seen rule codes across all scans

### Export to CSV

```bash
# Export the most recent report
npm run export

# Export a specific report
npm run export -- reports/wcag-report-2026-02-22T09-00-00.json
```

Writes a `.csv` file alongside the source JSON. The CSV contains one row per issue with the
columns: **Page URL, Page Path, Rule Code, Impact, Standard, Runner, Description, Help URL**.

A UTF-8 BOM is prepended so the file opens correctly in Excel without an encoding dialog.

You can also click **Download CSV** inside any HTML report to export that report's issues
directly from the browser without running any command.

---

## HTML report features

| Feature | How to use |
| ------- | ---------- |
| **Severity filter** | Click a Critical / Serious / Moderate / Minor card to show only those issues in the table. Click again to clear. Multiple cards can be active at once. |
| **Visual overlay** | Click any row in the issues table to open a modal showing a full-page screenshot with all issues for that page highlighted. The active issue is outlined in red; others in amber. |
| **Hover tooltip** | Hover over any highlight on the screenshot to see the rule code and description. |
| **Issue panel** | The right panel of the modal lists every issue on the page. Click an item to jump to its highlight. |
| **Changes since last scan** | Automatically embedded when a previous report exists — shows new and resolved issues in collapsible tables. |
| **Download CSV** | Click the button above the issues table to download a CSV of all issues in the current report. |

---

## Scheduled scans

### Windows Task Scheduler

1. Open **Task Scheduler** → Create Basic Task
2. Set your desired trigger (daily, weekly, etc.)
3. Action → **Start a program**
   - Program: `cmd.exe`
   - Arguments: `/c cd /d "C:\path\to\WCAGScanner" && npm run scan`

### cron (macOS / Linux)

```cron
# Run every day at 06:00
0 6 * * * cd /path/to/WCAGScanner && npm run scan >> /var/log/wcag-scan.log 2>&1
```

---

## Output files reference

| File | Description |
| ---- | ----------- |
| `reports/wcag-report-[ts].json` | Raw scan results — all issues, page URLs, standards used, visual metadata |
| `reports/wcag-report-[ts].html` | Interactive report — filters, visual overlay, auto-diff, CSV button |
| `reports/wcag-report-[ts].csv` | Flat CSV — one row per issue, importable into Excel / Jira / GitHub |
| `reports/wcag-diff-[ts]-vs-[ts].html` | Diff report comparing two specific scans |
| `reports/wcag-dashboard.html` | Trend dashboard across all scans |
| `reports/screenshots/[hash].jpg` | Full-page JPEG screenshots used by the visual overlay |

---

## Troubleshooting

### Timeout errors

Increase `timeout` in `pa11yci.json` (value is in milliseconds):

```json
{ "defaults": { "timeout": 120000 } }
```

### Pages require authentication

Add a `actions` array to `pa11yci.json` to simulate login steps before testing:

```json
{
  "defaults": {
    "actions": [
      "navigate to https://yoursite.com/login",
      "set field #username to myuser",
      "set field #password to mypassword",
      "click element button[type=submit]",
      "wait for url to be https://yoursite.com/dashboard"
    ]
  }
}
```

### Memory issues with large sites

Scan in batches by splitting `urls.txt` into smaller files and running separate scans, or
set `SKIP_VISUALS=true` to reduce memory usage.

### Chrome sandbox errors in CI / Docker

Add sandbox flags to `pa11yci.json`:

```json
{
  "defaults": {
    "chromeLaunchConfig": {
      "args": ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    }
  }
}
```

---

## License

GPL-3.0
