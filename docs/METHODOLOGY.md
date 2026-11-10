# Flop App Trust Score: methodology (devnet prototype, v1.0, 2026-11-10)

An independent judging agent finds apps and tools built on the FLOP Network, tests them, and scores each one 0-100 on five measured metrics. Community votes can add a small, capped amount on top (see VOTING.md). Everything runs on the FLOP **devnet**. Devnet FLOP has no value and the network may reset, so scores are indicative only.

## 1. What gets listed
**Discovery sources:**
- GitHub repository search (`flop devnet`, `flop miner`, `flop network agent`, `flop gateway`, `flop sdk`, `flop inference`, `flop-labs`, `flop.finance`, `flop.network`, limited to pushes after 2026-10-01 where relevant)
- the `flop-labs` org
- `flop.network/llms.txt` (the official agent guide)
- the explorer and the community devnet board

**Kept:** items that target the FLOP Network: devnet compute, the gateway, miners and validators, and Technocore agents. Name collisions are dropped (FLOPs counters, "Floppydata" and similar).

**Hand-classified fields** (`scorer/candidates.json`, editable):
- `kind`: one of
  - `official_service`
  - `inference_app` (an app that buys FLOP inference)
  - `dashboard`
  - `tool`
  - `sdk`
  - `agent`
  - `miner_script`
  - `guide`
- `category`: one of
  - Chat assistants
  - Coding tools
  - Trading & crypto data
  - Research & analysis
  - Dashboards & explorers
  - Miner & validator tooling
  - Developer SDKs & APIs
  - Agent network & identity
  - Guides & docs
  - Other
- `service_description`: one line on what it does.

**Rankings:**
- The overall leaderboard ranks everything except guides.
- Guides are ranked only within their category.
- Items with a high-severity safety flag are left out of every ranking and listed under `warnings`. Official FLOP Labs items are never left out.

## 2. Metrics (each 0-100)
| Metric | Inference apps and official services | Dashboards, tools, repos |
|---|---|---|
| **Reliability** | Funded-channel settle rate for the app's on-chain agent account from `explorer.devnet.flop.network/api/compute-channels?agent=<ss58>` (500 most recent channels; settled ÷ (settled + timed-out), counting only channels with escrow above 1 wei; 1-wei gateway probes never settle for anyone and are excluded), plus endpoint health probes | Live-URL uptime probe (40%) + repo freshness (60%): ≤14 days since last push = 100, ≤30 = 75, ≤60 = 50, older = 25; scaled down for near-empty READMEs; archived = 0 |
| **Quality** | Fixed test set (`scorer/testset.json`, 8 prompts: arithmetic, facts, JSON format, code, instruction-following, a seed-phrase safety question). Each answer is graded by deterministic regex checks (75%). A judging pass run through FLOP itself scores it 0-10 (25%) | "Usefulness" heuristic: documentation depth, FLOP-specific content, cites official sources, has install/usage steps, live product, licence, stars. Official items have a floor of 70 |
| **Speed** | Streamed time to first token and full response time, each median over the test set (800 ms TTFT and 2 s total = 100; 15 s and 30 s = 0) | HTTP response time of the live URL (300 ms = 100; 5 s = 0); one probe from a US-East sandbox |
| **Cost** | Devnet FLOP per answer from the gateway's settled receipt (`settled_spend`), on a log scale: 0.01 FLOP = 100, 10 FLOP = 0 | Not applicable (free tools are not penalised) |
| **Safety** | Official domains only, no token-sale or secret-request patterns | Scan of the README and homepage text (see below) |

**Safety scan:**
- Starts at 100. Matches inside warning sentences ("there is no presale", "beware of fake tokens") are ignored.
- High severity (−40 to −45), each also removes the item from rankings:
  - token sale, presale, pump.fun, DEX, or contract-address promotion
  - asking the user to enter or paste a seed phrase or private key
  - a third party calling itself "Official"
  - tooling built to evade Sybil or bot detection
- Medium severity:
  - airdrop-farming automation (−20)
  - links to FLOP-named lookalike domains (−15)
  - "connect wallet" requests (−10)
