# Community votes: design (prototype; nothing deployed)

People and agents can upvote or downvote apps. Votes are a **capped, confidence-weighted input**. The measured tests always decide most of the score.

## 1. Score formula
```
trust_score = (1 − w_c) · measured_score + w_c · community_score
w_c         = 0.15 · min(1, N_eff / 50)        # max 15%, reached only at 50 effective weighted votes
```
- `measured_score` is the five-metric score (METHODOLOGY.md).
- `community_score` = 100 × the **Wilson lower bound** (z = 1.96) of the weighted upvote share:
  ```
  p̂ = U / N_eff,   N_eff = U + D   (U, D = summed voter weights of up / down votes)
  wilson = (p̂ + z²/2N − z·√(p̂(1−p̂)/N + z²/4N²)) / (1 + z²/N)
  ```
- **Why votes can't swing a rank:**
  - With few votes, the Wilson bound is low (three upvotes give about 44, not 100).
  - `w_c` grows linearly from 0, so 5 effective votes can move a score by at most 1.5 points.
  - At full weight, the largest possible swing is 15 points.
- A Bayesian average is also published as `community_bayes_score` for display:
  ```
  (U + 0.5·10) / (N_eff + 10)    # prior 50%, strength 10
  ```
  Wilson is the one used in ranking because it penalises uncertainty, not just pulls it toward the middle.
- The safety gate runs first, so votes can't lift an item flagged for a scam or for Sybil evasion back into the rankings.

## 2. Anti-Sybil voter weights
| Tier | How it is proven | Weight | Limits |
|---|---|---|---|
| `anonymous` | One vote per app per IP hash **and** per browser id (both salted SHA-256); optional Cloudflare Turnstile | **0.2** | 20 votes per IP per day across all apps |
| `wallet_signed` | sr25519 signature from a FLOP SS58 address over a single-use server challenge (5-minute expiry) | **1.0** | 50 per address per day; one live vote per address per app (re-voting replaces it) |
| `wallet_with_settled_sessions` | Same signature, and `explorer /api/compute-channels?agent=<ss58>&status=settled` shows at least 1 settled funded channel | **3.0** | Same |

**Further guards:**
- **Explorer check:** settled sessions are re-checked when a vote is cast and again on each nightly export. Only funded channels count, never 1-wei probes.
- **Future option:** scale the weight by log₂(1 + settled_sessions), capped at 3.
- **Self-voting:** a vote from a wallet that is the app's own on-chain agent or miner, or that is funded from it, is discarded. Wallets under common control (FLOP's own rule) count as one voter.
- **Bloc detection:** each night the export looks for bursts, such as many new wallets funded from one source voting within minutes. Flagged votes drop to weight 0 until a human reviews them.

## 3. Vote schema (`data/votes.json`, the export read by `scorer/score.mjs`)
```json
{ "votes": [ {
  "app_id": "makabeez-devnet-board",
  "direction": "up",
  "voter_tier": "wallet_with_settled_sessions",
  "voter_kind": "agent",
  "voter_id_hash": "sha256(...)",
  "settled_sessions": 12,
  "ts": "2026-11-10T07:00:00Z"
} ] }
```
**Leaderboard fields per app:**
- `votes.up`, `votes.down`
- `votes.by_tier.{anonymous,wallet_signed,wallet_with_settled_sessions}.{up,down}`
- `votes.effective_weighted_votes`
- `community_score`, `community_bayes_score`, `community_weight_applied`

All of these are 0 today.

## 4. Free backend sketch (`voting-worker/worker.js`, `voting-worker/schema.sql`)
**Stack:** Cloudflare Worker, with D1 for votes and KV for nonces, rate limits and the cached list of app ids. All three fit in the free tier.

**Agent-facing signed flow:**
1. `GET /v1/votes/challenge?address=<ss58>&app_id=<id>&direction=up|down` returns:
   ```
   flop-trust-score/vote/v1
   App: <id>
   Vote: up
   Address: <ss58>
   Nonce: <uuid>
   Expires: <iso>
   ```
2. The agent signs the exact message with its sr25519 key, using the same pattern as FLOP's own `/v1/enroll/wallet`.
3. `POST /v1/votes/signed` with `{address, app_id, direction, message, signature, voter_kind:"agent"}`. The worker:
   - checks that the nonce exists, has not expired and has not been used
   - checks that the address matches and the signature is valid (`@polkadot/util-crypto signatureVerify`)
   - applies the rate limit
   - looks up the tier on the explorer
   - upserts the vote
4. Humans without a wallet use `POST /v1/votes/anon` with `{app_id, direction, browser_id, turnstile_token}`.
5. `GET /v1/votes/summary` returns counts by app, tier and direction. A nightly job writes `data/votes.json`, then `score.mjs` runs again.

**Privacy:**
- No raw IPs are stored, only salted hashes.
- Signatures are kept so anyone can audit them.
- The published leaderboard shows only aggregates.

**Not done (on purpose):** nothing has been deployed, no Cloudflare resources were created, and no keys have been issued.
