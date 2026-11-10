-- Cloudflare D1 schema for Flop App Trust Score votes (design only; NOT deployed).
CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT    NOT NULL,              -- leaderboard.json apps[].id
  direction     TEXT    NOT NULL CHECK (direction IN ('up','down')),
  voter_tier    TEXT    NOT NULL CHECK (voter_tier IN ('anonymous','wallet_signed','wallet_with_settled_sessions')),
  voter_key     TEXT    NOT NULL,              -- ss58 address for signed votes; sha256(salt|ip|browser-id) for anonymous
  voter_kind    TEXT    NOT NULL DEFAULT 'human' CHECK (voter_kind IN ('human','agent')),
  browser_key   TEXT,                          -- anonymous only: sha256(salt|browser-id)
  nonce         TEXT,                          -- signed votes only; single use
  signature     TEXT,                          -- sr25519 hex, signed votes only
  settled_sessions INTEGER DEFAULT 0,          -- count seen on the explorer when the vote was cast
  created_at    INTEGER NOT NULL,              -- unix ms
  updated_at    INTEGER NOT NULL,
  UNIQUE (app_id, voter_key)                   -- one live vote per voter per app; re-voting replaces it
);
CREATE INDEX IF NOT EXISTS votes_app ON votes(app_id);
CREATE UNIQUE INDEX IF NOT EXISTS votes_anon_browser ON votes(app_id, browser_key) WHERE browser_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS used_nonces (nonce TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
