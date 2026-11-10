// Flop App Trust Score: scorer. Re-runnable; no secrets in code (gateway key is only read by infer.mjs).
// Usage: node score.mjs [--offline]   (--offline reuses cached GitHub/HTTP evidence where present)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const P = (p) => path.resolve(here, p);
const cfg = JSON.parse(fs.readFileSync(P('config.json'), 'utf8'));
const cands = JSON.parse(fs.readFileSync(P(cfg.paths.candidates), 'utf8')).items;
const imp = JSON.parse(fs.readFileSync(P(cfg.paths.impersonators), 'utf8'));
// Claims check (METHODOLOGY.md, 'Claims check'): hand-tested README/homepage claims per app; folds lightly into quality.
const claimsDb = fs.existsSync(P('claims.json')) ? JSON.parse(fs.readFileSync(P('claims.json'), 'utf8')) : { apps: {}, penalties: {} };
const EV = P(cfg.paths.evidence_dir);
const offline = process.argv.includes('--offline');
const NOW = new Date();
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const lin = (v, good, bad) => clamp(100 * (bad - v) / (bad - good)); // good -> 100, bad -> 0
const logScore = (v, good, bad) => clamp(100 * (Math.log10(bad) - Math.log10(Math.max(v, 1e-12))) / (Math.log10(bad) - Math.log10(good)));
const round = (x, d = 1) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
fs.mkdirSync(path.join(EV, 'gh', 'meta'), { recursive: true });

async function timedFetch(url, opts = {}, ms = 12000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); const t0 = performance.now();
  try { const r = await fetch(url, { ...opts, signal: ac.signal, redirect: 'follow' }); const body = await r.text();
    return { url, status: r.status, ms: Math.round(performance.now() - t0), body, finalUrl: r.url };
  } catch (e) { return { url, status: 0, ms: Math.round(performance.now() - t0), error: String(e.name || e).slice(0, 80), body: '' }; }
  finally { clearTimeout(t); }
}

