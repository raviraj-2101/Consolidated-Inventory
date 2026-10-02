# AGENTS.md — consolidated-inventory

> **This file is the source of truth for this repo.** `CLAUDE.md` defers to it.
> Group: **Inventory** · Role: **Backend** · OWNER: `@nayan-acentecom`

## What this project is

A headless Node/Express backend (package name `consolidated-amazon-be`) that **consolidates Amazon FBA + Shopify sales/inventory data into a single Google Sheet** for the ops/inventory team. It pulls per-brand sales velocity and inventory (on-hand, reserved, unsellable, inbound) from the **Amazon Selling Partner API (SP-API)** and order velocity from the **Shopify Admin API**, writes everything back into named tabs of one Google Sheet via the **Google Sheets API**, and posts a daily **low-stock warning** to Slack. There is no UI and no human-facing API beyond a few manual-trigger endpoints — it runs almost entirely on **cron schedules**.

> **NOTE — no database.** There is **no MongoDB / no ORM** in this codebase. The only data store is the **Google Sheet** (`GOOGLE_SHEET_ID`). Treat the Sheet as the database. (The previously-declared-but-unused `mongoose` dependency was removed.)

See the central [Inventory group doc](https://github.com/Acentecom/Acentecom-Developments/blob/main/groups/inventory.md) for the org map.

## Tech stack

- **Runtime:** Node.js, **CommonJS** (`require`/`module.exports`, not ESM).
- **Web:** `express` ^5.2.1 (Express 5), `cors`.
- **Scheduling:** `node-cron` ^4.2.1 (all jobs hard-coded to `Europe/Brussels` timezone).
- **Google Sheets:** `googleapis` ^170 (Sheets v4) via a **service-account** key file.
- **HTTP client:** `axios` (Amazon SP-API, Shopify Admin API, Slack Web API).
- **Dates:** `moment` ^2.30.
- **Config:** `dotenv` ^17.
- **Dev:** `nodemon`.

## How to run it

| Command | What it does |
|---|---|
| `npm run dev` | `nodemon index.js` — auto-restart dev server. |
| `npm start` | `node index.js` — start the server. |
| `npm test` | placeholder — `exit 1` (no tests). |

**Required setup before running:**
1. `npm install`.
2. Place a Google service-account JSON at **`./config/service-account.json`** (referenced by `config/googleAuth.js`). The service account must have edit access to the target Sheet (scope `https://www.googleapis.com/auth/spreadsheets`).
3. Create a `.env` (see below). Server listens on `PORT` (`.env` ships `8089`; code defaults to `3000`).

**DB step:** none. No migrations, no DB. Data lives in the Google Sheet.

### Environment variables (names only — never commit values)

| Name | Purpose |
|---|---|
| `PORT` | Express listen port (`.env` sets `8089`; code falls back to `3000`). |
| `GOOGLE_SHEET_ID` | The single target Google Sheet ID (the de-facto datastore). |
| `SHEET_GET_AMAZON_ACCESS_TOKEN` | Tab name holding per-brand Amazon SP-API creds (Brand Name / Access Token / Refresh Token / clientId / clientSecret). |
| `SHEET_GET_SHOPIFY_ACCESS_TOKEN` | Tab name holding per-brand Shopify creds (Brand / Shop Name / Api Key). |
| `GOOGLE_TOKEN_SHEET_NAME` | Amazon token tab name (present in `.env`; same as the Amazon token tab). |
| `SALES_VELOCITY_SHEET` | Tab name for sales-velocity output (Amazon + Shopify velocity). |
| `INVENTORY_SHEET` | Tab name for inventory output (fulfillable/reserved/unsellable/inbound). |
| `SHOPIFY_SKU_SHEET` | Tab mapping Shopify SKU → Base SKU(s) (for velocity expansion). |
| `AUTH_LINK` | Amazon LWA token endpoint (`https://api.amazon.com/auth/o2/token`). |
| `ROOT_LINK_SELLER` | Amazon SP-API base URL (e.g. `https://sellingpartnerapi-na.amazon.com/`). |
| `MARKET_PLACE_ID` | Amazon marketplace ID (code defaults to `ATVPDKIKX0DER` = US if unset). |
| `SLACK_BOT_TOKEN` | Slack bot token for posting low-stock warnings. |
| `SLACK_CHANNEL_INVENTORY_WARNINGS` | Slack channel ID for the daily warning post. |

> **TODO:** there is **no `.env.example`** in this repo — create one with the names above (no values). `.env` is gitignored, but **`config/service-account.json` (a Google key) is committed** — see gotchas; remediation is tracked in the org [IMPROVEMENTS backlog](https://github.com/Acentecom/Acentecom-Developments/blob/main/IMPROVEMENTS.md).

## Code map (key entry points)

- **`index.js`** (repo root) — Express app, mounts routers under `/api/*`, starts the warnings cron, listens. **This is the real entry point.**
- **`config/googleAuth.js`** — builds the Sheets API auth from `./config/service-account.json`. (⚠ that key file is **committed to git** — flagged for removal; see gotchas.)
- **`helper.js`** — Sheets utilities: `colIndexToA1`, `ensureTimestampSheetExists`, `showAllRowsKeepFilter`, `getAllShopApiKeys` (reads Shopify creds tab).
- **`controller/amazon.controller.js`** — `fetchAndUpdateSalesVelocity`: pulls SP-API `sales/v1/orderMetrics` per brand+SKU over 1/2/7/14/30-day windows, writes velocity to the sheet, stamps the "Time Stamp" tab.
- **`controller/inventory.controller.js`** — `fetchAndUpdateInventory` (FBA `/fba/inventory/v1/summaries`), `fetchAndUpdateInboundShipment` + `fetchInboundQuantity` (inbound plans/shipments via `/inbound/fba/2024-03-20/...` and `/fba/inbound/v0/...`). Upserts inventory columns.
- **`controller/velocity.controller.js`** — `fetchShopifyVelocityData`: Shopify Admin orders → grouped per SKU/country/day velocity, expanded by Base-SKU map, written to the velocity sheet.
- **`controller/configAds.controller.js`** — Amazon LWA token refresh: `cronUpdateToken` (refreshes all brands' access tokens into the token sheet) + `getAccessToken` (returns `{ brand: accessToken }` map). Called at the start of every sync.
- **`controller/amazonWarnings.controller.js`** — `fetchAmazonWarningsAndNotify`: reads the `Amazon_Warnings` tab and posts a Slack Block-Kit low-stock message.
- **`jobs/amazonWarningsJob.js`** — cron wrapper for the warnings job (daily 09:30 CET).
- **`routes/*.routes.js`** — each route file mounts a `GET /` manual-trigger **and** registers its own `node-cron` schedule (see below).

## Task → where to look

- **Add/adjust an Amazon velocity calc** → `controller/amazon.controller.js` (`getDateRange`, `fetchSalesData`, column map in `getAmazonSheetStructure`).
- **Inventory / inbound shipment logic** → `controller/inventory.controller.js`.
- **Shopify velocity** → `controller/velocity.controller.js`.
- **Amazon token refresh / auth** → `controller/configAds.controller.js` (LWA refresh-token flow).
- **Change a cron time/timezone** → the schedule lives **in the route file** for that domain (`routes/*.routes.js`) plus `jobs/amazonWarningsJob.js` for warnings — NOT a central scheduler.
- **Slack low-stock message format** → `controller/amazonWarnings.controller.js` (Block Kit `rich_text`).
- **Sheet tab names / column headers** → driven by `.env` tab names + the `columnMap` builders in each controller (they look up columns **by header text**, e.g. `"Sku"`, `"SV Yesterday"`, `"Fulfillable"`).
- **Add an HTTP trigger** → add a router in `routes/` and mount it in `index.js`.

## Conventions & gotchas (don't do X)

- **NO database.** Don't assume a DB layer — the **Google Sheet is the store**. Don't add Mongo/an ORM without an explicit decision. (The unused `mongoose` dependency was removed.)
- **⚠ Secret committed.** `config/service-account.json` (a Google private key) is **tracked in git** (and in history); `.env` (gitignored) holds a `SLACK_BOT_TOKEN`. **Move the key out of git + rotate it** — remediation tracked in the org [IMPROVEMENTS backlog](https://github.com/Acentecom/Acentecom-Developments/blob/main/IMPROVEMENTS.md). Never commit secret values.
- **Crons run in TWO places.** `index.js` starts only the warnings job; the velocity/inventory/token crons are registered **as a side effect of `require`-ing each route file** in `index.js`. So merely importing a route schedules a cron. All schedules are pinned to **`Europe/Brussels`**:
  - Token refresh: `*/40 * * * *` (every 40 min) — `routes/configAds.routes.js`.
  - Amazon inventory: `30 7 * * *` (07:30) — `routes/inventory.routes.js`.
  - Amazon velocity: `15 1 * * *` (01:15) — `routes/amazon.routes.js`.
  - Shopify velocity: `30 1 * * *` (01:30) — `routes/velocity.routes.js`.
  - Low-stock Slack warning: `30 9 * * *` (09:30) — `jobs/amazonWarningsJob.js`.
- **`/api/createConfig` has no HTTP handler** — `routes/configAds.routes.js` only registers a cron; the mounted router exposes no `GET`/`POST`. Hitting it 404s (that's expected).
- **Sheet structure is positional + header-name driven.** Controllers assume **row 1 = group headers, row 2 = sub-headers, data starts row 3** (warnings tab: data starts row 5). Renaming a sheet header (e.g. `"SV Yesterday"`, `"Fulfillable"`) silently breaks the column map → columns get skipped, not errored.
- **Amazon SP-API is heavily rate-limited.** Code uses fixed delays (2s/0.5s), exponential backoff on 429/5xx, and refreshes tokens every 50 calls per brand. Don't remove the `delay()`/throttle calls — you'll get throttled/banned.
- **Triggers are fire-and-forget.** The `GET /api/*` endpoints respond `{status:"processing"}` immediately and keep working in the background; completion is tracked by writing to the **"Time Stamp"** tab, not by the HTTP response.
- **Express 5.** Routing/middleware semantics differ from Express 4 (e.g. stricter async error handling, no implicit `*` wildcards). Check Express 5 docs before adding routes.

## Ownership
OWNER: `@nayan-acentecom` — fill in the responsible person/team.
