# finestres-obertes-cameras-service

A Cloudflare Worker that is the canonical source of the camera list used by
the [finestres-obertes](https://github.com/rogerbaiget/finestres-obertes) map
(`js/layers/cameras/load.js` in that repo). It holds every camera's info in a
D1 database, checks each one's live availability once an hour (Cron Trigger),
and serves the enriched list — each cam plus a `broken` flag — as one small
JSON response, read straight from D1 on every request.

This used to live inside the site's own repo (`worker/`), importing the
camera list from a file there. It moved here once the Worker became the
*only* place the list lives at all, rather than a copy kept in sync with the
site — see the site's `PERFORMANCE.md` for why the original client-side check
was replaced with this in the first place.

Deploying this repo doesn't touch the site's repo, its `main`/`prod`
branches, or trigger a Pages redeploy — they're fully independent.

## One-time setup

```sh
npx wrangler login          # if you haven't already
npx wrangler d1 create finestres-obertes-cameras
```

That prints a `database_id`. Paste it into `wrangler.toml`'s `[[d1_databases]]`
block, then apply the schema once, right away (CI applies it again on every
later push, but the table needs to exist before this Worker can do anything):

```sh
npx wrangler d1 migrations apply finestres-obertes-cameras --remote
```

A fresh database starts with zero cameras — add them as described in
[Editing the camera list](#editing-the-camera-list) below, or restore from a
backup (see the same section) if you're recovering an existing one.

Set a secret for the manual-trigger route (any random string — this just stops
a stranger who finds the Worker's URL from spamming checks; pick your own
value, it doesn't need to be memorable):

```sh
npx wrangler secret put RUN_TOKEN
```

Then deploy:

```sh
npx wrangler deploy
```

Wrangler prints the Worker's URL, something like
`https://finestres-obertes-cameras-service.<your-subdomain>.workers.dev` (the
Worker's name comes from `wrangler.toml`'s `name` field, which matches this
repo's name — renaming either one changes the URL every consumer fetches, so
keep them in sync). Put that URL into `CAMERA_STATUS_URL` in the site repo's
`js/layers/cameras/load.js`.

The Cron Trigger is defined in `wrangler.toml` and activates automatically on
deploy — nothing else to configure. To check it's running:

```sh
npx wrangler tail          # watch live logs
```

or check **Workers & Pages → finestres-obertes-cameras-service → Triggers** in
the Cloudflare dashboard for the last execution time.

**The first check doesn't happen until the Cron Trigger fires** (up to an hour,
plus up to ~15 minutes of propagation delay right after a fresh deploy) — until
then, `GET /` still returns every camera straight from D1 with `broken: false`
(the schema's default for a never-checked row), so the site shows all the cams
from the moment it's deployed. Use the manual-trigger route below to get live
broken-detection sooner.

## Automatic deploys

This repo deploys via the `Deploy Worker` GitHub Actions workflow
(`.github/workflows/deploy.yml`), which runs on every push to `main`. It
applies any pending D1 migration (`wrangler d1 migrations apply --remote`)
and then deploys the Worker (`wrangler deploy`), so a schema change and the
code that depends on it land in the same push.

It authenticates with two repo secrets:

- `CLOUDFLARE_ACCOUNT_ID` — not sensitive, this account's ID
- `CLOUDFLARE_API_TOKEN` — a custom token scoped to this account only, with
  **Workers Scripts: Edit**, **D1: Edit** (needed for the migrations step,
  not just deploy), and **Account Settings: Read**

Set both with `gh secret set <NAME>` (reads the value from stdin/a prompt,
never from a shell argument).

Cloudflare's own **Workers & Pages → Settings → Builds** git integration is
an alternative to this workflow, not a complement to it — it doesn't run the
migrations step, so if you connect it too, every push double-deploys and
schema changes stop landing automatically. Leave it disconnected while this
workflow is in place.

## Editing the camera list

The camera list lives entirely in D1 — there's no file in this repo to edit
or redeploy from. Until an admin API exists (planned), add and edit cameras
directly with SQL:

```sh
# Add a camera
npx wrangler d1 execute finestres-obertes-cameras --remote --command \
  "INSERT INTO cameras (slug, name, location, lat, lng, media_type, public_url) \
   VALUES ('some-slug', 'Some Place', 'Some Town', 41.123, 1.456, 'video', 'https://example.com/new.jpg');"

# Edit one
npx wrangler d1 execute finestres-obertes-cameras --remote --command \
  "UPDATE cameras SET public_url = 'https://example.com/new.jpg' WHERE slug = 'some-slug';"
```

`slug` must be unique — it's what the site and the proxy Worker key off of.
No redeploy needed either way — `GET /` reads D1 live on every request.

To back up the current list (or recover it if the database is ever lost or
needs recreating):

```sh
npx wrangler d1 export finestres-obertes-cameras --remote --output backup.sql
```

That's a live snapshot of whatever's actually in D1 at that moment, not a
static file that drifts out of date as cameras get added — restore it into a
fresh database with `wrangler d1 execute ... --file=backup.sql` after
applying the schema migration.

## Triggering a check on demand

Cloudflare documents a `/__scheduled` testing endpoint for invoking a
deployed Worker's `scheduled()` handler directly, without waiting for the
real cron — on this deployment that didn't reach `scheduled()` (it just fell
through to the normal `fetch()` handler instead, for reasons that weren't
worth chasing further given the alternative below works reliably). Use the
Worker's own `/run` route instead:

```sh
curl "https://finestres-obertes-cameras-service.<your-subdomain>.workers.dev/run?token=<your RUN_TOKEN>"
```

That runs the same check-and-store logic the cron uses, immediately. Then:

```sh
curl https://finestres-obertes-cameras-service.<your-subdomain>.workers.dev
```

`checkedAt` should now be a real timestamp, and `cams` the full list with
live `broken` flags.

## Testing locally before deploying

```sh
npx wrangler dev --remote
```

`--remote` matters here — without it, the D1 binding falls back to an empty
local SQLite replica instead of the real remote database, so `GET /` would
show zero cameras. Then, in another terminal:

```sh
curl "http://localhost:8787/run?token=<your RUN_TOKEN>"
curl http://localhost:8787/
```

`wrangler dev` doesn't read secrets set via `wrangler secret put` (those are
production-only) — for local testing, put the same value in a `.dev.vars`
file in this directory (already gitignored):

```
RUN_TOKEN=whatever-you-set-in-production
```
