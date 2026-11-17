# Canopus — Server Edition

Canopus is an AI workspace for organizations, powered by Claude. One API key lives on the server; everyone signs in with their own account. Internal knowledge stays on the server, and only the relevant excerpts are sent to Claude.

## Architecture

```
Browser (login)  ──HTTPS──▶  Canopus server  ──only relevant excerpts, masked──▶  Claude API
                             │
                             ├─ SQLite: users, groups, sessions, chats, usage, audit log
                             ├─ Full-text index of internal knowledge (built locally, never sent out)
                             └─ Files: knowledge documents + user attachments (data/)
```

## Security features

| Area | What is done |
|---|---|
| API key | Stored only in the server's environment (`.env`), never sent to the browser. |
| Sign-in | Accounts are created by an administrator → one-time invitation link (72 hours). Passwords are hashed with scrypt. Sessions use a cookie that is `HttpOnly` + `SameSite=Strict` (+ `Secure` over HTTPS). 5 wrong attempts → locked for 15 minutes. |
| Knowledge | Documents are indexed **locally** (SQLite FTS5, no external embedding service). Claude only receives the few passages that match a question, through a `search_knowledge` tool. |
| Access rights | Each collection can be restricted to certain groups. Search, opening documents, and the collection list all follow the user's groups. |
| Classification | Only **Biasa** and **Terbatas** may be uploaded. **Rahasia** and **Sangat Rahasia** are rejected before the file is read; nothing is stored. |
| Data masking | NIK, NIP, NPWP, email, phone numbers and terms set by the admin (people's names, codenames) are replaced with placeholders such as `⟦NIK_1⟧` before being sent to Claude, and restored only on the user's screen. PDFs are converted to text so they can be masked. |
| Citations | Answers from internal knowledge carry clickable sources: the exact passage plus a link to the original document. |
| AI-generated canvases | Run in a separate sandbox page with no access to the app's data and no network access (`connect-src 'none'`). |
| Budget | A monthly budget per user (USD estimate). Once it runs out, chat is blocked automatically. |
| Audit log | Sign-ins, failed sign-ins, every knowledge search (masked query + documents returned), uploads, refused uploads, masking events, and admin changes. |
| HTTP protection | Strict CSP (no CDN scripts in the app), CSRF protection (custom header + origin check), `nosniff`, `no-referrer`, HSTS over HTTPS. |

> **Things to keep in mind**
> - The relevant excerpts (after masking) are still sent to the Claude API in the United States. Make sure your internal policy allows processing **Biasa/Terbatas** documents this way. Data sent through the API is not used to train models under Anthropic's commercial terms; *Zero Data Retention* can be requested from Anthropic for an organization account.
> - Masking uses patterns and a term list, so it is not perfect. Names that aren't on the term list are not masked automatically.
> - Images cannot be masked. Turn off "Allow image uploads" in Admin → Settings if screenshots may contain sensitive data.

## Installation

### Option A — Docker (recommended)

```bash
cd server
cp .env.example .env        # fill in ANTHROPIC_API_KEY, PUBLIC_URL, CANOPUS_ADMIN_EMAIL
# change the domain in the Caddyfile to your organization's domain
docker compose up -d --build
docker compose logs canopus  # copy the administrator's one-time link
```

Caddy issues the HTTPS certificate automatically. If your office already has its own reverse proxy, remove the `caddy` service and point the proxy at port 8080 (turn off response buffering so answers stream word by word).

### Option B — Directly with Node.js 22.13+

```bash
cd server
npm ci
cp .env.example .env        # fill it in
npm start
```

For another administrator, or to reset a password: `npm run create-admin -- email@kantor.go.id "Name"`.

## First-time use

1. Open the administrator link from the log → set a password.
2. **Admin → Groups**: create groups by working unit (e.g. per Deputy).
3. **Admin → Knowledge**: create collections, choose which groups may search each one, then upload documents (PDF with text, DOCX, TXT, MD, CSV, HTML) and pick a classification.
4. **Admin → Settings**: choose the active models, add terms to mask (names of officials, project codenames), and set the default budget.
5. **Admin → Users**: invite users, choose their groups, then send the invitation link through an internal channel.

## Backup

Everything is in the `data/` folder (database `canopus.db` + files). Back it up regularly, for example with a daily `sqlite3 data/canopus.db ".backup backup.db"` plus a copy of the `data/docs` and `data/blobs` folders.

## Testing

The end-to-end test suite is in `../harness`:

```bash
cd ../harness && npm install
node server-run.mjs           # with a simulated Claude API (free)
ANTHROPIC_API_KEY=... node server-run.mjs --live   # with the real Claude API
```

The tests check, among other things, that sensitive values **never** leave the server (every request to the AI is recorded and inspected), that users cannot reach documents outside their groups, that Rahasia documents are refused, and that budgets and the audit log work.
