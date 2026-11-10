#!/usr/bin/env python3
"""Build the public copy of the leaderboard for FlopRadar.

Reads  ../data/leaderboard.json  (scorer output)
Writes public/data/leaderboard.json  (what the site and the free download serve)

Strips anything internal: judge-agent wallet/key details, local or repo file
paths, internal design-doc pointers. Fails loudly if anything that looks like a
key, mnemonic or local path survives.
"""
import json, re, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent / "data" / "leaderboard.json"
DST = HERE / "public" / "data" / "leaderboard.json"

d = json.loads(SRC.read_text())

ALLOWED_TOP = ["schema_version", "name", "network", "generated_at", "status", "weights",
               "voting", "summary", "leaderboard", "categories", "apps", "warnings"]
out = {k: d[k] for k in ALLOWED_TOP if k in d}
out["name"] = "FlopRadar: independent trust scores for Flop Network apps"
out["publisher"] = "FlopRadar (flopradar.com). Independent. Not affiliated with Flop Labs."
out["licence_note"] = "Free to download and reuse with attribution to flopradar.com."
out["methodology"] = "https://flopradar.com/#methodology"

# voting: keep public parameters only
v = out.get("voting", {})
out["voting"] = {"enabled": bool(v.get("enabled")), "max_weight": v.get("max_weight", 0.15),
                 "voter_weights": v.get("voter_weights", {}), "status": "Community voting opens soon"}

# summary: drop internal source path
cc = out["summary"].get("claims_check", {})
cc.pop("source", None)

PATH_RE = re.compile(r"\s*\((?:scorer|data|evidence)/[^)]*\)")
def clean_str(s):
    s = PATH_RE.sub("", s)
    return s

def walk(x):
    if isinstance(x, dict):
        return {k: walk(v) for k, v in x.items()}
    if isinstance(x, list):
        return [walk(v) for v in x]
    if isinstance(x, str):
        return clean_str(x)
    return x

apps = []
for a in out["apps"]:
    a = dict(a)
    a.pop("votes", None)  # all zero; aggregate kept as community_* fields
    apps.append(a)
out["apps"] = apps
out = walk(out)

txt = json.dumps(out, indent=1, ensure_ascii=False)

# Hard safety checks
bad = [r"-----BEGIN", r"/workspace", r"keys-backup", r"/home/", r"\.env\b", r"gateway-key", r"agent-key-",
       r"\bmnemonic\b"]
for pat in bad:
    if re.search(pat, txt, re.I):
        sys.exit(f"sanitize: forbidden pattern {pat!r} found in output; aborting")
# 64+ hex strings are allowed only inside public explorer URLs (tx / channel hashes)
for m in re.finditer(r"[0-9a-fA-F]{64,}", txt):
    ctx = txt[max(0, m.start() - 60):m.start()]
    if "explorer.devnet.flop.network/" not in ctx:
        sys.exit(f"sanitize: 64+ hex string outside an explorer URL: ...{ctx[-40:]}{m.group()[:8]}...")

DST.parent.mkdir(parents=True, exist_ok=True)
DST.write_text(txt + "\n")
print(f"wrote {DST} ({len(txt)} bytes, {len(apps)} apps)")
