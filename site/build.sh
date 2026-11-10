#!/usr/bin/env bash
# FlopRadar build + pre-deploy safety check. Deploy directory = site/public (static files only).
set -euo pipefail
cd "$(dirname "$0")"
python3 sanitize.py
PUB=public
# 1. only expected file types in the deploy dir
bad_files=$(find "$PUB" -type f ! \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.svg' -o -name '*.png' -o -name '*.txt' -o -name '*.xml' -o -name '_headers' -o -name '_redirects' \) )
[ -z "$bad_files" ] || { echo "Unexpected files in $PUB:"; echo "$bad_files"; exit 1; }
find "$PUB" \( -name '.env*' -o -name '*.pem' -o -name '*key*' -o -name '.git' \) | grep . && { echo "Key-like file in $PUB"; exit 1; } || true
# 2. hard fails
grep -rIl -e '-----BEGIN' -e 'keys-backup' -e '/workspace' "$PUB" && { echo "Forbidden content found"; exit 1; } || true
grep -rIiwl 'mnemonic' "$PUB" && { echo "'mnemonic' found"; exit 1; } || true
# 3. 64+ hex strings must only be public explorer tx/channel hashes
if grep -rIoE '.{0,60}[0-9a-fA-F]{64,}' "$PUB" | grep -v 'explorer.devnet.flop.network/' ; then echo "Unexpected 64+ hex string"; exit 1; fi
# 4. report (for human review) words that are expected in descriptive text
echo "Review hits for private/secret/seed (descriptive text only expected):"
grep -rIoiE '.{0,50}(private|secret|seed).{0,40}' "$PUB" | sort | uniq -c | sort -rn
echo "BUILD OK: $(find "$PUB" -type f | wc -l) files in $PUB"