// ---------- GitHub ----------
async function ghMeta(repo) {
  const f = path.join(EV, 'gh', 'meta', repo.replace('/', '_') + '.json');
  if (fs.existsSync(f)) { const age = (Date.now() - fs.statSync(f).mtimeMs) / 3.6e6; if (offline || age < cfg.github.cache_hours) return JSON.parse(fs.readFileSync(f, 'utf8')); }
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'flop-trust-score' };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await timedFetch(`https://api.github.com/repos/${repo}`, { headers: h });
  if (r.status !== 200) return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { error: r.status };
  const j = JSON.parse(r.body);
  const m = { full_name: j.full_name, description: j.description, homepage: j.homepage, stars: j.stargazers_count, forks: j.forks_count, open_issues: j.open_issues_count,
    pushed_at: j.pushed_at, created_at: j.created_at, archived: j.archived, fork: j.fork, license: j.license?.spdx_id || null, language: j.language, owner_type: j.owner?.type };
  fs.writeFileSync(f, JSON.stringify(m, null, 2)); return m;
}
async function readme(repo) {
  const f = path.join(EV, 'readme', repo.replace('/', '_') + '.md');
  if (fs.existsSync(f) && (offline || (Date.now() - fs.statSync(f).mtimeMs) / 3.6e6 < cfg.github.cache_hours)) return fs.readFileSync(f, 'utf8');
  for (const b of ['main', 'master']) { const r = await timedFetch(`https://raw.githubusercontent.com/${repo}/${b}/README.md`); if (r.status === 200) { fs.writeFileSync(f, r.body); return r.body; } }
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

// ---------- Safety scan ----------
const OFFICIAL_HOST = /(^|\.)flop\.(finance|network)$|^technocore\.chat$/i;
// True when the regex matches somewhere that is NOT inside a warning/negation sentence ("no presale", "beware of fake tokens").
function hitNotNegated(re, t) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); let m;
  while ((m = g.exec(t))) {
    const start = Math.max(t.lastIndexOf('.', m.index), t.lastIndexOf('\n', m.index), m.index - 200);
    const end = [t.indexOf('.', m.index + m[0].length), t.indexOf('\n', m.index + m[0].length)].filter((x) => x >= 0).reduce((a, b) => Math.min(a, b), m.index + 200);
    const sent = t.slice(start, end).toLowerCase();
    if (!/\b(no|not|never|scam|fake|beware|warning|avoid|isn'?t|doesn'?t|don'?t|there is no|impersonat|phishing|unofficial)\b/.test(sent)) return m[0];
  }
  return null;
}
function safetyScan(text, item) {
  const t = text || ''; const flags = []; let s = 100; const positives = [];
  const add = (sev, code, msg, pen) => { flags.push({ severity: sev, code, detail: msg }); s -= pen; };
  if (hitNotNegated(/\b(presale|pre-sale|token sale|buy \$?flop|\$flop (price|listing|chart)|pump\.fun|dexscreener\.com|raydium|contract address\s*[:=])/i, t)) add('high', 'token_sale', 'Mentions buying/trading a FLOP token or a token contract; FLOP has no token.', 45);
  const keyAsk = /(enter|paste|input|provide|submit|type|import)\s+(in\s+)?(your|the)\s+(wallet\s+)?(seed|mnemonic|private key|recovery phrase|secret phrase)/ig; let m;
  while ((m = keyAsk.exec(t))) { const pre = t.slice(Math.max(0, m.index - 40), m.index).toLowerCase(); if (!/never|don'?t|do not|not |no one/.test(pre)) { add('high', 'asks_for_secret', `Asks the user to ${m[0]}.`, 45); break; } }
  if (!item.official && /(official\s+(human verification|suite|airdrop claim|claim portal|verification|vault|ecosystem tool|onboarding suite)|badge\/[^)\s]*flop[^)\s]*official)/i.test(t)) add('high', 'impersonation', 'Third-party project presents itself as "Official".', 40);
  if (/humanoid emulation|stealth agent|avoid (being )?(detected|flagged)|evade (sybil|detection)|bypass (sybil|detection)|anti-?bot and humanoid/i.test(t) || /stealth agent/i.test(item.service_description || '')) add('high', 'sybil_evasion', 'Designed to evade Sybil/bot detection, against FLOP testnet rules (one participant, one score).', 45);
  if (hitNotNegated(/automat\w*\s+(the\s+)?\$?flop\s+airdrop|airdrop\s+(farm|automation)|otomasi airdrop/i, t)) add('medium', 'airdrop_farming', 'Automates airdrop tasks; risks Sybil classification.', 20);
  if (hitNotNegated(/connect (your )?wallet/i, t)) add('medium', 'wallet_connect', 'Asks to connect a wallet.', 10);
  // Domains: any host containing "flop" that is not official and not a generic host.
  const hosts = [...new Set([...t.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/ig)].map((x) => x[1].toLowerCase()))];
  const look = hosts.filter((h) => /flop/.test(h.split('.').slice(-2).join('.')) && !OFFICIAL_HOST.test(h));
  if (look.length) add('medium', 'lookalike_domain', `Links to non-official FLOP-named domains: ${look.join(', ')}`, 15);
  const officialLinks = hosts.filter((h) => OFFICIAL_HOST.test(h));
  if (officialLinks.length) positives.push('links official FLOP domains');
  if (/never (share|paste|send|give)[^.]{0,40}(seed|mnemonic|private key|secret)/i.test(t)) { positives.push('warns never to share keys'); s += 5; }
  if (/no (flop )?token|not (an )?official|unofficial|not affiliated/i.test(t)) { positives.push('states unofficial / no token'); s += 5; }
  // Data / wallet access summary (heuristic).
  const access = [];
  if (/read-?only/i.test(t)) access.push('read-only public data');
  if (/0600|mode 600|chmod 600/i.test(t)) access.push('creates local key file (0600)');
  if (/enroll|gateway key/i.test(t)) access.push('devnet gateway key');
  if (/faucet/i.test(t)) access.push('devnet faucet');
  if (/(private key|seed phrase|mnemonic)/i.test(t) && !access.includes('creates local key file (0600)')) access.push('handles a private key/seed (check where it is stored)');
  if (/connect (your )?wallet/i.test(t)) access.push('wallet connection');
  if (/docker|sudo|systemd|install\.sh|curl [^|\n]*\|\s*(sudo\s+)?(ba)?sh/i.test(t)) access.push('runs installers / root on host');
  if (/curl [^|\n]*\|\s*(sudo\s+)?(ba)?sh/i.test(t)) { flags.push({ severity: 'low', code: 'curl_pipe_sh', detail: 'Install via curl | sh: review the script before running.' }); s -= 5; }
  return { score: clamp(s), flags, positives, access: [...new Set(access)], links_official: officialLinks.length > 0 };
}

