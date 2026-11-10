#!/usr/bin/env python3
"""Responsive QA: screenshots at phone/tablet/desktop widths + overflow / tap-target / font-size audit.
Usage: python3 qa_mobile.py [url] [outdir]   (default: local server on public/, out screenshots/qa-local)"""
import sys, threading, http.server, functools, pathlib, re, json
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
PUB = HERE / "public"
url = sys.argv[1] if len(sys.argv) > 1 else None
OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "screenshots" / ("qa-live" if url else "qa-local")
OUT.mkdir(parents=True, exist_ok=True)
if not url:
    csp = re.search(r"Content-Security-Policy: (.+)", (PUB / "_headers").read_text()).group(1).strip()
    class H(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Content-Security-Policy", csp); super().end_headers()
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), functools.partial(H, directory=str(PUB)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:8766/"

AUDIT = r"""() => {
  const W = document.documentElement.clientWidth, out = {sw: document.documentElement.scrollWidth, W, over: [], small: [], tiny: []};
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('.radar,.sr,.skip')) continue;
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
    if (r.right > W + 1 || r.left < -1) out.over.push(el.tagName + '.' + el.className + ' ' + Math.round(r.left) + '-' + Math.round(r.right));
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (hasText && parseFloat(cs.fontSize) < 14) out.tiny.push(el.tagName + '.' + el.className + ' ' + cs.fontSize + ' "' + el.textContent.trim().slice(0, 30) + '"');
    if (el.matches('a,button,input,select,summary,[role=tab]')) {
      if ((r.height < 44 || r.width < 44) && !el.closest('p,li,dd,.dbox p') ) out.small.push(el.tagName + '.' + el.className + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + el.textContent.trim().slice(0, 24) + '"');
    }
  }
  out.over = [...new Set(out.over)].slice(0, 25); out.tiny = [...new Set(out.tiny)].slice(0, 40); out.small = [...new Set(out.small)].slice(0, 40);
  return out;
}"""

import os
widths = [int(x) for x in os.environ.get("WIDTHS", "320,360,375,390,414,430,768,1280,1440").split(",")]
errors, report = [], {}
with sync_playwright() as p:
    b = p.firefox.launch(firefox_user_prefs={"network.proxy.type": 0})
    for w in widths:
        mobile = w < 760
        ctx = b.new_context(viewport={"width": w, "height": 844 if mobile else 900}, device_scale_factor=1)
        pg = ctx.new_page()
        pg.on("console", lambda m, w=w: errors.append(f"[{w}] console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e, w=w: errors.append(f"[{w}] pageerror: {e}"))
        for attempt in range(8):
            try:
                pg.goto(url, wait_until="networkidle", timeout=30000); break
            except Exception as e:
                if attempt == 7: raise
                pg.wait_for_timeout(4000)
        pg.wait_for_selector("tr.row", state="attached")
        pg.wait_for_timeout(300)
        report[w] = pg.evaluate(AUDIT)
        pg.screenshot(path=str(OUT / f"w{w}-top.png"))
        pg.screenshot(path=str(OUT / f"w{w}-full.png"), full_page=True)
        if w in (375, 390, 1440):
            pg.locator("#leaderboard").scroll_into_view_if_needed(); pg.evaluate("document.querySelector('#leaderboard').scrollIntoView({behavior: 'instant'})")
            pg.wait_for_timeout(200); pg.screenshot(path=str(OUT / f"w{w}-leaderboard.png"))
            if w <= 900: pg.locator(".lc-head").nth(1).click()
            else: pg.locator(".row .exp").nth(1).click()
            pg.wait_for_timeout(250)
            if not pg.locator(".lc.open, tr.row.open").count():
                print(f"[{w}] WARN first expand click did not open; retrying"); (pg.locator(".lc-head").nth(1) if w <= 900 else pg.locator(".row .exp").nth(1)).click(); pg.wait_for_timeout(300)
            pg.evaluate("window.scrollTo({top: document.querySelector('.lc.open, tr.row.open').getBoundingClientRect().top + scrollY - 70, behavior: 'instant'})"); pg.wait_for_timeout(150)
            pg.screenshot(path=str(OUT / f"w{w}-expanded.png"))
            report[str(w) + "-expanded"] = pg.evaluate(AUDIT)
            if mobile:
                t = pg.locator(".menu-btn")
                if t.count():
                    pg.evaluate("window.scrollTo({top: 0, behavior: 'instant'})"); t.click(); pg.wait_for_timeout(250)
                    pg.screenshot(path=str(OUT / f"w{w}-menu.png"))
        ctx.close()
    b.close()
for k, v in report.items():
    print(f"== {k}: scrollWidth {v['sw']} / {v['W']}  overflow:{len(v['over'])} small-taps:{len(v['small'])} tiny-text:{len(v['tiny'])}")
    for x in v["over"]: print("   OVER", x)
    if k in (320, 375, "375-expanded", 768, 1440):
        for x in v["small"]: print("   TAP", x)
        for x in v["tiny"]: print("   FONT", x)
print("ERRORS:" if errors else "No console errors.", *errors, sep="\n")
