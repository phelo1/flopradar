# FlopRadar site: build and deploy

Static site, no framework. The deploy directory is `site/public/` and contains only site files:
`index.html`, `404.html`, `styles.css`, `app.js`, `favicon.svg`, `apple-touch-icon.png`, `og.png`, `robots.txt`, `sitemap.xml`, `_headers`, `data/leaderboard.json`.
Responsive: below 900px the leaderboard renders as tap-to-expand cards (`#lb-cards`) with a sort dropdown; below 820px the nav is a hamburger menu; the API table stacks below 760px.
The page reads `/data/leaderboard.json` at runtime, so updating that file updates the site.

## Where it lives (set up 2026-11-10)
| Thing | Value |
|---|---|
| Cloudflare account | your Cloudflare account (set CF_ACCOUNT_ID and a Pages-scoped API token) |
| Pages project | `flopradar` → https://flopradar.pages.dev (production branch `main`) |
| Custom domains on it | `flopradar.com`, `www.flopradar.com` (DNS: proxied CNAME → `flopradar.pages.dev`) |
| Redirect project | `trustflop-redirect` → https://trustflop-redirect.pages.dev, serves only `_redirects`: `/* https://flopradar.com/:splat 301` |
| Custom domains on it | `trustflop.com`, `www.trustflop.com` (DNS: proxied CNAME → `trustflop-redirect.pages.dev`) |
| Zones (Free plan) | `flopradar.com` id `7bfacf8a99dc8d4b054e16c819db934e`; `trustflop.com` id `632e7602f1dbd37b7e5c0a657ba908b6`; Always Use HTTPS on |
| Registrar | Dynadot (both domains, registered 2026-11-10) |

**Go-live step (Brian, at Dynadot):** for BOTH flopradar.com and trustflop.com, set custom nameservers to
`heather.ns.cloudflare.com` and `keenan.ns.cloudflare.com` (replace `ns1/ns2.dyna-ns.net`). Turn DNSSEC off at Dynadot first if it is on.
Cloudflare activates the zones once it sees the change (minutes to a few hours), then the Pages custom domains validate and issue SSL automatically.

The token cannot edit Rulesets, which is why the trustflop.com 301 is a tiny Pages project rather than a Redirect Rule.
`www.flopradar.com/*` → `https://flopradar.com/$1` (301, path + query kept) is a free **Page Rule** on the flopradar.com zone (id `b2af85b5a9ba21b09a1b5cd117d11aa4`, added 2026-11-10).
Both zones: Always Use HTTPS on, minimum TLS 1.2 (raised from 1.0 on 2026-11-10).
Cloudflare injects its cookieless Web Analytics beacon at the edge; the CSP allows `static.cloudflareinsights.com` (script) and `cloudflareinsights.com` (connect) so it doesn't throw console errors.
Unknown paths return `404.html` with a real 404 status.

## Update the data or the page
```bash
cd trust-score/scorer && node score.mjs          # (optional) refresh ../data/leaderboard.json
cd ../site
./build.sh                                       # sanitize data -> public/data, then safety greps; must print BUILD OK
python3 check.py                                 # optional: headless Firefox render check + screenshots/ (needs playwright + firefox)
python3 qa_functional.py [url]                   # 76 functional checks (sort/search/filter/expand/guides/checker/menu/data accuracy)
WIDTHS=320,375,768,1440 python3 qa_mobile.py [url] [outdir]   # overflow / 44px tap / 14px font audit + screenshots
# sandbox setup if Firefox won't launch: pip install playwright; python3 -m playwright install firefox;
# sudo HOME=$HOME PYTHONPATH=~/.local/lib/python3.12/site-packages python3 -m playwright install-deps firefox
```

## Deploy
On a normal machine (wrangler):
```bash
cd trust-score/site
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
  npx wrangler pages deploy public --project-name flopradar --branch main
```
In environments where the token is injected by proxy for api.cloudflare.com; that proxy breaks wrangler's JWT asset upload):
```bash
pip install blake3                               # once
cd trust-score/site && ./build.sh && python3 deploy_api.py
# redirect project (only if _redirects changes):
CF_PAGES_PROJECT=trustflop-redirect CF_PUBLIC_DIR=$PWD/redirect-trustflop/public python3 deploy_api.py
python3 check.py https://flopradar.pages.dev/    # verify live (screenshots/live/)
```
New assets can take ~30 s to reach the edge after a deploy (brief 500s on fresh files are normal).

## Security rules for every deploy
- Deploy only `public/`. Never copy `flop/keys-backup`, any key file, `.env`, evidence repo clones or `work/claims` into it.
- `sanitize.py` keeps only public fields (drops judge-agent wallet details, internal file paths, raw vote objects) and aborts on key-like content.
- `build.sh` fails on unexpected file types, key-like filenames, `-----BEGIN`, `keys-backup`, `/workspace`, `mnemonic`, or any 64+ hex string that is not a public explorer tx/channel hash; it prints remaining "private/secret/seed" hits for review (all are descriptive text today).
- Payment never changes a score. No third-party repo code is run.
