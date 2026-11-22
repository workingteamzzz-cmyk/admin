# Canopus 3 — Server Edition

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

## What's new in version 2

- **Claude + GPT + an on-premise model** in one place, with **Auto** mode: a quick check picks the right model for each question (the rules are set by the admin), plus **automatic failover** if a provider is down.
- **Shared Projects** (like Claude Projects): instructions + knowledge + model, chosen by the admin, so you don't need everyone to have their own AI account. They can be copied from a Claude project.
- **Knowledge for spreadsheets** (XLSX/CSV): read row by row. Personal-data columns (Name, NIK, Medical record no. (No RM), Address, Phone, Date of birth, plus extra columns set by the admin such as Diagnosis) are **always masked** before reaching cloud AI.
- **Text mode**: canvases/dashboards are off by default (cheaper and more focused). Web search is available for public information.
- **Limits**: budgets per user and per group, models allowed per group, requests per minute/day, warnings at 80%/100%.
- **Integrations**: an API with scoped tokens (for n8n), and signed webhooks.

## Canopus as your strategic communications consultant

Canopus works like a senior communications consultant for the team: it leads with the answer, grounds it in data and internal documents, separates facts from interpretation, and ends with options, a recommendation, risks and next steps. Brainstorming goes wide first, then narrows to the best ideas. The "Communications analyst" skill is on by default (users can turn it off in Skills), and the home page and prompt library start with strategy work: communication strategy, issue analysis, campaign brainstorming, key messages, media Q&A preparation, crisis holding statements, stakeholder maps and executive briefing notes.

## Personas

- **Analyst persona** (one per person): role, expertise and focus, analysis style, tone, preferred formats, language. Each analyst edits their own in Settings; administrators can set or adjust it in Admin → Users. It shapes every chat and report that person makes (curation plans, Claude's analysis and GPT's finalization).
- **Client persona** (one per client): voice and character, audiences, key messages, terms to use, terms to avoid, sensitive issues, plus other guidelines. Applied to every deck for that client and to chats where Knowledge is aimed at that client's space.
- Both apply together: the client persona decides what may be said and in whose voice; the analyst persona decides how the analysis is done and presented.

## Smart report assistant: one analyst's flow, generalized

Canopus supports a full weekly-report flow — Excel first, then the deck — while every client can work differently:
- **Upload**: one or more spreadsheets (e.g. ONLINE + PRINTED exports, merged with a MEDIA TYPE column), screenshots (dashboard word clouds, maps, cover photos), client documents, several client logos, and templates.
- **Excel**: layered duplicate check with a cleaning log, AI noise filter, client-POV sentiment, sectors, an issue taxonomy kept consistent with the client's reference list, program detection, entity clean-up, summaries with COUNTIFS formulas. "Weekly media massa/sosial" are presets, not rules.
- **Deck**: the client's report structure (persona → Report structure, with an optional slide limit), executive-summary synthesis slides, news samples with links taken from the data, screenshot slides with analysis (the AI reads screenshots when Admin → Settings allows images), chart annotations, platform filters, logo and footer on every slide, spelling rules applied, file properties cleaned, and quality checks before download.
- **Style**: pick a style per client or per deck — presets (Editorial data, Government classic, Modern bold, Minimal monochrome, Warm professional) or a palette recommended from the client's logo colours; applied to any template's theme colours and fonts. With several logos, the darkest goes on light slides and the brightest on dark covers.
- **House style**: the team's default writing rules live in Admin → Settings and can be changed; the client's persona and structure always win.

## Report types

Ad-hoc, Daily, Weekly, Bi-weekly, Monthly, Bi-monthly, Quarterly, Semesterly and Yearly. The type changes the content: the period, how trends are bucketed (hour/outlet → day → week → month → quarter), what is compared (yesterday, last week, last month…, only when the data covers it), the focus (early warning for daily; patterns and next-week actions for weekly; programs and strategy for monthly; KPIs and strategic issues for quarterly; milestones for semester; the year in review for yearly), and a default structure with a slide limit. Each client can set its own structure per type (client page → Report structures). Ad-hoc follows the request. The curation planner also uses the type to choose the trend summary.

## Channels and senior reference reports

