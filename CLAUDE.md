# CLAUDE.md — consolidated-inventory

This repo's agent guide lives in **[AGENTS.md](./AGENTS.md)** — read it first; it's the source of truth.
Top gotcha: there is **no database** — the Google Sheet (`GOOGLE_SHEET_ID`) is the only data store; entry point is `index.js`. ⚠ `config/service-account.json` (a Google key) is **committed to git** — move it out + rotate (tracked in IMPROVEMENTS).