// ---------- On-chain ----------
async function onchainAgent(addr) {
  const out = { agent: addr, sampled: 0, total_indexed: null, funded: { settled: 0, timedout: 0, open: 0 }, probes_1wei: { settled: 0, timedout: 0, open: 0 }, model_hashes: {}, miner_paid_flop: 0, gn: 0, sample_channels: [] };
  for (let p = 0; p < cfg.onchain.pages; p++) {
    const r = await timedFetch(`${cfg.endpoints.explorer_api}/compute-channels?agent=${addr}&limit=${cfg.onchain.page_size}&offset=${p * cfg.onchain.page_size}`, {}, 20000);
    if (r.status !== 200) { out.error = `explorer ${r.status}`; break; }
    const j = JSON.parse(r.body); out.total_indexed = j.pagination?.total ?? null;
    for (const c of j.data) {
      out.sampled++; const bucket = c.escrow === '1' ? out.probes_1wei : out.funded;
      const st = c.status === 'settled' ? 'settled' : c.status === 'timedout' ? 'timedout' : 'open'; bucket[st]++;
      out.model_hashes[c.modelHash] = (out.model_hashes[c.modelHash] || 0) + 1;
      if (c.minerPaid) out.miner_paid_flop += Number(c.minerPaid) / 1e18; if (c.aggregateGn) out.gn += Number(c.aggregateGn);
      if (out.sample_channels.length < 3 && c.status === 'settled') out.sample_channels.push(`${cfg.endpoints.explorer_web}/channels/${c.channelId}`);
    }
    if (!j.pagination?.hasMore) break;
  }
  const done = out.funded.settled + out.funded.timedout;
  out.funded_settle_rate = done ? out.funded.settled / done : null;
  out.miner_paid_flop = round(out.miner_paid_flop, 4);
  return out;
}
async function modelNames() {
  const r = await timedFetch(`${cfg.endpoints.explorer_api}/models`); try { return Object.fromEntries((JSON.parse(r.body).models || []).map((m) => [m.modelHash, m.metadata?.name || m.name || m.modelHash])); } catch { return {}; }
}

// ---------- Inference runs ----------
function latestRun() {
  const d = P(cfg.paths.runs_dir); if (!fs.existsSync(d)) return null;
  const f = fs.readdirSync(d).filter((x) => x.startsWith('inference-')).sort().pop(); return f ? { file: path.join(d, f), ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) } : null;
}
function summariseRun(run) {
  if (!run) return null;
  const calls = run.calls || []; const ok = calls.filter((c) => c.status === 200 && c.text);
  const rec = Object.fromEntries((run.receipts || []).map((r) => [r.request_id, r]));
  const costOf = (id) => { const r = rec[id]; if (!r) return null; const v = r.settled_spend ?? r.spend ?? r.cost; if (v == null) return null; const n = Number(v); return n > 1e9 ? n / 1e18 : n; };
  const costs = ok.map((c) => costOf(c.request_id)).filter((x) => x != null);
  const judge = ok.map((c) => c.judge?.score).filter((x) => x != null);
  const states = (run.receipts || []).reduce((a, x) => { a[x.state] = (a[x.state] || 0) + 1; return a; }, {});
  return { run_file: path.relative(P('..'), run.file), started: run.started, calls: calls.length, ok: ok.length,
    accuracy: ok.length ? calls.reduce((a, c) => a + (c.grade || 0), 0) / calls.length : 0,
    judge_mean_0_10: judge.length ? judge.reduce((a, b) => a + b, 0) / judge.length : null,
    ttft_ms_median: median(ok.map((c) => c.ttft_ms)), total_ms_median: median(ok.map((c) => c.total_ms)),
    flop_per_answer_median: median(costs), receipts: states,
    channels: [...new Set(ok.map((c) => c.receipt?.channelId).filter(Boolean))].slice(0, 20), miners: [...new Set(ok.map((c) => c.receipt?.miner).filter(Boolean))] };
}