- **Channel**: media massa, media sosial, or both. Social media switches the vocabulary and slides to platforms, accounts/KOL, engagement, viral content, hashtags, complaints and post samples (account, platform, date, link); "both" adds a news-versus-social comparison. Structures can differ per channel (client page → Report structures); curation plans know about PLATFORM columns and reposts.
- **Analyst work → editor → final**: in a presentation, an analyst clicks **Submit to editor** (the deck Canopus builds, or their own edited file). Every version is kept in Reports → *Analyst work* (`data/submissions`) — the analysts' own knowledge, separate from URS and from final reports. Editors (role **Editor**, also Ultimate and Admin; never on their own work) review it with the **URS knowledge** shown alongside, can ask Canopus to **check the work against a URS** (score, summary, slide-by-slide suggestions), then **return it** with a note (the analyst revises and submits a new version) or **approve it** — with the editor's edited file or the analyst's version as is — into Final reports. The next report learns what the editor changed from the analyst's version.
- **Final reports**: Reports → *Final reports* files the version the editor approved and sent, per client, then per channel (media massa / media sosial / both) and report type (ad-hoc, daily, weekly … yearly). Files and their text stay on this server (`data/finals`), are searchable here without AI, and are not part of chat answers. When someone drafts that client's next report of the same type and channel, Canopus learns from the latest finals: their slide structure (unless the client has written its own), titles, phrasing, the editor's note and — when the final was filed from a Canopus deck via *File the edited final* — what the editor changed. Only slide titles and short masked excerpts go into that request; a final marked **Server only** is never sent to any AI. Analysts can untick “Learn from … final reports” per deck.
- **Roles**: administrators create four kinds of accounts in Admin → Users. **Editor** reviews analysts' work and approves it into Final reports. **Analyst** (default) makes chats and reports, adds files to their own knowledge space and to client spaces. **Ultimate** (senior) can also add to the shared Team knowledge and organization collections, and owns a URS. **Administrator** manages everything (users, models, budgets, settings) and can add knowledge anywhere. A URS can only be linked to an Ultimate or Administrator account.
- **Senior reference reports**: seniors upload their best reports (PPTX or PDF) to their own knowledge space. In Reports → New presentation, an analyst can “Follow a senior's report”: Canopus follows its slide structure, depth, tone and writing style (never its numbers), and for a PPTX can also use its design (masters, colours, fonts). PowerPoint files are indexed slide by slide, so they are searchable too.

## Knowledge spaces for many people

- **Team knowledge — for everyone:** one shared space; every user can add files and everyone can search and open them.
- **A space for each person:** each user has their own space (created automatically). Others can read it by default, so you can ask "from what Budi collected"; only the owner adds or removes files, and the owner can make it private (then nobody else, administrators included, sees or searches it in the app).
- **Client spaces** (from Reports) and **organization collections** (managed by administrators, access per group) as before.
- In the composer, the **Knowledge** button chooses what a chat searches: all knowledge, one space (team, a person, a client, a collection), or off. Direct search on the Knowledge page has the same choice.

## Large spreadsheets

Files with 50,000+ rows are supported (upload limit `MAX_UPLOAD_MB`, default 60). A file is parsed once and kept parsed; curation runs in the background with a progress bar, so you can leave the page. AI labelling sends each **unique** text once, in batches of 80, six batches at a time, retries on rate limits, and caches every label — so a rerun, or next month's file with the same headlines, costs nothing for texts already labelled. Before labelling more than 1,500 texts, Canopus shows the estimated cost and time and asks to confirm. Example: 50,000 rows with fully unique headlines ≈ $0.40 with Claude Haiku and roughly 10–15 minutes.

## What's new in version 3: Reports

A **Reports** page for communications work: media monitoring, issue analysis and communication strategy.

**1. Data curation (Excel/CSV).** Upload a monitoring spreadsheet, then describe what you need in plain language. The AI writes a *plan* of steps; you review, edit, reorder or add steps (or build a plan without AI), then run it. Steps: clean values (spaces, "-"/"N/A", dates, numbers, URL → website), standardize spellings (e.g. outlet names), remove duplicates, filter, fill, derived columns (month, week, weekday, website from a link, ranges), sort, **AI labels per row** (sentiment, issue/topic, tone — with fixed labels or categories the AI proposes), summary tables and pivot tables. The result downloads as an Excel file with the curated data, every summary and a "Catatan kurasi" sheet listing each step and its effect.

**2. Presentations on your template.** Choose curated data and write a brief. The AI drafts the slides (cover, key numbers, charts, tables, quotes, two-column comparisons, recommendations, closing), which you can edit, reorder and extend. Canopus builds the `.pptx` on your template: native PowerPoint charts (with their data embedded so they stay editable) and tables, filled from the real data. Sentiment colors (positive/neutral/negative) are applied automatically. Consultant-style slides are included: an executive summary up front, conclusion-style titles, **2×2 matrices** (SWOT, stakeholder map, risk map) and an **action plan table** (action, owner, timing, success indicator). Decks are made in two stages: an **analysis** model (default: a Claude model) chooses the charts and writes the insights and recommendations, then an optional **finalization** model (default: a GPT model, if one is configured) polishes titles, wording and consistency and checks numbers. The finalizer cannot change slide types or which data a chart or table shows. "Finalize again" re-runs that stage after you edit the slides.

