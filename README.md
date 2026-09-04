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
block, then apply the schema and seed it from `cameras-data.js`:

```sh
npx wrangler d1 migrations apply finestres-obertes-cameras --remote
node scripts/seed-d1.mjs
npx wrangler d1 execute finestres-obertes-cameras --remote --file=migrations/seed.sql
```

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

To have Cloudflare redeploy this Worker on every push, without any GitHub
Actions or API tokens: **Workers & Pages → finestres-obertes-cameras-service →
Settings → Builds → Connect**, then connect this repo. Leave **Root
directory** unset (this repo's root *is* the Worker), set **Git branch** to
whichever branch you want to treat as live (`main` is fine — this repo has no
separate release branch the way the site repo uses `prod`), and leave
**Deploy command** as its default, `npx wrangler deploy`. Your
`wrangler.toml` (D1 binding, Cron Trigger) and the `RUN_TOKEN` secret both
carry over automatically; secrets are stored separately from deploys and code
deploys don't touch them.

## Editing the camera list

The live camera list lives in D1, not in code — `cameras-data.js` is only the
one-time seed source `scripts/seed-d1.mjs` read from and is no longer imported
by `index.js`. Until an admin API exists (planned), edit a camera directly:

```sh
npx wrangler d1 execute finestres-obertes-cameras --remote --command \
  "UPDATE cameras SET public_url = 'https://example.com/new.jpg' WHERE slug = 'some-slug';"
```

No redeploy needed — `GET /` reads D1 live on every request.

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