// ---------- Votes (design only; empty in prototype) ----------
function communityFor(id, votes) {
  const v = cfg.voting; const mine = votes.filter((x) => x.app_id === id);
  const cnt = { up: 0, down: 0, by_tier: { anonymous: { up: 0, down: 0 }, wallet_signed: { up: 0, down: 0 }, wallet_with_settled_sessions: { up: 0, down: 0 } } };
  let U = 0, D = 0;
  for (const x of mine) { const w = v.voter_weights[x.voter_tier] ?? 0; cnt[x.direction]++; cnt.by_tier[x.voter_tier][x.direction]++; if (x.direction === 'up') U += w; else D += w; }
  const n = U + D;
  const z = v.wilson_z; const ph = n ? U / n : 0;
  const wilson = n ? (ph + z * z / (2 * n) - z * Math.sqrt((ph * (1 - ph) + z * z / (4 * n)) / n)) / (1 + z * z / n) : 0;
  const bayes = (U + v.prior_mean * v.prior_strength) / (n + v.prior_strength);
  const weight = v.max_weight * Math.min(1, n / v.full_weight_at_effective_votes);
  return { votes: { up: cnt.up, down: cnt.down, by_tier: cnt.by_tier, effective_weighted_votes: round(n, 2) }, community_score: n ? round(100 * wilson, 1) : 0,
    community_bayes_score: n ? round(100 * bayes, 1) : 0, community_weight_applied: round(weight, 4) };
}

