# Client outreach (`/client-outreach`)

The founder's private outreach page and the API AI agents use to work through it. The research holds personal data
(people's names, roles and work addresses), so it lives only in Cloudflare (D1 + KV) and in the founder's private research
folder: never in this public repo, never in `dist/`.

## What is where

| Path | Who | What |
| --- | --- | --- |
| `/client-outreach` | the founder, after signing in with the owner key | the full page: contacts, composer, message versions, playbook, Agents tab |
| `/client-outreach/agent` | an agent in a browser, after a one-time link | a console that does the whole job with buttons |
| `/client-outreach/agents` (`.md`) | anyone | the guide for agents: no data, only how to work |
| `/api/outreach/*` | an agent key (`Authorization: Bearer llo_...`) or a signed-in page | the JSON API, listed by `GET /api/outreach` |

Code: `worker/outreach/` (`index` routing, `pages` sign-in and pages, `api` endpoints, `auth` sessions and keys, `rules` who
may be written to, `store` D1, `admin` data upload, `guide`), `src/client-outreach/shared/core.ts` (the rules and the email
composer, shared by the page and the Worker, so an agent gets exactly the email the founder sees), `src/client-outreach/app.js`
with `client-outreach/index.html` (the founder's page), `agent.js` with `agent.html` (the console), `migrations_outreach/`.

Storage: D1 database `llo-outreach` (binding `OUTREACH_DB`: statuses, settings, sends, claims, agent keys, log, and one research
record per person) and KV namespace `OUTREACH_KV` (the three research files, `data/<version>/*.json`, streamed to the page).

## Who may do what

- **The founder** (owner key, Worker secret `OUTREACH_KEY`, at least 32 characters): everything. Signs in once per browser
  for 14 days. "Sign out every browser session" in the Agents tab ends all sessions.
- **An agent key** (created in the Agents tab; shown once; stored as a hash; 30 days by default; revocable): reads the people
  and the research, takes people (`/claim`), records drafts, sends, replies, stop requests and bounces, edits notes and the
  personal opening. It cannot change settings, keys or statuses directly. By default it prepares drafts and the founder
  sends them; "May send emails by itself" is a separate choice per key, with the legal note from the research.
- **A reply-check key**: reads every status (`GET /api/outreach/state`, which agent keys cannot), records replies and the
  "Email checked" line, nothing else. Make one only for the founder's own daily reply check
  (`research_notes/.../reply-check/api.py`), and keep it in a file only the founder's account can read.
- **Full read** (a checkbox per key): without it, a key sees only the people it holds and the people already written to
  (it needs those for the mailbox check), and cannot download the whole research file.
- **A browser agent** never types a key: the founder makes a one-time link (30 minutes, one use) that opens a 12-hour session.

The server enforces the founder's research on every agent: nobody in a country that needs consent; nobody who asked to stop,
said no, bounced or replied (the founder answers); one person per company and only the first one; follow-ups only when due;
a daily limit counting everyone's sends; working hours for keys that send; no email while Your details or the sending setup
are incomplete; and the mailbox must have been checked for replies in the last 12 hours before anyone is taken. A taken
person is reserved for 30 minutes; if an agent stops without saying what happened, the person stays reserved for a day so a
second agent cannot email them again, and the page shows "check if it went out".

## The founder's page

- Every card: **Copy address**, **Copy email** (To, subject and text of the next email) and **Copy all info**. Copying refuses
  anyone with a stop (asked to stop, said no, bounced, a country that needs consent).
- Tick **Select** on cards (or **Select all shown**): the bar at the bottom marks the first email as sent for all of them,
  marks their follow-up as sent, sets a status, or copies their addresses or emails. It only touches the ticked people the
  filters still show.
- **Agents** tab: whether agents can work now and what is missing, the sending setup and the daily limit, keys (create,
  one-time browser link, revoke), and the activity log.
- The page asks the server for changes every 20 seconds while it is open, so what agents do appears without a reload.

## First setup (once)

```sh
npx wrangler d1 create llo-outreach              # copy the database_id into wrangler.jsonc (OUTREACH_DB)
npx wrangler kv namespace create OUTREACH_KV     # copy the id into wrangler.jsonc (kv_namespaces)
npx wrangler d1 migrations apply llo-outreach --remote
npx wrangler secret put OUTREACH_KEY             # paste a long random key (32+ characters); keep it in a password manager
npm run build && npx wrangler deploy
OUTREACH_KEY=... node scripts/outreach/upload-data.mjs --data "<private research folder>/page/data"
```

Release order when a migration is added: apply it with `--remote` before deploying (the API answers 503 until then).

## Updating the research

Run `scripts/outreach/upload-data.mjs` again with the new files. Statuses, sends, claims and the log are not touched;
people no longer in the research leave the list but keep their status; people erased on the page are left out.

## Local development

```sh
echo 'OUTREACH_KEY="devtest-...a long random value..."' >> .dev.vars
npx wrangler d1 migrations apply llo-outreach --local
npx vite build && npx wrangler dev                 # http://127.0.0.1:8787/client-outreach
node scripts/outreach/upload-data.mjs --base http://127.0.0.1:8787 --key-file <file with the dev key> --data "<...>/page/data"
node scripts/outreach/test-api.mjs --key-file <file with the dev key>   # wipes the LOCAL statuses first; localhost only
```

## Deleting data

- One person, at their request: "Erase this person" on their card (or `POST /api/outreach/erase {id}`). They disappear from
  the page and the API at once and are never added back by an upload; run the upload again to drop them from the KV files.
- Everything: `npx wrangler d1 delete llo-outreach` and `npx wrangler kv namespace delete --binding OUTREACH_KV`, then remove
  the two bindings from `wrangler.jsonc`.

## Free-plan limits

- 10 ms CPU per request: the research file is streamed from KV without parsing; lists are SQL projections; `/next` and
  `/claim` look at no more than about 50 people; bulk writes are a fixed handful of statements (ids travel as one JSON value
  through `json_each`), so marking 500 people as sent costs the same queries as marking one.
- D1 reads (5 million a day): the page asks for changes every 20 seconds while it is visible and gets only the rows changed
  since its last revision.