**3. Templates.** Upload your official `.pptx`/`.potx` or an earlier report. Canopus uses its masters, layouts, colors and fonts; if the file has slides, their order and titles become the reference structure the AI follows for the next report. There is no built-in template: templates come from your clients. (`assets/default-template.pptx` is only a neutral fallback layout, "Plain layout", and a test fixture.)

**Clients.** Each client is a folder the whole team shares: its PowerPoint templates, saved **data recipes** (a curation plan that runs on next month's file without asking the AI again), **guidelines for the AI** (voice, key messages, terms to use or avoid, sensitive issues — applied to every deck for that client) and **client documents** (earlier reports, briefs; searchable and used for that client's decks). Any client's template can be used for another client. Datasets and presentations stay private to the person who made them.

**4. Questions and brainstorming.** "Ask in chat" attaches the curated data (summaries + rows, without personal-data columns) to a new chat. Ready-made prompts for issue analysis, key messages, media Q&A preparation, crisis holding statements, campaign brainstorming and communication strategy, plus a "Communications analyst" skill.

What the AI sees in Reports: for planning, only column names, types, counts and common values (never the rows); for labelling, only the text columns chosen in that step, in small batches; for slides, the summary tables and a sample of non-personal columns. Columns with ID numbers, phone numbers, e-mail addresses, home addresses or dates of birth are never sent; masking (terms, patterns) applies to everything. Files are built on the server and are visible only to their owner.

## Protecting patient data and hospital data

| Level | Where it applies | What reaches the AI |
|---|---|---|
| **1. On this server only** (local-only collection) | Patient records, medical records, highly sensitive data | **Nothing reaches cloud AI.** Can only be read by the on-premise model (`CANOPUS_LOCAL_BASE_URL`) or by **direct document search** (no AI, zero tokens). Conversations that have used the local model are locked and cannot move to cloud AI. |
| **2. Regular collection + masking** | Internal documents, statistics, regulations | Only the relevant passages; NIK/Medical record no./names/addresses/diagnoses (personal-data columns) are replaced with codes such as `⟦NAME_1⟧`. |
| **3. Refused** | Rahasia / Sangat Rahasia documents | Not stored at all. |

Also note:
- Data sent through the Claude/OpenAI APIs is not used for training under their commercial terms; *Zero Data Retention* can be requested for an organization account.
- Under UU 27/2022 (Personal Data Protection), health data is specific personal data. Consult the data protection officer or legal team before using patient data with **cloud** AI. The safest option for patient data is level 1.
- The test suite (`harness/server-run.mjs`) checks every request to Claude and GPT and **fails** if a patient name, medical record number, diagnosis, NIK or the contents of a local-only collection is found.

### Setting up an on-premise model (optional)

Example with [Ollama](https://ollama.com) on a server with a GPU:
```bash
ollama pull <model-name>          # choose an open model that fits your server's capacity
# in Canopus's .env:
CANOPUS_LOCAL_BASE_URL=http://<ollama-server-address>:11434/v1
```
Then in **Admin → Models → On-premise model**, add the model name exactly as `ollama list` shows it.

## Secure deployment (required for patient data)

**Hosting location**
- Use a **data center in Indonesia** (the Jakarta region of a large cloud provider, or a local cloud with ISO 27001 certification), or the hospital's own server room. Check with the legal/data protection team against UU 27/2022 (PDP), PP 71/2019 and the electronic medical records rules (Permenkes 24/2022).
- Remember: the hosting location only covers Canopus and its documents. Calls to Claude/GPT still go to the provider (US). That is why patient data should go in **On this server only** collections.

**Server**
1. A dedicated VM (not shared hosting), with disk encryption **on** and automatic security updates for the OS.
2. Firewall: open only port **443** (HTTPS). Close SSH to the internet: reach it through a VPN or bastion host.
3. Fill in `CANOPUS_ALLOWED_IPS` with the office network/VPN, or put Canopus behind a VPN / zero-trust gateway. Then Canopus can't be opened from outside at all.
4. HTTPS is required (`PUBLIC_URL=https://…`). Caddy in `docker-compose.yml` sets this up automatically.
5. **Encrypted** daily backups of the `data/` folder to separate storage, plus regular restore tests.
6. The cloud account itself: 2FA for every account, as few admins as possible, and alerts for suspicious logins.

**In the app (on by default)**
- Two-step verification (authenticator app) for every account, a 12-character minimum password, automatic sign-out after 30 minutes of inactivity, a lock after 5 failed sign-ins.
- Masking of personal data, refusal of Rahasia documents, web search and image uploads **off**, data in `data/` with 700 permissions.
- The **Admin → Security** page shows which items are already safe and which still need fixing.

**Before go-live**: run `node harness/server-run.mjs` (it must pass with 0 leaks), then do an independent penetration test if possible.

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