// ---------- Main ----------
const run = latestRun(); const runSum = summariseRun(run);
const names = await modelNames();
const votes = fs.existsSync(P(cfg.paths.votes_file)) ? JSON.parse(fs.readFileSync(P(cfg.paths.votes_file), 'utf8')).votes || [] : [];
const onchainCache = {};
const ourAgent = fs.existsSync(P(cfg.paths.agent_key_file)) ? JSON.parse(fs.readFileSync(P(cfg.paths.agent_key_file), 'utf8')).ss58Address : null; // public address only
const results = [];
for (const it of cands) {
  const ev = { links: [] }; const metrics = {}; const scores = {}; const basis = {};
  let text = '';
  if (it.repo) { ev.repo = `https://github.com/${it.repo}`; ev.links.push(ev.repo); ev.github = await ghMeta(it.repo); text += await readme(it.repo); }
  const urls = [...(it.urls || [])]; if (ev.github?.homepage && /^https?:/.test(ev.github.homepage) && !urls.includes(ev.github.homepage)) urls.push(ev.github.homepage);
  ev.http = [];
  for (const u of urls.slice(0, 3)) { const r = await timedFetch(u); ev.http.push({ url: u, status: r.status, ms: r.ms, error: r.error }); ev.links.push(u); if (r.status === 200 && /text\/html|<html/i.test(r.body.slice(0, 500))) text += '\n' + r.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').slice(0, 20000); }
  if (it.npm) { const r = await timedFetch(`https://registry.npmjs.org/${it.npm}/latest`); try { const j = JSON.parse(r.body); ev.npm = { version: j.version, description: j.description }; } catch {} }

  // Reliability
  const relParts = [];
  const up = ev.http.filter((h) => h.status >= 200 && h.status < 400).length;
  if (ev.http.length) { metrics.http_up = `${up}/${ev.http.length}`; relParts.push({ w: 0.4, v: 100 * up / ev.http.length }); }
  if (it.onchain_agent) {
    onchainCache[it.onchain_agent] ||= await onchainAgent(it.onchain_agent);
    const oc = onchainCache[it.onchain_agent];
    metrics.onchain = { agent: oc.agent, total_channels_indexed: oc.total_indexed, sampled_recent: oc.sampled, funded: oc.funded, probes_1wei: oc.probes_1wei,
      funded_settle_rate: round(oc.funded_settle_rate, 3), models: Object.fromEntries(Object.entries(oc.model_hashes).map(([h, n]) => [names[h] ? `${names[h]} (${h.slice(0, 10)}…)` : h, n])), miner_paid_flop_sampled: oc.miner_paid_flop };
    ev.links.push(`${cfg.endpoints.explorer_api}/compute-channels?agent=${oc.agent}`, ...oc.sample_channels);
    if (oc.funded_settle_rate != null) relParts.push({ w: 0.6, v: 100 * oc.funded_settle_rate });
    basis.reliability = 'explorer funded-channel settle rate + endpoint health';
  }
  if (it.repo && ev.github && !ev.github.error) {
    const days = (NOW - new Date(ev.github.pushed_at)) / 864e5; metrics.days_since_push = round(days, 1);
    const fresh = days <= 14 ? 100 : days <= 30 ? 75 : days <= 60 ? 50 : 25;
    const docFactor = Math.min(1, text.length / 1500); // an empty repo is not 'reliable' just because it is new
    relParts.push({ w: it.onchain_agent ? 0.1 : 0.6, v: ev.github.archived ? 0 : fresh * docFactor });
    basis.reliability ||= ev.http.length ? 'URL uptime probe + repo freshness' : 'repo freshness (no live URL)';
  }
  if (relParts.length) { const W = relParts.reduce((a, p) => a + p.w, 0); scores.reliability = relParts.reduce((a, p) => a + p.w * p.v, 0) / W; }
  basis.reliability ||= 'endpoint health';

  // Quality / usefulness
  if (it.inference && runSum && runSum.ok > 0) {
    const judgeN = runSum.judge_mean_0_10 != null ? runSum.judge_mean_0_10 * 10 : null;
    scores.quality = judgeN != null ? 0.75 * 100 * runSum.accuracy + 0.25 * judgeN : 100 * runSum.accuracy;
    metrics.test_set = { version: run.testset_version, accuracy: round(runSum.accuracy, 3), judge_mean_0_10: round(runSum.judge_mean_0_10, 2), calls: runSum.calls, ok: runSum.ok };
    basis.quality = 'fixed test set (regex-graded) + FLOP-hosted LLM judge';
    if (it.inference.via) basis.quality += ` (inherited: ${it.inference.via})`;
  } else {
    const L = text.length; const tl = text.toLowerCase(); let u = 0;
    u += Math.min(25, L / 400); // documentation depth
    if (/devnet|api\.flop\.network|explorer\.devnet|compute.channel|technocore/.test(tl)) u += 20; // network-specific
    if (/docs\.flop\.network|flop\.finance|flop\.network|github\.com\/flop-labs/.test(tl)) u += 10; // cites official sources
    if (/install|usage|quick ?start|getting started|kurulum|how to/.test(tl)) u += 15;
    if (ev.http.some((h) => h.status === 200)) u += 15; // live product
    if (ev.github?.license) u += 5;
    u += Math.min(10, (ev.github?.stars || 0) * 2);
    if (it.official) u = Math.max(u, 70);
    if (L < 200 && !ev.http.some((h) => h.status === 200)) u = Math.min(u, 10);
    scores.quality = clamp(u); basis.quality = 'usefulness heuristic (docs depth, network-specific, live product, license, stars); no inference endpoint to test';
  }

  // Speed
  if (it.inference && runSum && runSum.ttft_ms_median != null) {
    scores.speed = 0.5 * lin(runSum.ttft_ms_median, cfg.speed.ttft_good_ms, cfg.speed.ttft_bad_ms) + 0.5 * lin(runSum.total_ms_median, cfg.speed.total_good_ms, cfg.speed.total_bad_ms);
    metrics.ttft_ms_median = runSum.ttft_ms_median; metrics.total_ms_median = runSum.total_ms_median; basis.speed = 'streamed TTFT + full response, median over test set';
  } else {
    const okms = ev.http.filter((h) => h.status === 200).map((h) => h.ms);
    if (okms.length) { metrics.http_ms_median = median(okms); scores.speed = lin(median(okms), cfg.speed.http_good_ms, cfg.speed.http_bad_ms); basis.speed = 'HTTP response time of live URL (single probe from US-East sandbox)'; }
  }

  // Cost
  if (it.inference && runSum && runSum.flop_per_answer_median != null) {
    metrics.flop_per_answer = runSum.flop_per_answer_median; scores.cost = logScore(runSum.flop_per_answer_median, cfg.cost.good_flop_per_answer, cfg.cost.bad_flop_per_answer); basis.cost = 'settled receipt spend per answer (devnet FLOP)';
  }

  // Claims check penalty on quality (Verified 0, Partly -5, Not verified -15, Untestable 0)
  const cl = claimsDb.apps[it.id];
  const clPen = cl ? (claimsDb.penalties[cl.verdict] ?? 0) : 0;
  if (cl && scores.quality != null && clPen) { scores.quality = clamp(scores.quality + clPen); }
  if (cl) basis.claims = `claims check ${claimsDb.checked_at} (scorer/claims.json); quality ${clPen >= 0 ? '+' : ''}${clPen}`;

  // Safety
  const sf = safetyScan(text, it);
  if (it.official) { sf.score = Math.max(sf.score, 95); sf.positives.push('official FLOP Labs property'); }
  scores.safety = sf.score; metrics.safety_flags = sf.flags; metrics.safety_positives = sf.positives; metrics.data_access = sf.access;
  basis.safety = 'README/homepage scan: token-sale, secret requests, impersonation, Sybil-evasion, lookalike domains, wallet access';

  // Combine
  // Missing applicable metrics enter as a neutral 50 at half weight, so an item measured on more dimensions can out-rank
  // one that is merely unmeasured. Cost applies only to inference items (free tools have no per-answer cost).
  let W = 0, S = 0;
  for (const [k, w] of Object.entries(cfg.weights)) {
    if (k === 'cost' && !it.inference) continue;
    if (scores[k] != null) { W += w; S += w * scores[k]; } else { W += w / 2; S += (w / 2) * 50; }
  }
  let measured = W ? S / W : 0;
  const high = sf.flags.some((f) => f.severity === 'high');
  if (scores.safety < cfg.safety_gate.cap_below) measured = Math.min(measured, scores.safety);
  const com = communityFor(it.id, votes);
  const final = (1 - com.community_weight_applied) * measured + com.community_weight_applied * com.community_score;
  const coverage = Object.keys(cfg.weights).filter((k) => scores[k] != null);
  const applicable = Object.keys(cfg.weights).filter((k) => k !== 'cost' || it.inference);
  results.push({ id: it.id, name: it.name, category: it.category, service_description: it.service_description, kind: it.kind, official: !!it.official,
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, round(v)])), measured_score: round(measured), ...com, trust_score: round(final),
    confidence: coverage.length === applicable.length ? 'high' : coverage.length >= applicable.length - 1 ? 'medium' : 'low', metrics_covered: coverage, metrics_applicable: applicable,
    excluded_from_ranking: cfg.safety_gate.exclude_if_high_flag && high && !it.official, basis, metrics,
    claims: cl?.claims ?? [], claims_verdict: cl?.verdict ?? 'Not checked', claims_note: cl?.note ?? null, claims_evidence: cl?.evidence ?? [], claims_penalty: clPen, ...(cl?.risky ? { claims_risky: true } : {}),
    evidence: { links: [...new Set(ev.links)], github: ev.github && !ev.github.error ? { stars: ev.github.stars, pushed_at: ev.github.pushed_at, license: ev.github.license, archived: ev.github.archived } : null, http: ev.http, npm: ev.npm || null } });
  process.stderr.write(`${it.id}: ${round(final)}\n`);
}

