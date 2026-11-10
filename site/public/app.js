/* FlopRadar front end. Reads /data/leaderboard.json at runtime; no framework. The only third-party request is Cloudflare's cookieless Web Analytics beacon, which Cloudflare injects at the edge (allowed in the CSP). */
(function () {
  "use strict";

  var DATA_URL = "/data/leaderboard.json";
  var PENDING_TEXT = "Pending: live inference tests queued";
  var METRICS = ["reliability", "quality", "safety", "speed", "cost"];
  var VERDICT_CLASS = { "Verified": "v", "Partly": "p", "Not verified": "n", "Untestable": "u" };
  var VERDICT_ORDER = { "Verified": 0, "Partly": 1, "Untestable": 2, "Not verified": 3 };
  var OFFICIAL_DOMAINS = ["flop.finance", "flop.network", "ask.flop.finance", "technocore.chat"];
  var CAUTIONS = {
    "alpertungax1-toolkit": "Caution: its claimed 500–2,000 FLOP “Verified Human” faucet tier doesn’t match the official faucet, which grants 25 FLOP (anonymous) or 2 FLOP (agent) and has no such tier. Its README also asks you to store an EVM private key as a GitHub secret. Don’t put a real wallet key there."
  };
  // Fallback fake-token list, used only if the data file has none.
  var FALLBACK_TOKENS = [
    { chain: "solana", name: "Flop Labs", symbol: "FLOP", address: "HwCG1Jr6RbAVsKX1qTaH6JtFYGeE6zaLd13W44YGpump", verdict: "NOT OFFICIAL" },
    { chain: "solana", name: "FLOP COIN", symbol: "FLOP", address: "4ddZmkmhHJ2C6436znty5s3YpezEkEX6S1oebwhapump", verdict: "NOT OFFICIAL" },
    { chain: "solana", name: "Flop Network", symbol: "FLOP", address: "BiqJUcJSAqhgr8qW5jmzN88rHLSNb1MWfzKruezupump", verdict: "NOT OFFICIAL" },
    { chain: "solana", name: "Flip", symbol: "Flop", address: "24dY4C9pkenBQmP71YRPC3B97HE2B3rt5TMm1qPHpump", verdict: "NOT OFFICIAL" },
    { chain: "xrpl", name: "FLOP", symbol: "FLOP", address: "464C4F5000000000000000000000000000000000.rwKyqD8ncvnu9RnNmDfB1v1r2dtDaBL4yh", verdict: "NOT OFFICIAL" },
    { chain: "pulsechain", name: "Flopcoin", symbol: "FLOP", address: "0xA8B4e655d77aC9AE98521b53bB6b9b26a7F93c68", verdict: "unrelated name collision (pre-dates Flop Labs)" }
  ];

  var state = { data: null, apps: [], view: "overall", q: "", cat: "", sort: "rank", dir: 1, open: {} };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function isUrl(s) { return /^https?:\/\/[^\s]+$/i.test(s) && s.indexOf("…") < 0; } // truncated URLs (with …) render as text, not dead links
  function link(u, label) {
    return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(label || u.replace(/^https?:\/\//, "")) + "</a>";
  }
  function fmt(n) { if (n == null || isNaN(n)) return ""; var r = Math.round(n * 10) / 10; return (r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)); }
  function dateOnly(s) { var m = /(\d{4}-\d{2}-\d{2})/.exec(s || ""); return m ? m[1] : ""; }
  function isCaution(a) { return !!(CAUTIONS[a.id] || (a.claims_risky && !a.excluded_from_ranking)); }

  // metric state: number | "pending" | "na"
  function metric(a, k) {
    var v = a.scores ? a.scores[k] : undefined;
    if (typeof v === "number") return v;
    var appl = a.metrics_applicable || [];
    return appl.indexOf(k) >= 0 ? "pending" : "na";
  }
  function metricCell(a, k) {
    var v = metric(a, k);
    if (v === "pending") return '<span class="pend" title="' + PENDING_TEXT + '"><i class="pend-dot" aria-hidden="true"></i>Pending<span class="sr">: live inference tests queued</span></span>';
    if (v === "na") return '<span class="na" title="Not applicable">n/a</span>';
    return '<span class="m">' + fmt(v) + "</span>";
  }
  function metricText(a, k) {
    var v = metric(a, k);
    if (v === "pending") return PENDING_TEXT;
    if (v === "na") return k === "cost" ? "n/a (only scored for apps that buy inference)" : "n/a";
    return fmt(v);
  }
  function verdictBadge(v) { return '<span class="vd ' + (VERDICT_CLASS[v] || "u") + '">' + esc(v || "Untestable") + "</span>"; }

  /* ---------- hero + summary ---------- */
  function renderSummary(d) {
    var s = d.summary || {};
    var guides = state.apps.filter(isGuideRow).length;
    setAll('[data-stat="items"]', s.items);
    setAll('[data-stat="ranked"]', s.ranked_overall);
    setAll('[data-stat="flagged"]', s.flagged);
    setAll('[data-stat="guides-sub"]', "+" + (s.guides_ranked_in_category_only != null ? s.guides_ranked_in_category_only : guides) + " guides ranked in category");
    var cv = (s.claims_check && s.claims_check.verdicts) || {};
    Object.keys(VERDICT_CLASS).forEach(function (k) {
      setAll('[data-claims="' + k + '"]', cv[k] || 0);
      var seg = $('[data-seg="' + k + '"]');
      if (seg) { seg.style.setProperty("--f", String(cv[k] || 0)); seg.title = k + ": " + (cv[k] || 0); }
    });
    var upd = dateOnly(d.generated_at) || dateOnly(s.claims_check && s.claims_check.checked_at);
    if (upd) $$("[data-updated]").forEach(function (el) { el.textContent = upd; if (el.tagName === "TIME") el.setAttribute("datetime", upd); });
    setAll('[data-count="overall"]', state.apps.filter(isOverallRow).length);
    setAll('[data-count="guides"]', guides);
  }
  function setAll(sel, v) { if (v == null) return; $$(sel).forEach(function (el) { el.textContent = v; }); }

  /* ---------- leaderboard ---------- */
  function isOverallRow(a) { return !a.excluded_from_ranking && typeof a.rank === "number"; }
  function isGuideRow(a) { return !a.excluded_from_ranking && a.kind === "guide"; }

  function rowsForView() {
    var rows = state.apps.filter(state.view === "guides" ? isGuideRow : isOverallRow);
    if (state.cat) rows = rows.filter(function (a) { return a.category === state.cat; });
    if (state.q) {
      var q = state.q.toLowerCase();
      rows = rows.filter(function (a) {
        return [a.name, a.id, a.service_description, a.category, a.claims_verdict, (a.claims || []).join(" ")].join(" ").toLowerCase().indexOf(q) >= 0;
      });
    }
    var key = state.sort, dir = state.dir;
    rows.sort(function (x, y) {
      var a = sortVal(x, key), b = sortVal(y, key);
      var am = a === null, bm = b === null;
      if (am && bm) return baseOrder(x, y);
      if (am) return 1; if (bm) return -1;     // missing values always last
      if (a < b) return -1 * dir; if (a > b) return 1 * dir;
      return baseOrder(x, y);
    });
    return rows;
  }
  function baseOrder(x, y) {
    if (state.view === "guides") return (x.category || "").localeCompare(y.category || "") || (x.category_rank || 99) - (y.category_rank || 99);
    return (x.rank || 999) - (y.rank || 999);
  }
  function sortVal(a, key) {
    if (key === "rank") return state.view === "guides" ? null : a.rank;
    if (key === "name") return (a.name || "").toLowerCase();
    if (key === "category") return (a.category || "").toLowerCase() + String(1000 + (a.category_rank || 999));
    if (key === "trust_score") return a.trust_score;
    if (key === "claims_verdict") return VERDICT_ORDER[a.claims_verdict] != null ? VERDICT_ORDER[a.claims_verdict] : 9;
    var v = metric(a, key);
    return typeof v === "number" ? v : null;
  }

  function scoreCell(a) {
    var s = a.trust_score, cls = s >= 80 ? "" : s >= 60 ? " mid" : " low";
    return '<span class="score"><b>' + fmt(s) + '</b><span class="sbar' + cls + '" data-w="' + s + '"><i></i></span><span class="conf">' + esc(a.confidence || "") + " conf.</span></span>";
  }

  function renderTable() {
    var tbody = $("#lb-body"), rows = rowsForView();
    renderCards(rows);
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty">No apps match. Try another search or category.</td></tr>'; return; }
    var html = rows.map(function (a, i) {
      var open = !!state.open[a.id];
      var rankLabel = state.view === "guides"
        ? '<span class="rk">' + (a.category_rank || "–") + "</span>"
        : '<span class="rk' + (a.rank <= 3 ? " rk-top" : "") + '">' + a.rank + "</span>";
      var badges = (a.official ? ' <span class="badge off" title="Official Flop Labs property">Official</span>' : "") +
        (isCaution(a) ? ' <span class="badge caution" title="A false claim here could hurt users. Open for details.">Caution</span>' : "");
      var did = "d-" + a.id;
      return '<tr class="row' + (open ? " open" : "") + '" data-id="' + esc(a.id) + '">' +
        '<td class="c-rank">' + rankLabel + "</td>" +
        '<td class="c-app"><div class="app-name"><button class="exp" aria-expanded="' + open + '" aria-controls="' + did + '">' +
          '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          esc(a.name) + "</button>" + badges + '</div><div class="desc">' + esc(a.service_description) + "</div></td>" +
        '<td class="c-cat">' + esc(a.category) + (a.category_rank ? '<span class="cat-rank">#' + a.category_rank + " in category</span>" : "") + "</td>" +
        '<td class="c-num c-score">' + scoreCell(a) + "</td>" +
        METRICS.map(function (k) { return '<td class="c-num c-m">' + metricCell(a, k) + "</td>"; }).join("") +
        '<td class="c-verdict">' + verdictBadge(a.claims_verdict) + "</td></tr>" +
        (open ? '<tr class="detail" id="' + did + '"><td colspan="10">' + detailHtml(a) + "</td></tr>" : "");
    }).join("");
    tbody.innerHTML = html;
    $$(".sbar", tbody).forEach(function (el) { el.querySelector("i").style.setProperty("--w", Math.max(0, Math.min(100, +el.getAttribute("data-w"))) + "%"); });
  }

  /* mobile / tablet: the same rows as stacked cards with tap-to-expand detail */
  function renderCards(rows) {
    var ol = $("#lb-cards"); if (!ol) return;
    if (!rows.length) { ol.innerHTML = '<li class="lc-empty">No apps match. Try another search or category.</li>'; return; }
    ol.innerHTML = rows.map(function (a) {
      var open = !!state.open[a.id], did = "c-" + a.id;
      var rk = state.view === "guides" ? (a.category_rank || "–") : a.rank;
      var s = a.trust_score, cls = s >= 80 ? "" : s >= 60 ? " mid" : " low";
      var badges = (a.official ? '<span class="badge off">Official</span>' : "") + (isCaution(a) ? '<span class="badge caution">Caution</span>' : "");
      var cat = esc(a.category) + (a.category_rank ? " · #" + a.category_rank + " in category" : "");
      return '<li class="lc' + (open ? " open" : "") + '" data-id="' + esc(a.id) + '">' +
        '<button type="button" class="lc-head" aria-expanded="' + open + '" aria-controls="' + did + '">' +
          '<span class="lc-rank' + (state.view !== "guides" && a.rank <= 3 ? " rk-top" : "") + '" aria-label="' + (state.view === "guides" ? "Rank in category " : "Rank ") + rk + '">' + rk + "</span>" +
          '<span class="lc-main"><span class="lc-name">' + esc(a.name) + "</span>" + (badges ? '<span class="lc-badges">' + badges + "</span>" : "") +
            '<span class="lc-cat">' + cat + "</span></span>" +
          '<span class="lc-score"><b>' + fmt(s) + '</b><span class="sbar' + cls + '" data-w="' + s + '"><i></i></span><span class="sr"> out of 100</span></span>' +
          '<span class="lc-foot">' + verdictBadge(a.claims_verdict) + '<span class="lc-conf">' + esc(a.confidence || "") + ' confidence</span>' +
            '<span class="lc-more">' + (open ? "Hide" : "Details") + '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span>' +
        "</button>" +
        (open ? '<div class="lc-detail" id="' + did + '">' + detailHtml(a) + "</div>" : "") + "</li>";
    }).join("");
    $$(".sbar", ol).forEach(function (el) { el.querySelector("i").style.setProperty("--w", Math.max(0, Math.min(100, +el.getAttribute("data-w"))) + "%"); });
  }

  function detailHtml(a) {
    var m = a.metrics || {}, ev = a.evidence || {}, sum = (state.data && state.data.summary) || {};
    var caution = CAUTIONS[a.id] || (a.claims_risky ? "Caution: a false claim here could hurt users. Read the claims note before using it." : "");
    var claims = (a.claims || []).map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("");
    var cev = (a.claims_evidence || []).map(function (c) { return "<li>" + (isUrl(c) ? link(c) : esc(c)) + "</li>"; }).join("");
    var flags = (m.safety_flags || []).map(function (f) {
      var sev = f.severity || "low", cls = sev === "high" ? "bad" : sev === "medium" ? "med" : "";
      return '<span class="flag ' + cls + '">' + esc(sev) + ": " + esc(f.detail || f.code) + "</span>";
    }).join("");
    var pos = (m.safety_positives || []).map(function (p) { return '<span class="flag good">' + esc(p) + "</span>"; }).join("");
    var access = (m.data_access || []).map(function (p) { return '<span class="flag">' + esc(p) + "</span>"; }).join("");
    var links = (ev.links || []).map(function (u) { return "<li>" + (isUrl(u) ? link(u) : esc(u)) + "</li>"; }).join("");
    var gh = ev.github ? '<p class="muted small">GitHub: ' + esc(ev.github.stars) + " stars · " + esc(ev.github.license || "no licence") +
      " · last push " + esc(dateOnly(ev.github.pushed_at)) + (ev.github.archived ? " · archived" : "") + "</p>" : "";
    var checked = dateOnly(sum.claims_check && sum.claims_check.checked_at) || dateOnly(state.data && state.data.generated_at);
    var scored = dateOnly(state.data && state.data.generated_at);
    var mrows = METRICS.map(function (k) {
      return "<span>" + k.charAt(0).toUpperCase() + k.slice(1) + "</span><b>" + esc(metricText(a, k)) + "</b>";
    }).join("");
    return '<div class="dgrid">' +
      '<div class="dbox' + (caution ? " caution" : "") + '"><p class="d-desc">' + esc(a.service_description) + "</p><h3 class=dh>Does what it claims? · " + esc(a.claims_verdict) + "</h3>" +
        (caution ? "<p><strong>" + esc(caution) + "</strong></p>" : "") +
        (claims ? '<p class="muted small">Claims tested:</p><ul>' + claims + "</ul>" : "") +
        '<p class="muted small">Claims note:</p><p>' + esc(a.claims_note || "No note.") + "</p>" +
        (cev ? '<p class="muted small">Claims evidence:</p><ul>' + cev + "</ul>" : "") +
      "</div>" +
      '<div class="dbox"><h3 class=dh>Scores</h3><div class="mgrid">' + mrows +
        "<span>Measured score</span><b>" + fmt(a.measured_score) + "</b><span>Confidence</span><b>" + esc(a.confidence) + "</b></div>" +
                '<h3 class=dh>Safety flags</h3><p>' + (flags || '<span class="flag good">No safety flags</span>') + "</p>" +
        (pos ? "<p>" + pos + "</p>" : "") +
        (access ? '<h3 class=dh>Access it asks for</h3><p>' + access + "</p>" : "") +
      "</div>" +
      '<div class="dbox"><h3 class=dh>Evidence</h3>' + (links ? "<ul>" + links + "</ul>" : "<p>No public links.</p>") + gh +
        '<h3 class=dh>Last checked</h3><p>Claims checked ' + esc(checked) + (scored ? " · scored " + esc(scored) : "") + "</p>" +
      "</div></div>";
  }

  function populateCategories() {
    var sel = $("#cat"), cur = state.cat;
    var cats = {};
    state.apps.filter(state.view === "guides" ? isGuideRow : isOverallRow).forEach(function (a) { cats[a.category] = (cats[a.category] || 0) + 1; });
    var names = Object.keys(cats).sort();
    sel.innerHTML = '<option value="">All categories</option>' + names.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + " (" + cats[c] + ")</option>";
    }).join("");
    if (names.indexOf(cur) >= 0) sel.value = cur; else state.cat = "";
  }

  function updateSortHeaders() {
    $$(".lb th[data-sort]").forEach(function (th) {
      if (th.getAttribute("data-sort") === state.sort) th.setAttribute("aria-sort", state.dir === 1 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
    var rk = $('.lb th[data-sort="rank"] button'); if (rk) rk.textContent = state.view === "guides" ? "# in cat." : "#";
    var sm = $("#sort-m"); if (sm) { sm.value = state.sort; var ro = sm.querySelector('option[value="rank"]'); if (ro) ro.textContent = state.view === "guides" ? "Sort: Rank in category" : "Sort: Rank"; }
    var db = $("#sort-dir"); if (db) { db.firstChild.textContent = state.dir === 1 ? "↑" : "↓"; db.setAttribute("aria-label", "Sort direction: " + (state.dir === 1 ? "ascending" : "descending") + ". Tap to reverse."); }
  }

  function setView(v) {
    state.view = v; state.open = {};
    state.sort = v === "guides" ? "category" : "rank"; state.dir = 1;
    $$(".tabs button").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-view") === v)); });
    $("#view-note").textContent = v === "guides"
      ? "Guides and docs are ranked within their own category, not against apps. The number is the guide’s rank in its category."
      : "Everything except guides, ranked together. Guides are ranked within their category in the Guides tab.";
    populateCategories(); updateSortHeaders(); renderTable();
  }

  function bindTable() {
    $$(".tabs button").forEach(function (b) { b.addEventListener("click", function () { setView(b.getAttribute("data-view")); }); });
    $(".tabs").addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var next = state.view === "overall" ? "guides" : "overall"; setView(next); $('[data-view="' + next + '"]').focus();
    });
    var t; $("#q").addEventListener("input", function (e) { clearTimeout(t); t = setTimeout(function () { state.q = e.target.value.trim(); renderTable(); }, 90); });
    $("#cat").addEventListener("change", function (e) { state.cat = e.target.value; renderTable(); });
    $$(".lb th[data-sort] button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.parentNode.getAttribute("data-sort");
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = (key === "rank" || key === "name" || key === "category" || key === "claims_verdict") ? 1 : -1; }
        updateSortHeaders(); renderTable();
      });
    });
    var sm = $("#sort-m");
    if (sm) sm.addEventListener("change", function () {
      var key = sm.value; state.sort = key;
      state.dir = (key === "rank" || key === "name" || key === "category" || key === "claims_verdict") ? 1 : -1;
      updateSortHeaders(); renderTable();
    });
    var db = $("#sort-dir");
    if (db) db.addEventListener("click", function () { state.dir = -state.dir; updateSortHeaders(); renderTable(); });
    $("#lb-cards").addEventListener("click", function (e) {
      var head = e.target.closest(".lc-head"); if (!head) return;
      var li = head.closest(".lc"), id = li.getAttribute("data-id");
      state.open[id] = !state.open[id]; renderTable();
      var nb = $('.lc[data-id="' + cssEsc(id) + '"] .lc-head'); if (nb) nb.focus({ preventScroll: true });
    });
    $("#lb-body").addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
      var tr = e.target.closest("tr.row"); if (!tr) return;
      var id = tr.getAttribute("data-id");
      state.open[id] = !state.open[id]; renderTable();
      var btn = $('tr.row[data-id="' + cssEsc(id) + '"] .exp'); if (btn && e.target.closest(".exp")) btn.focus();
    });
  }
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

  /* ---------- scam alerts ---------- */
  function renderScams(d) {
    var flagged = ((d.warnings && d.warnings.flagged_projects) || []);
    var byId = {}; flagged.forEach(function (f) { byId[f.id] = f; });
    var ex = state.apps.filter(function (a) { return a.excluded_from_ranking; });
    $("#scam-grid").innerHTML = ex.map(function (a) {
      var f = byId[a.id] || {};
      var flags = (f.flags || (a.metrics && a.metrics.safety_flags) || []).filter(function (x) { return x.severity === "high"; });
      var reasons = flags.map(function (x) { return x.detail || x.code; }).join(" ");
      var lnk = f.link || ((a.evidence && a.evidence.links) || [])[0];
      return '<article class="scam"><header><h3>' + esc(a.name) + '</h3><span class="ex">Excluded</span></header>' +
        '<p class="cat">' + esc(a.category) + " · claims check: " + esc(a.claims_verdict) + "</p>" +
        '<p class="reason">' + esc(reasons || "High-severity safety flag.") + "</p>" +
        "<p>" + esc(a.claims_note) + "</p>" +
        (lnk ? "<p>" + link(lnk) + "</p>" : "") + "</article>";
    }).join("") || '<p class="muted">No projects are excluded right now.</p>';
  }

  /* ---------- fake-token checker ---------- */
  function tokens() {
    var t = state.data && state.data.warnings && state.data.warnings.tokens;
    return (t && t.length) ? t : FALLBACK_TOKENS;
  }
  function isFake(t) { return /not official/i.test(t.verdict || ""); }
  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function addrParts(t) { var a = t.address || ""; return [a].concat(a.indexOf(".") > 0 ? a.split(".") : []); }

  function findMatches(input) {
    var raw = input.trim(), lower = raw.toLowerCase(), out = [];
    var ell = raw.split(/…|\.\.\.+/);
    var nn = normName(raw);
    tokens().forEach(function (t) {
      var hit = false;
      addrParts(t).forEach(function (p) {
        var pl = p.toLowerCase();
        if (!pl) return;
        if (pl === lower) hit = true;
        else if (ell.length === 2) {
          var pre = ell[0].trim().toLowerCase(), suf = ell[1].trim().toLowerCase();
          if ((pre.length + suf.length) >= 4 && pl.indexOf(pre) === 0 && pl.slice(pl.length - suf.length) === suf) hit = true;
        } else if (lower.length >= 5 && !/\s/.test(lower) && (pl.indexOf(lower) === 0 || (lower.length >= 8 && pl.slice(-lower.length) === lower))) hit = true;
      });
      if (!hit && nn) {
        var tn = normName(t.name);
        if (tn && (nn === tn || (tn.length > 4 && nn.indexOf(tn) >= 0))) hit = true;
        if (nn === normName(t.symbol) && nn === "flop") hit = true;
      }
      if (hit) out.push(t);
    });
    return out;
  }
  function hostOf(s) {
    var m = /^(?:[a-z]+:\/\/)?([^\/\s?#:]+)/i.exec(s.trim()); return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
  }
  function looksLikeAddress(s) {
    s = s.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s) || /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s) || /^[0-9A-F]{40}\./.test(s);
  }
  function tokenLine(t) {
    return "<li><b>" + esc(t.name) + "</b> (" + esc(t.symbol || "") + ") on " + esc(t.chain) +
      (t.address ? "<br><code>" + esc(t.address) + "</code>" : "") +
      (t.pair_created ? '<br><span class="muted small">Pair created ' + esc(dateOnly(t.pair_created)) + "</span>" : "") +
      (t.url ? " · " + link(t.url, "DexScreener") : "") + "</li>";
  }
  var STATEMENT = '<p class="muted small">No official FLOP token exists before mainnet/TGE (targeted Q1 2027). Official domains: flop.finance, flop.network, ask.flop.finance, technocore.chat, github.com/flop-labs.</p>';

  function runCheck(input) {
    var box = $("#ck-result"), raw = (input || "").trim();
    if (!raw) { box.innerHTML = '<div class="ck-card info"><h3>Paste an address or a name</h3><p>For example a Solana mint address, a DexScreener link’s token, or a name like “Flop Network”.</p></div>'; return; }
    var host = hostOf(raw);
    if (/\./.test(host) && !looksLikeAddress(raw) && !/\s/.test(raw)) {
      var official = OFFICIAL_DOMAINS.some(function (d) { return host === d || host.slice(-(d.length + 1)) === "." + d; }) ||
        /^github\.com\/flop-labs(\/|$)/i.test(raw.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, ""));
      if (official) { box.innerHTML = '<div class="ck-card info"><h3>✓ Official Flop domain</h3><p><code>' + esc(host) + "</code> is on the official list. Even so, Flop Labs sells no token: any page there offering one is not genuine.</p>" + STATEMENT + "</div>"; return; }
      if (/flop|technocore/.test(host)) { box.innerHTML = '<div class="ck-card warn"><h3>⚠ Not an official Flop domain</h3><p><code>' + esc(host) + "</code> uses the Flop name but is not on the official list. Treat it as a lookalike: never connect a wallet or enter a seed phrase there.</p>" + STATEMENT + "</div>"; return; }
    }
    var ms = findMatches(raw), fakes = ms.filter(isFake), others = ms.filter(function (t) { return !isFake(t); });
    var html = "";
    if (fakes.length) {
      html += '<div class="ck-card bad"><h3>✕ Known fake: not an official FLOP token</h3><p>' +
        (fakes.length > 1 ? "These tokens match" : "This token matches") + " our list of tokens trading under the FLOP name or ticker. Flop Labs has no token.</p><ul>" +
        fakes.map(tokenLine).join("") + "</ul>" +
        (others.length ? "<p>Also matched an unrelated token with the same ticker:</p><ul>" + others.map(tokenLine).join("") + "</ul><p class=\"muted small\">“Flopcoin” on PulseChain pre-dates Flop Labs and is an unrelated name collision.</p>" : "") +
        STATEMENT + "</div>";
    } else if (others.length) {
      html += '<div class="ck-card warn"><h3>⚠ Unrelated token, not Flop Network</h3><p>This is “Flopcoin” on PulseChain, an older token that shares the FLOP ticker by coincidence. It has nothing to do with Flop Labs or the Flop Network.</p><ul>' +
        others.map(tokenLine).join("") + "</ul>" + STATEMENT + "</div>";
    } else if (looksLikeAddress(raw) || /flop|technocore/i.test(raw)) {
      html += '<div class="ck-card warn"><h3>⚠ Not on our list, and still not official</h3><p>We have no record of this one, but that does not make it safe. No official FLOP token exists before mainnet/TGE, so any token presented as FLOP, Flop Labs or Flop Network today is not from Flop Labs.</p>' + STATEMENT + "</div>";
    } else {
      html += '<div class="ck-card info"><h3>No match</h3><p>That doesn’t match any known fake FLOP token. Remember: there is no official FLOP token yet, so nothing sold as FLOP is genuine.</p>' + STATEMENT + "</div>";
    }
    box.innerHTML = html;
  }

  function renderFakeList() {
    var fakes = tokens().filter(isFake);
    if (!fakes.length) return;
    $("#fake-list").innerHTML = fakes.map(function (t) {
      var a = t.address || "", short = t.chain === "xrpl" ? "" : (a.length > 14 ? a.slice(0, 5) + "…" + a.slice(-4) : a);
      return '<li title="' + esc(a) + '"><b>' + esc(t.name) + "</b> · " + esc(t.chain === "xrpl" ? "XRPL" : t.chain.charAt(0).toUpperCase() + t.chain.slice(1)) + (short ? " · " + esc(short) : "") + "</li>";
    }).join("");
  }

  function bindChecker() {
    $("#checker-form").addEventListener("submit", function (e) { e.preventDefault(); runCheck($("#tok").value); });
  }

  /* ---------- static bits ---------- */
  function paintWeights() { $$(".weights .bar").forEach(function (b) { b.style.setProperty("--w", (+b.getAttribute("data-w") / 25 * 100) + "%"); }); }

  function bindMenu() {
    var btn = $(".menu-btn"), nav = $(".nav"); if (!btn) return;
    function set(open) { nav.classList.toggle("menu-open", open); btn.setAttribute("aria-expanded", String(open)); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); }
    btn.addEventListener("click", function () { set(btn.getAttribute("aria-expanded") !== "true"); });
    $$("#nav-list a").forEach(function (a) { a.addEventListener("click", function () { set(false); }); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && nav.classList.contains("menu-open")) { set(false); btn.focus(); } });
    document.addEventListener("click", function (e) { if (nav.classList.contains("menu-open") && !e.target.closest(".nav")) set(false); });
  }

  function openFromHash() {
    if (!location.hash || location.hash.indexOf("#app=") !== 0 || !state.apps.length) return;
    var id = decodeURIComponent(location.hash.slice(5));
    var app = state.apps.filter(function (a) { return a.id === id; })[0]; if (!app) return;
    if (isGuideRow(app) && state.view !== "guides") setView("guides");
    state.open[id] = true; renderTable();
    var vis = [$('.lc[data-id="' + cssEsc(id) + '"]'), $('tr.row[data-id="' + cssEsc(id) + '"]')].filter(function (e) { return e && e.offsetParent; })[0];
    if (vis) vis.scrollIntoView({ block: "start" });
  }

  function init() {
    paintWeights(); bindMenu(); bindTable(); bindChecker();
    fetch(DATA_URL, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
    }).then(function (d) {
      state.data = d; state.apps = d.apps || [];
      renderSummary(d); populateCategories(); updateSortHeaders(); renderTable(); renderScams(d); renderFakeList();
      openFromHash();
      window.addEventListener("hashchange", openFromHash);
    }).catch(function (err) {
      $("#lb-body").innerHTML = '<tr><td colspan="10" class="empty">Couldn’t load the leaderboard data. <a href="' + DATA_URL + '">Open leaderboard.json</a> directly.</td></tr>';
      $("#lb-cards").innerHTML = '<li class="lc-empty">Couldn’t load the leaderboard data. <a href="' + DATA_URL + '">Open leaderboard.json</a> directly.</li>';
      if (window.console) console.warn("FlopRadar: data load failed", err);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
