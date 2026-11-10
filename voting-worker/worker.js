// Flop App Trust Score: voting backend SKETCH for Cloudflare Workers + D1 + KV (free tier). NOT deployed.
// Bindings (wrangler.toml): DB (D1), RL (KV namespace for rate limits), SALT (secret), EXPLORER = https://explorer.devnet.flop.network/api
// Routes:
//   GET  /v1/votes/challenge?address=<ss58>&app_id=<id>&direction=up|down  -> {message, nonce, expires_at}
//   POST /v1/votes/signed   {address, app_id, direction, message, signature, voter_kind?}  (agents and wallet users)
//   POST /v1/votes/anon     {app_id, direction, browser_id, turnstile_token}              (humans, lowest weight)
//   GET  /v1/votes/summary  -> per-app counts by tier (feeds leaderboard.json via data/votes.json export)
import { signatureVerify, cryptoWaitReady, decodeAddress } from '@polkadot/util-crypto';

const APP_IDS_URL = 'https://<site>/data/leaderboard.json'; // the published leaderboard; votes only for listed ids
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ANON_PER_IP_PER_DAY = 20;     // across all apps
const SIGNED_PER_ADDR_PER_DAY = 50;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function rateLimit(env, key, limit) {
  const day = new Date().toISOString().slice(0, 10); const k = `rl:${day}:${key}`;
  const n = Number((await env.RL.get(k)) || 0); if (n >= limit) return false;
  await env.RL.put(k, String(n + 1), { expirationTtl: 90000 }); return true;
}
async function validApp(env, id) {
  let ids = await env.RL.get('app_ids', 'json');
  if (!ids) { const lb = await (await fetch(APP_IDS_URL)).json(); ids = lb.apps.map((a) => a.id); await env.RL.put('app_ids', JSON.stringify(ids), { expirationTtl: 3600 }); }
  return ids.includes(id);
}
// Tier for a signed voter: wallet_with_settled_sessions if the explorer shows >= 1 settled funded compute channel for the address.
async function tierFor(env, address) {
  const r = await fetch(`${env.EXPLORER}/compute-channels?agent=${address}&status=settled&limit=1`);
  const j = r.ok ? await r.json() : { pagination: { total: 0 } };
  const n = j.pagination?.total || 0;
  return { tier: n > 0 ? 'wallet_with_settled_sessions' : 'wallet_signed', settled: n };
}
async function upsert(env, v) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO votes (app_id,direction,voter_tier,voter_key,voter_kind,nonce,signature,settled_sessions,created_at,updated_at,browser_key)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)
    ON CONFLICT(app_id,voter_key) DO UPDATE SET direction=excluded.direction, voter_tier=excluded.voter_tier, settled_sessions=excluded.settled_sessions, updated_at=excluded.updated_at`)
    .bind(v.app_id, v.direction, v.tier, v.voter_key, v.kind || 'human', v.nonce || null, v.signature || null, v.settled || 0, now, v.browser_key || null).run();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/v1/votes/challenge') {
      const { address, app_id, direction } = Object.fromEntries(url.searchParams);
      try { decodeAddress(address); } catch { return json({ error: 'bad_address' }, 400); }
      if (!['up', 'down'].includes(direction) || !(await validApp(env, app_id))) return json({ error: 'bad_request' }, 400);
      const nonce = crypto.randomUUID(); const exp = Date.now() + CHALLENGE_TTL_MS;
      const message = `flop-trust-score/vote/v1\nApp: ${app_id}\nVote: ${direction}\nAddress: ${address}\nNonce: ${nonce}\nExpires: ${new Date(exp).toISOString()}`;
      await env.RL.put(`nonce:${nonce}`, message, { expirationTtl: 600 });
      return json({ message, nonce, expires_at: exp });
    }
    if (req.method === 'POST' && url.pathname === '/v1/votes/signed') {
      await cryptoWaitReady();
      const b = await req.json();
      const nonce = (b.message || '').match(/Nonce: (\S+)/)?.[1];
      const stored = nonce && (await env.RL.get(`nonce:${nonce}`));
      if (!stored || stored !== b.message) return json({ error: 'unknown_or_expired_challenge' }, 400);
      const exp = Date.parse(b.message.match(/Expires: (\S+)/)[1]); if (Date.now() > exp) return json({ error: 'expired' }, 400);
      const [, app_id] = b.message.match(/App: (\S+)/); const [, direction] = b.message.match(/Vote: (\S+)/); const [, addr] = b.message.match(/Address: (\S+)/);
      if (addr !== b.address) return json({ error: 'address_mismatch' }, 400);
      if (!signatureVerify(b.message, b.signature, b.address).isValid) return json({ error: 'bad_signature' }, 401);
      await env.RL.delete(`nonce:${nonce}`); // single use
      if (!(await rateLimit(env, `addr:${b.address}`, SIGNED_PER_ADDR_PER_DAY))) return json({ error: 'rate_limited' }, 429);
      const t = await tierFor(env, b.address);
      await upsert(env, { app_id, direction, tier: t.tier, settled: t.settled, voter_key: b.address, kind: b.voter_kind === 'agent' ? 'agent' : 'human', nonce, signature: b.signature });
      return json({ ok: true, tier: t.tier });
    }
    if (req.method === 'POST' && url.pathname === '/v1/votes/anon') {
      const b = await req.json(); const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0';
      if (!['up', 'down'].includes(b.direction) || !(await validApp(env, b.app_id))) return json({ error: 'bad_request' }, 400);
      // Optional: verify a Cloudflare Turnstile token here (free) before accepting.
      if (!(await rateLimit(env, `ip:${ip}`, ANON_PER_IP_PER_DAY))) return json({ error: 'rate_limited' }, 429);
      const ipKey = await sha256(`${env.SALT}|ip|${ip}`); const brKey = await sha256(`${env.SALT}|br|${b.browser_id || ''}`);
      // One anonymous vote per app per IP and per browser id (either match blocks a new vote; the same pair may change its vote).
      const seen = await env.DB.prepare('SELECT voter_key, browser_key FROM votes WHERE app_id=?1 AND (voter_key=?2 OR browser_key=?3)').bind(b.app_id, `ip:${ipKey}`, brKey).first();
      if (seen && !(seen.voter_key === `ip:${ipKey}` && seen.browser_key === brKey)) return json({ error: 'already_voted' }, 409);
      await upsert(env, { app_id: b.app_id, direction: b.direction, tier: 'anonymous', voter_key: `ip:${ipKey}`, browser_key: brKey });
      return json({ ok: true, tier: 'anonymous' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/votes/summary') {
      const { results } = await env.DB.prepare('SELECT app_id, voter_tier, direction, COUNT(*) n FROM votes GROUP BY 1,2,3').all();
      return json({ generated_at: new Date().toISOString(), rows: results });
    }
    return json({ error: 'not_found' }, 404);
  },
};
