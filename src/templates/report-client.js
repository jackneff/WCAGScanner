
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