// Rankings
// Guides/reference docs are ranked inside their category only; the overall board ranks apps, services, tools, dashboards, agents, SDKs and miner scripts.
const ranked = results.filter((r) => !r.excluded_from_ranking && r.kind !== 'guide').sort((a, b) => b.trust_score - a.trust_score);
ranked.forEach((r, i) => { r.rank = i + 1; });
const cats = {};
for (const r of results) { (cats[r.category] ||= []).push(r); }
const categories = Object.entries(cats).map(([c, list]) => {
  const rk = list.filter((r) => !r.excluded_from_ranking).sort((a, b) => b.trust_score - a.trust_score);
  rk.forEach((r, i) => { r.category_rank = i + 1; });
  return { category: c, count: list.length, ranked_count: rk.length, flagged_count: list.length - rk.length, top: rk[0] ? { id: rk[0].id, name: rk[0].name, trust_score: rk[0].trust_score } : null,
    ranking: rk.map((r) => ({ rank: r.category_rank, id: r.id, name: r.name, trust_score: r.trust_score, confidence: r.confidence })) };
}).sort((a, b) => b.count - a.count);

// Impersonator / scam token list (live refresh, DexScreener)
const warnings = { statement: imp.official_statement, tokens: [], flagged_projects: results.filter((r) => r.excluded_from_ranking).map((r) => ({ id: r.id, name: r.name, flags: r.metrics.safety_flags, link: r.evidence.links[0] })) };
const dx = await timedFetch(cfg.endpoints.dexscreener_search);
try {
  const seen = new Set();
  for (const p of JSON.parse(dx.body).pairs || []) {
    const b = p.baseToken; const nm = (b.name || '').toLowerCase();
    if (b.symbol?.toUpperCase() !== 'FLOP' && !imp.name_patterns.some((x) => nm.includes(x))) continue;
    if (seen.has(b.address)) continue; seen.add(b.address);
    const impersonates = imp.name_patterns.some((x) => nm.includes(x)) || (b.symbol?.toUpperCase() === 'FLOP' && new Date(p.pairCreatedAt) > new Date('2026-08-01'));
    warnings.tokens.push({ chain: p.chainId, dex: p.dexId, symbol: b.symbol, name: b.name, address: b.address, pair_created: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
      liquidity_usd: p.liquidity?.usd ?? null, fdv_usd: p.fdv ?? null, url: p.url, verdict: impersonates ? 'NOT OFFICIAL: uses the FLOP name or ticker; FLOP has no token' : 'unrelated name collision (pre-dates Flop Labs)' });
  }
  fs.writeFileSync(path.join(EV, 'dex_flop.json'), dx.body);
} catch { warnings.tokens_error = `dexscreener ${dx.status}`; }

