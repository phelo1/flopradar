#!/usr/bin/env python3
"""Local render check: serves public/ with the production CSP, opens it in headless
Firefox (Playwright), exercises the leaderboard and token checker, records console
errors, and saves screenshots to screenshots/. Usage: python3 check.py [url]"""
import sys, threading, http.server, functools, pathlib, re
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
PUB = HERE / "public"
SHOTS = HERE / "screenshots" / ("live" if len(sys.argv) > 1 else ""); SHOTS.mkdir(parents=True, exist_ok=True)

def csp():
    m = re.search(r"Content-Security-Policy: (.+)", (PUB / "_headers").read_text())
    return m.group(1).strip()

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", csp())
        super().end_headers()
    def log_message(self, *a): pass

url = sys.argv[1] if len(sys.argv) > 1 else None
local = url is None
if not url:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), functools.partial(H, directory=str(PUB)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:8765/"

errors = []
with sync_playwright() as p:
    # local: bypass any sandbox HTTP proxy for 127.0.0.1
    b = p.firefox.launch(firefox_user_prefs={"network.proxy.type": 0})
    for name, vp in [("desktop", {"width": 1440, "height": 900}), ("mobile", {"width": 390, "height": 844})]:
        pg = b.new_page(viewport=vp)
        pg.on("console", lambda m, n=name: errors.append(f"[{n}] console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e, n=name: errors.append(f"[{n}] pageerror: {e}"))
        pg.on("requestfailed", lambda r, n=name: errors.append(f"[{n}] requestfailed: {r.url}"))
        pg.goto(url, wait_until="networkidle")
        pg.wait_for_selector("tr.row")
        rows = pg.locator("tr.row").count()
        pg.screenshot(path=str(SHOTS / f"{name}-top.png"))
        pg.screenshot(path=str(SHOTS / f"{name}-full.png"), full_page=True)
        print(name, "rows:", rows)
        if name == "desktop":
            pg.click('tr.row[data-id="alpertungax1-toolkit"] .exp')
            pg.wait_for_selector("tr.detail")
            pg.locator('tr.row[data-id="alpertungax1-toolkit"]').scroll_into_view_if_needed()
            pg.screenshot(path=str(SHOTS / "desktop-expanded.png"))
            print("caution shown:", "EVM private key" in pg.inner_text("tr.detail"))
            pg.click('[data-view="guides"]'); print("guides rows:", pg.locator("tr.row").count())
            pg.click('[data-view="overall"]')
            pg.fill("#q", "miner"); pg.wait_for_timeout(300); print("search 'miner' rows:", pg.locator("tr.row").count())
            pg.fill("#q", ""); pg.wait_for_timeout(200)
            pg.click('th[data-sort="trust_score"] button'); print("sorted first:", pg.locator("tr.row").first.get_attribute("data-id"))
            for q in ["HwCG1…pump", "4ddZmkmhHJ2C6436znty5s3YpezEkEX6S1oebwhapump", "Flop Network", "Flip", "FLOP",
                      "0xA8B4e655d77aC9AE98521b53bB6b9b26a7F93c68", "flop.network", "flop-airdrop.xyz", "So11111111111111111111111111111111111111112", "bitcoin"]:
                pg.fill("#tok", q); pg.click("#checker-form button")
                print(f"check {q!r}:", pg.inner_text("#ck-result h3"))
            pg.fill("#tok", "BiqJ…pump"); pg.click("#checker-form button")
            pg.locator("#checker").scroll_into_view_if_needed()
            pg.screenshot(path=str(SHOTS / "desktop-checker.png"))
            pg.locator("#scams").scroll_into_view_if_needed(); pg.screenshot(path=str(SHOTS / "desktop-scams.png"))
        pg.close()
    b.close()
print("ERRORS:" if errors else "No console errors.", *errors, sep="\n")
