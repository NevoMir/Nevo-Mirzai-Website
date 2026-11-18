-- The client-outreach database (binding OUTREACH_DB, database "llo-outreach"). Apply with:
--   npx wrangler d1 migrations apply llo-outreach --remote
-- The research itself is uploaded by scripts/outreach/upload-data.mjs; nothing here is in git but the shape.

-- One row per person in the research. `mail` is the compact projection the API composes emails from (a few KB of JSON instead
-- of the full record), `data` the full research record. law_level and has_address are filled at upload so the pickers can
-- filter in SQL. erased_at: the founder erased this person (the row keeps only the id so a re-upload cannot bring them back).
CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    rank INTEGER NOT NULL DEFAULT 0,
    batch INTEGER NOT NULL DEFAULT 0,
    company_id TEXT NOT NULL,
    country TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    has_address INTEGER NOT NULL DEFAULT 0,
    law_level TEXT NOT NULL DEFAULT 'ok',
    mail TEXT NOT NULL,
    data TEXT NOT NULL,
    data_version TEXT NOT NULL,
    erased_at TEXT
);
CREATE INDEX contacts_company ON contacts (company_id);
CREATE INDEX contacts_pick ON contacts (law_level, has_address, is_primary, batch, rank);

-- One outreach record per person (status, dates, notes, replies...), the same JSON document the claude.ai page kept.
-- rev is the global revision of the last write, so the page can fetch only what changed.
CREATE TABLE status (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);
CREATE INDEX status_rev ON status (rev);

-- One global counter (name 'rev'), bumped by every write batch.
CREATE TABLE counter (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
INSERT INTO counter (name, value) VALUES ('rev', 1);

-- Small documents: settings (Your details, agent rules), sync (the reply check), research (law rules and email templates),
-- data (which upload is live), auth (the session epoch).
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- Every email recorded as sent: one row per person and email, so recording it twice changes nothing, and the daily limit
-- counts real sends. day is the founder's calendar day.
CREATE TABLE sends (
    contact_id TEXT NOT NULL,
    which TEXT NOT NULL,
    day TEXT NOT NULL,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    message_id TEXT,
    subject TEXT,
    body_sha256 TEXT,
    PRIMARY KEY (contact_id, which)
);
CREATE INDEX sends_day ON sends (day);

-- A person an agent has taken to write to. state: active (writing), drafted (a draft waits in the mailbox), done (sent),
-- released (given back). An active claim past its end is "stale": nobody else gets that person for a day, because the
-- email may have gone out before the agent stopped.
CREATE TABLE claims (
    contact_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    which TEXT NOT NULL,
    day TEXT NOT NULL,
    created_at TEXT NOT NULL,
    until TEXT NOT NULL,
    state TEXT NOT NULL
);
CREATE INDEX claims_company ON claims (company_id);
CREATE INDEX claims_day ON claims (day, state);

-- Keys the founder gives to agents. Only a SHA-256 hash of the secret part is kept.
-- role: agent or reply-check. can_send: the founder allowed this agent to send emails itself (else it prepares drafts).
-- full_read: it may download the whole list at once.
CREATE TABLE agent_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL,
    role TEXT NOT NULL,
    can_send INTEGER NOT NULL DEFAULT 0,
    full_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    inbox_checked_at TEXT
);

-- One-time links that open a browser session for an agent (so it never types a key into a page).
CREATE TABLE session_links (
    token_hash TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

-- Who did what. detail never holds an address or email text.
CREATE TABLE log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    contact_id TEXT,
    action TEXT NOT NULL,
    detail TEXT
);

-- Failed sign-ins per address, to slow down guessing.
CREATE TABLE auth_failures (
    ip TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    count INTEGER NOT NULL
);