// Our agent's own on-chain footprint
let ours = null;
if (ourAgent) {
  const oc = await onchainAgent(ourAgent); const acct = await timedFetch(`${cfg.endpoints.explorer_api}/accounts/${ourAgent}`);
  let bal = null; try { bal = Number(JSON.parse(acct.body).balance) / 1e18; } catch {}
  ours = { address: ourAgent, explorer: `${cfg.endpoints.explorer_web}/account/${ourAgent}`, balance_flop: bal, direct_channels: { funded: oc.funded, probes_1wei: oc.probes_1wei },
    note: 'Gateway-key inference settles in channels opened by the gateway agent account, not by our wallet; per-request settlement is tracked through /v1/keys/me/receipts.', last_inference_run: runSum };
}

const out = {
  schema_version: '1.0', name: 'Flop App Trust Score', network: cfg.network, generated_at: NOW.toISOString(), status: 'devnet prototype: devnet FLOP has no value; scores are indicative',
  weights: cfg.weights, voting: { enabled: false, design: 'VOTING.md', max_weight: cfg.voting.max_weight, voter_weights: cfg.voting.voter_weights },
  judge_agent: ours, summary: { items: results.length, ranked_overall: ranked.length, guides_ranked_in_category_only: results.filter((r) => r.kind === 'guide' && !r.excluded_from_ranking).length, flagged: results.filter((r) => r.excluded_from_ranking).length, categories: categories.length, inference_tested: !!(runSum && runSum.ok) },
  leaderboard: ranked.map((r) => ({ rank: r.rank, id: r.id, name: r.name, category: r.category, trust_score: r.trust_score, confidence: r.confidence })),
  categories, apps: results.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)), warnings,
  methodology: 'METHODOLOGY.md'
};
fs.mkdirSync(path.dirname(P(cfg.paths.output)), { recursive: true });
fs.writeFileSync(P(cfg.paths.output), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: true, output: P(cfg.paths.output), items: results.length, ranked: ranked.length, top: ranked.slice(0, 8).map((r) => `${r.rank}. ${r.name} ${r.trust_score}`) }, null, 1));
