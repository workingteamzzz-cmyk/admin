# Canopus harness

End-to-end tests for `../canopus.html`. The harness serves the app on localhost, drives it in
headless Chromium like a real user (settings, typing, attachments, buttons), and writes a report
with one screenshot per scenario.

## Setup

```bash
cd harness
npm install
```

Playwright with Chromium must be available (`npx playwright install chromium` if it isn't).

## Run without an API key (simulated providers)

```bash
npm test
```

This runs every scenario twice: once against a simulated Claude API and once against a
simulated OpenAI-compatible API. Use this after any change to the app.

## Run against a real provider

Claude:

```bash
CANOPUS_PROVIDER=claude CANOPUS_API_KEY=sk-ant-... npm run live
```

Any OpenAI-compatible provider (OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, …):

```bash
CANOPUS_PROVIDER=compat CANOPUS_BASE_URL=https://api.openai.com/v1 CANOPUS_MODEL=<model-id> CANOPUS_API_KEY=<key> npm run live
```

Options: `--only=basic,canvas` runs a subset, `--timeout=300000` changes the per-reply timeout (ms).
A live run sends roughly 20 short requests, so it costs a few cents on most providers.

## What it checks

| Scenario | What passes |
|---|---|
| connect | The provider can be added through Settings and its models appear |
| basic | Follows an exact instruction |
| indonesian | Answers an Indonesian question in Indonesian |
| memory | Remembers an earlier turn in the same chat |
| text-file / pdf / image | Reads an attached text file, PDF and image (image is a warning, not a failure, for text-only models) |
| canvas / canvas-version | Builds an HTML canvas, opens it in the side panel, saves it to Studio, and saves a revision as version 2 |
| space / skill | Space instructions and enabled skills change the reply |
| prompt | A prompt template's blanks are filled in and sent |
| stop | The stop button ends a long reply cleanly |
| web | Web search returns sources (Claude only) |
| bad-model | A wrong model ID shows a clear error instead of failing silently |
| tour | Screenshots of every page, settings and mobile for visual review |
| persist | Chats and canvases survive a reload |

Reports are written to `report/<timestamp>/report.md`; the latest is copied to `report/latest.md`.
