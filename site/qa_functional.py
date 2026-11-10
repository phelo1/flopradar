#!/usr/bin/env python3
"""Functional QA of FlopRadar (desktop table + mobile cards + checker + data accuracy).
Usage: python3 qa_functional.py [url]   (default: local server on public/)"""
import sys, threading, http.server, functools, pathlib, re, json
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
PUB = HERE / "public"
DATA = json.loads((HERE.parent / "data" / "leaderboard.json").read_text())
url = sys.argv[1] if len(sys.argv) > 1 else None
if not url:
    csp = re.search(r"Content-Security-Policy: (.+)", (PUB / "_headers").read_text()).group(1).strip()
    class H(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Content-Security-Policy", csp); super().end_headers()
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), functools.partial(H, directory=str(PUB)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:8767/"

res, errors = [], []
def ok(name, cond, info=""):
    res.append((bool(cond), name, info)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

def goto(pg, u):
    for i in range(8):
        try: pg.goto(u, wait_until="networkidle", timeout=30000); return
        except Exception:
            if i == 7: raise
            pg.wait_for_timeout(4000)

ranked = sorted([a for a in DATA["apps"] if isinstance(a.get("rank"), int) and not a.get("excluded_from_ranking")], key=lambda a: a["rank"])
S = DATA["summary"]
with sync_playwright() as p:
    b = p.firefox.launch(firefox_user_prefs={"network.proxy.type": 0})
    # ---------------- desktop ----------------
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    goto(pg, url); pg.wait_for_selector("tr.row")
    ok("title", "FlopRadar" in pg.title(), pg.title())
    ok("stats items/ranked/flagged", [pg.inner_text(f'.stat [data-stat="{k}"]') for k in ("items", "ranked", "flagged")] == [str(S["items"]), str(S["ranked_overall"]), str(S["flagged"])])
    cv = S["claims_check"]["verdicts"]
    ok("claims counts 42/7/3/1", all(pg.inner_text(f'.claims-legend [data-claims="{k}"]') == str(v) for k, v in cv.items()), str(cv))
    ok("tab counts", pg.inner_text('[data-count="overall"]') == "40" and pg.inner_text('[data-count="guides"]') == "10")
    rows = pg.locator("tr.row")
    ok("40 ranked rows", rows.count() == len(ranked) == 40, str(rows.count()))
    ids = [rows.nth(i).get_attribute("data-id") for i in range(rows.count())]
    ok("rank order matches data", ids == [a["id"] for a in ranked])
    sc = [pg.locator("tr.row .score b").nth(i).inner_text() for i in range(rows.count())]
    ok("scores match data", sc == [("%g" % round(a["trust_score"], 1)) for a in ranked], f"{sc[:3]}…")
    ok("no excluded app in table", not any(a["id"] in ids for a in DATA["apps"] if a.get("excluded_from_ranking")))
    # anchors
    for a in ["#leaderboard", "#checker", "#scams", "#methodology", "#api"]:
        pg.click(f'.nav a[href="{a}"]'); pg.wait_for_timeout(700)
        top = pg.evaluate(f"document.querySelector('{a}').getBoundingClientRect().top")
        ok(f"nav anchor {a}", -5 <= top <= 120, f"top={top:.0f}")
    # sort each column
    for key in ["rank", "name", "category", "trust_score", "reliability", "quality", "safety", "speed", "cost", "claims_verdict"]:
        btn = pg.locator(f'th[data-sort="{key}"] button')
        btn.click(); pg.wait_for_timeout(120)
        s1 = pg.get_attribute(f'th[data-sort="{key}"]', "aria-sort"); first1 = pg.locator("tr.row").first.get_attribute("data-id")
        btn.click(); pg.wait_for_timeout(120)
        s2 = pg.get_attribute(f'th[data-sort="{key}"]', "aria-sort"); first2 = pg.locator("tr.row").first.get_attribute("data-id")
        ok(f"sort {key} toggles", s1 and s2 and s1 != s2 and pg.locator("tr.row").count() == 40, f"{s1}:{first1} / {s2}:{first2}")
    pg.click('th[data-sort="trust_score"] button'); pg.wait_for_timeout(100)
    if pg.get_attribute('th[data-sort="trust_score"]', "aria-sort") != "descending": pg.click('th[data-sort="trust_score"] button')
    vals = [float(x) for x in pg.locator("tr.row .score b").all_inner_texts()]
    ok("score sort descending is monotonic", vals == sorted(vals, reverse=True))
    pg.click('th[data-sort="rank"] button'); pg.wait_for_timeout(100)
    if pg.get_attribute('th[data-sort="rank"]', "aria-sort") != "ascending": pg.click('th[data-sort="rank"] button')
    # search + category
    pg.fill("#q", "miner"); pg.wait_for_timeout(300)
    n = pg.locator("tr.row").count(); ok("search 'miner'", 0 < n < 40, str(n))
    pg.fill("#q", "zzzzqqq"); pg.wait_for_timeout(300); ok("search no-match message", "No apps match" in pg.inner_text("#lb-body"))
    pg.fill("#q", ""); pg.wait_for_timeout(300)
    opts = pg.locator("#cat option").all_inner_texts(); ok("category options", len(opts) > 3, f"{len(opts)} options")
    pg.select_option("#cat", index=1); pg.wait_for_timeout(200)
    m = re.search(r"\((\d+)\)", opts[1]); n = pg.locator("tr.row").count()
    ok("category filter count", m and int(m.group(1)) == n, f"{opts[1]} -> {n}")
    pg.select_option("#cat", index=0); pg.wait_for_timeout(200)
    # expand/collapse
    pg.locator('tr.row').nth(0).locator(".exp").click(); pg.wait_for_timeout(200)
    ok("row expands", pg.locator("tr.detail").count() == 1 and pg.get_attribute("tr.row >> nth=0 >> .exp", "aria-expanded") == "true")
    pg.locator('tr.row').nth(0).locator(".exp").click(); pg.wait_for_timeout(200)
    ok("row collapses", pg.locator("tr.detail").count() == 0)
    pg.click('tr.row[data-id="alpertungax1-toolkit"] .exp') if pg.locator('tr.row[data-id="alpertungax1-toolkit"]').count() else None
    ok("caution detail", "EVM private key" in (pg.inner_text("tr.detail") if pg.locator("tr.detail").count() else ""))
    # guides
    pg.click('[data-view="guides"]'); pg.wait_for_timeout(200)
    ok("guides tab 10 rows", pg.locator("tr.row").count() == 10 and pg.get_attribute("#tab-guides", "aria-selected") == "true")
    pg.click('[data-view="overall"]'); pg.wait_for_timeout(200)
    # scams
    ok("3 scam cards", pg.locator("#scam-grid .scam").count() == 3)
    # checker
    def check(q):
        pg.fill("#tok", q); pg.click("#checker-form button"); pg.wait_for_timeout(120); return pg.inner_text("#ck-result h3")
    cases = [("HwCG1…pump", "Known fake"), ("4ddZmkmhHJ2C6436znty5s3YpezEkEX6S1oebwhapump", "Known fake"), ("BiqJ...pump", "Known fake"),
             ("Flop Network", "Known fake"), ("FLOP", "Known fake"), ("Flip", "Known fake"),
             ("0xA8B4e655d77aC9AE98521b53bB6b9b26a7F93c68", "Unrelated token"), ("flop.network", "Official Flop domain"),
             ("https://docs.flop.network/x", "Official Flop domain"), ("flop-airdrop.xyz", "Not an official Flop domain"),
             ("fl0p-network.com", "No match"), ("So11111111111111111111111111111111111111112", "Not on our list"),
             ("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "Not on our list"), ("bitcoin", "No match"), ("", "Paste an address")]
    for q, exp in cases:
        h = check(q); ok(f"checker {q!r}", exp.lower() in h.lower(), h)
    # hash deep link
    pg.goto("about:blank"); goto(pg, url + "#app=zkasuran-flop-lab"); pg.wait_for_selector("tr.row"); pg.wait_for_timeout(300)
    ok("#app= deep link opens row", pg.locator("tr.detail").count() == 1)
    pg.close()
    # ---------------- mobile ----------------
    pg = b.new_page(viewport={"width": 375, "height": 812}, has_touch=True, is_mobile=False)
    pg.on("console", lambda m: errors.append(f"[m] console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: errors.append(f"[m] pageerror: {e}"))
    goto(pg, url); pg.wait_for_selector(".lc")
    ok("mobile: table hidden, 40 cards", not pg.is_visible(".lb-wrap") and pg.locator(".lc").count() == 40)
    ok("mobile: no horizontal scroll", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    ok("mobile: nav links hidden behind menu", not pg.is_visible("#nav-list a"))
    for a in ["#leaderboard", "#checker", "#scams", "#methodology", "#api"]:
        pg.click(".menu-btn"); pg.wait_for_timeout(200)
        vis = pg.is_visible(f'#nav-list a[href="{a}"]')
        pg.click(f'#nav-list a[href="{a}"]'); pg.wait_for_timeout(800)
        top = pg.evaluate(f"document.querySelector('{a}').getBoundingClientRect().top")
        ok(f"mobile menu -> {a}", vis and -5 <= top <= 110 and pg.get_attribute(".menu-btn", "aria-expanded") == "false", f"top={top:.0f}")
    pg.click(".menu-btn"); pg.keyboard.press("Escape"); ok("menu closes on Escape", pg.get_attribute(".menu-btn", "aria-expanded") == "false")
    first = pg.locator(".lc").first
    first.locator(".lc-head").click(); pg.wait_for_timeout(200)
    ok("mobile card expands", pg.locator(".lc.open .lc-detail").count() == 1 and pg.get_attribute(".lc >> nth=0 >> .lc-head", "aria-expanded") == "true")
    ok("mobile detail shows metrics", all(k in pg.inner_text(".lc.open .lc-detail") for k in ("Reliability", "Quality", "Safety", "Speed", "Cost")))
    pg.locator(".lc").first.locator(".lc-head").click(); pg.wait_for_timeout(200)
    ok("mobile card collapses", pg.locator(".lc.open").count() == 0)
    for key in ["trust_score", "name", "category", "reliability", "quality", "safety", "speed", "cost", "claims_verdict", "rank"]:
        pg.select_option("#sort-m", key); pg.wait_for_timeout(150)
        f1 = pg.locator(".lc").first.get_attribute("data-id")
        pg.click("#sort-dir"); pg.wait_for_timeout(150)
        f2 = pg.locator(".lc").first.get_attribute("data-id")
        ok(f"mobile sort {key} + reverse", pg.locator(".lc").count() == 40 and (f1 != f2 or key in ("cost",)), f"{f1} / {f2}")
    pg.click("#sort-dir"); pg.wait_for_timeout(100)
    ok("mobile rank order restored", pg.locator(".lc").first.get_attribute("data-id") == ranked[0]["id"])
    pg.fill("#q", "miner"); pg.wait_for_timeout(300); ok("mobile search", 0 < pg.locator(".lc").count() < 40)
    pg.fill("#q", ""); pg.wait_for_timeout(300)
    pg.click('[data-view="guides"]'); pg.wait_for_timeout(200); ok("mobile guides 10 cards", pg.locator(".lc").count() == 10)
    pg.click('[data-view="overall"]')
    pg.fill("#tok", "HwCG1…pump"); pg.click("#checker-form button"); pg.wait_for_timeout(150)
    ok("mobile checker", "Known fake" in pg.inner_text("#ck-result h3"))
    ok("viewport meta", "width=device-width" in pg.get_attribute('meta[name="viewport"]', "content"))
    pg.close(); b.close()
print("ERRORS:" if errors else "No console errors.", *errors, sep="\n")
f = [r for r in res if not r[0]]
print(f"\n{len(res) - len(f)}/{len(res)} passed")
for r in f: print("FAILED:", r[1], r[2])
