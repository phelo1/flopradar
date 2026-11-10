#!/usr/bin/env python3
"""Direct-upload deploy of public/ to the Cloudflare Pages project 'flopradar'
(the same protocol wrangler uses), with curl.

Why not wrangler: where the Cloudflare API token is injected by an HTTP
proxy for api.cloudflare.com, which also overwrites the short-lived upload JWT that the
asset endpoints need. So: account-token calls go through the proxy; JWT calls
(/pages/assets/*) go direct with --noproxy. On a normal machine you can simply run
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler pages deploy public --project-name flopradar --branch main
"""
import base64, json, os, pathlib, sys, subprocess, mimetypes, tempfile
from blake3 import blake3

ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "<your-account-id>")
PROJECT = os.environ.get("CF_PAGES_PROJECT", "flopradar")
BRANCH = os.environ.get("CF_BRANCH", "main")
API = "https://api.cloudflare.com/client/v4"
PUB = pathlib.Path(os.environ.get("CF_PUBLIC_DIR", pathlib.Path(__file__).resolve().parent / "public"))
SPECIAL = {"_headers", "_redirects", "_routes.json"}

def curl(args, direct=False, body=None):
    cmd = ["curl", "-sS"] + (["--noproxy", "*"] if direct else []) + args
    if body is not None:
        tf = tempfile.NamedTemporaryFile("w", delete=False, suffix=".json"); tf.write(body); tf.close()
        cmd += ["-H", "content-type: application/json", "--data-binary", "@" + tf.name]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    d = json.loads(out)
    if not d.get("success"):
        sys.exit(f"Cloudflare API error on {args[-1] if args else ''}: {d.get('errors')}")
    return d.get("result")

files, special = {}, []
for f in sorted(PUB.rglob("*")):
    if not f.is_file(): continue
    if f.name in SPECIAL and f.parent == PUB:
        special.append(f); continue
    data = f.read_bytes(); ext = f.suffix.lstrip(".")
    b64 = base64.b64encode(data).decode()
    h = blake3((b64 + ext).encode()).hexdigest()[:32]
    files["/" + f.relative_to(PUB).as_posix()] = (h, b64, mimetypes.guess_type(f.name)[0] or "application/octet-stream")

jwt = curl([f"{API}/accounts/{ACCOUNT}/pages/projects/{PROJECT}/upload-token"])["jwt"]
auth = ["-H", f"Authorization: Bearer {jwt}"]
hashes = sorted({v[0] for v in files.values()})
missing = set(curl(["-X", "POST"] + auth + [f"{API}/pages/assets/check-missing"], direct=True, body=json.dumps({"hashes": hashes})))
payload = [{"key": h, "value": b64, "metadata": {"contentType": ct}, "base64": True}
           for (h, b64, ct) in {v[0]: v for v in files.values()}.values() if h in missing]
if payload:
    curl(["-X", "POST"] + auth + [f"{API}/pages/assets/upload"], direct=True, body=json.dumps(payload))
curl(["-X", "POST"] + auth + [f"{API}/pages/assets/upsert-hashes"], direct=True, body=json.dumps({"hashes": hashes}))

manifest = {path: v[0] for path, v in files.items()}
form = ["-F", "manifest=" + json.dumps(manifest), "-F", f"branch={BRANCH}"]
for f in special:
    form += ["-F", f"{f.name}=@{f};filename={f.name}"]
r = curl(["-X", "POST"] + form + [f"{API}/accounts/{ACCOUNT}/pages/projects/{PROJECT}/deployments"])
print(json.dumps({"deployment_id": r.get("id"), "url": r.get("url"), "uploaded": len(payload), "files": len(manifest)}, indent=1))