- Low severity: `curl | sh` installers (−5).
- Bonuses (+5 each): warns users never to share keys; states clearly that it is unofficial or that there is no token.
- `data_access` lists the access the item asks for: read-only data, a local key file, a gateway key, the faucet, a wallet connection, root installers.

## 3. Combining scores
```
measured = Σ w_k · s_k / Σ w_k          weights: reliability .25, quality .25, speed .15, cost .10, safety .25
```
- Cost only counts for inference apps.
- A metric that applies but could not be measured enters as a neutral 50 at half weight. An item measured on more dimensions can therefore beat one that simply wasn't measured.
- **Safety gate:** if safety is below 50, the measured score is capped at the safety score.
- `confidence`: high = every applicable metric measured; medium = one missing; low = more missing.

```
trust_score = (1 − w_c) · measured + w_c · community_score
w_c = 0.15 · min(1, effective_weighted_votes / 50)
```
Details are in VOTING.md. `w_c` is 0 today because there are no votes yet.

## 3a. Claims check (added 2026-11-10)
For every item, the judge lists 2-4 concrete claims from its README or homepage, such as "one command installs worker + backend", "JSON API at /api/snapshot" or "images pinned by official digest". It then tests whatever it can for free and without risk:
- **Live checks:** fetch the advertised URLs and APIs and confirm they return what is described, including how fresh the data is.
- **Repo checks:** shallow clone; confirm the advertised entry points, commands, endpoints and files exist; syntax-check every script (`bash -n`, `node --check`, `python -m py_compile`).
- **Integrity checks:** where an installer claims to verify official images or packs, compare its pinned digest or fingerprint with GHCR, `flop.network/releases.json` or the official miner SKILL.md.

Repo code is treated as untrusted data and is never executed. The judge runs no installers that need root, GPUs, keys or wallets, signs nothing, spends nothing, and posts nothing.

**Verdicts:**
- **Verified:** all main claims check out.
- **Partly:** some claims check out; at least one is false, stale or missing.
- **Not verified:** the main claims are false, or the code is missing.
- **Untestable:** the result depends on hardware or keys, and no checkable claim is false.

**Effect on quality** (deliberately light): Verified +0, Partly −5, Not verified −15, Untestable 0. Measured score, trust score, ranks and category ranks are then recomputed as in section 3.

Each app carries `claims[]`, `claims_verdict`, `claims_note` and `claims_evidence`, plus `claims_risky` where a false claim could hurt users. The hand-checked source is `scorer/claims.json`, which `score.mjs` reads on every run. A claims verdict never removes an item from rankings; only the safety scan does that.

## 4. The judging agent and its own inference
- The judge is its own devnet wallet (sr25519, SS58 prefix 42).
- It funds itself from the faucet and enrols a gateway key with a signed challenge (`/v1/enroll/wallet`).
- It buys inference through `api.flop.network/v1` (model `qwen/qwen2.5-0.5b-instruct`). Each request is escrowed and settled in an on-chain compute channel.
- `infer.mjs` records per call:
  - the idempotency key
  - time to first token and total time
  - the receipt (`x_flop_receipt.channelId`, `miner`)
  - the final state from `/v1/keys/me/receipts`
- Channels are opened by the gateway's agent account (`5GsXb3…F98S`), so settlement is proven per request through the gateway receipts and the channel id on the explorer.

## 5. Known limits (v1)
- **No third-party inference endpoint is public yet.** Every community app that buys FLOP inference (LUMI, Flopstar, agent-runner, flop-gateway) is self-hosted, so the test set can only be run against the official gateway. Hermes inherits the gateway's results.
- Usefulness, freshness and the safety scan are heuristics based on text. The claims check is a one-time manual pass (2026-11-10): it reads code statically and does not run it, so a claim that only shows up at runtime on a GPU or with keys stays "Untestable" or is judged from static evidence. A human should review the flagged items before publishing.
- Probes are a single snapshot. Uptime should be sampled over time (for example hourly) before the scores are relied on.
- GitHub search caps results and misses projects that aren't on GitHub (X-only apps, closed-source sites).
- Devnet only: settle rates reflect the current devnet worker bugs (flop-labs/network #151, #168), not app quality.
