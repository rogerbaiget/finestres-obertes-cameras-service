# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker (`index.js`) that is the *canonical, only* source
of the camera list used by the [finestres-obertes](https://github.com/rogerbaiget/finestres-obertes)
map site (`src/js/layers/cameras/load.js` in that repo — a separate
checkout, typically a sibling directory). All camera data lives in a D1
database (`finestres-obertes-cameras`) — there is no camera data file in this
repo to edit. The Worker checks every active camera's live availability once
an hour via a Cron Trigger, persists `is_broken`/`last_checked_at` directly on
each row, and serves the enriched list as JSON straight from D1 on every
request (no separate cache to keep in sync).

Deploying this repo is fully independent of the site repo — it doesn't touch
the site's branches or trigger a Pages redeploy.

## Architecture

- **`index.js`** — the entire Worker. Three things happen here:
  - `checkAllCams(env)` — reads all `is_active` cameras from D1, skips any a
    media proxy already observed recently within `PROXY_FRESHNESS_MS` (real
    proxy traffic doubles as a liveness signal), otherwise probes it directly
    (`checkPhoto` does a HEAD request; `checkVideo` handles YouTube oEmbed or
    generic iframe/img/video sniffing), then batch-writes `is_broken` /
    `last_checked_at` / `checked_by` back to `cameras` plus an append-only row
    to `camera_checks`.
  - `scheduled()` — the hourly Cron Trigger entry point, just calls
    `checkAllCams`.
  - `fetch()` — handles `GET /` (reads `cameras` fresh from D1, reshapes each
    row via `toPublicCam` into the site's existing JSON field names —
    `n`/`loc`/`media`/`img`|`src`/`broken` — intentionally unchanged so the
    site doesn't need to change), and `GET /run?token=<RUN_TOKEN>` (manual
    trigger for `checkAllCams`, used because Cloudflare's usual
    `/__scheduled` testing endpoint doesn't reach `scheduled()` on this
    deployment).
- **`migrations/`** — D1 schema, applied via `wrangler d1 migrations apply`.
  `cameras` holds one row per camera (`slug` is the stable id the site and
  the separate proxy Worker key off of; `is_proxied`/`proxy_type`/
  `upstream_url` describe cameras routed through the sibling
  `finestres-obertes-cameras-proxy` Worker rather than fetched directly).
  `camera_checks` is an append-only availability history table feeding
  uptime %/timelines, intentionally missing a `(source, checked_at)` index at
  current scale — see the comment in `0001_init.sql` before adding one.
- **No admin API yet** — editing the camera list means running SQL directly
  against D1 (see README's "Editing the camera list"). Don't build a
  workaround for this; an admin API is planned separately.
- Related but separate repos, usually checked out as sibling directories:
  `finestres-obertes` (the map site consuming this Worker's JSON) and
  `finestres-obertes-cameras-proxy` (fetches from upstream sources for
  cameras with `is_proxied = 1`, working around CORS/referer restrictions
  those third parties impose).

## Branching and deploy model

- `main` is pushed freely for day-to-day work.
- `prod` is the deliberate "go live" step — fast-forward/merge `main` into
  `prod` to actually deploy. **Always confirm with the user before pushing to
  `prod`** — pushing `main` alone never triggers a deploy, but pushing `prod`
  does.
- CI (`.github/workflows/deploy.yml`, triggered on push to `prod`) applies any
  pending D1 migration (`wrangler d1 migrations apply --remote`) and then
  `wrangler deploy`, in that order, so schema changes and the code depending
  on them land together.
- Cloudflare's own git-integration "Builds" feature must stay disconnected —
  it doesn't run the migrations step, so enabling it alongside this workflow
  causes double-deploys and schema drift.
- The Worker's name in `wrangler.toml` must stay in sync with this repo's
  name — it determines the deployed URL every consumer fetches. Renaming one
  without the other (or without updating consumers and deleting the old
  Worker) leaves an orphaned Worker silently serving stale data at the old
  URL — this has happened before.

## Commands

```sh
# Local dev — MUST use --remote or D1 falls back to an empty local replica
npx wrangler dev --remote

# Manually trigger a check (against local dev or production)
curl "http://localhost:8787/run?token=<RUN_TOKEN>"
curl "https://finestres-obertes-cameras-service.<subdomain>.workers.dev/run?token=<RUN_TOKEN>"

# Deploy manually (normally CI does this on push to prod)
npx wrangler d1 migrations apply finestres-obertes-cameras --remote
npx wrangler deploy

# Tail production logs
npx wrangler tail

# Edit the camera list directly (no file, no redeploy needed)
npx wrangler d1 execute finestres-obertes-cameras --remote --command "..."

# Backup / restore
npx wrangler d1 export finestres-obertes-cameras --remote --output backup.sql
```

`wrangler dev` doesn't read secrets set via `wrangler secret put` — mirror
`RUN_TOKEN` into `.dev.vars` (gitignored) for local testing.

There is no test suite, linter, or build step in this repo — it's a single
plain JS file deployed as-is.
