# webcams-api

A Cloudflare Worker that is the canonical source of the webcam list used by
the [finestres-obertes](https://github.com/rogerbaiget/finestres-obertes) map
(`js/layers/webcams/load.js` in that repo). It holds every webcam's info
(`webcams-data.js`), checks each one's live availability once an hour (Cron
Trigger), and serves the enriched list — each cam plus a `broken` flag — as
one small JSON response.

This used to live inside the site's own repo (`worker/`), importing the
webcam list from a file there. It moved here once the Worker became the
*only* place the list lives at all, rather than a copy kept in sync with the
site — see the site's `PERFORMANCE.md` for why the original client-side check
was replaced with this in the first place.

Deploying this repo doesn't touch the site's repo, its `main`/`prod`
branches, or trigger a Pages redeploy — they're fully independent.

## One-time setup

```sh
npx wrangler login          # if you haven't already
npx wrangler kv namespace create WEBCAM_STATUS
```

That prints an `id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "WEBCAM_STATUS"
id = "<the id printed above>"
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
`https://webcam-status.<your-subdomain>.workers.dev` (the Worker itself is
still named `webcam-status`, from before this repo split — no need to rename
it, and renaming would change the URL every consumer fetches). Put that URL
into `WEBCAM_STATUS_URL` in the site repo's `js/layers/webcams/load.js`.

The Cron Trigger is defined in `wrangler.toml` and activates automatically on
deploy — nothing else to configure. To check it's running:

```sh
npx wrangler tail          # watch live logs
```

or check **Workers & Pages → webcam-status → Triggers** in the Cloudflare
dashboard for the last execution time.

**The first check doesn't happen until the Cron Trigger fires** (up to an hour,
plus up to ~15 minutes of propagation delay right after a fresh deploy) — until
then, `GET /` falls back to the raw list with every cam marked fine (not an
empty list), so the site still shows all the cams from the moment it's
deployed. Use the manual-trigger route below to get live broken-detection
sooner.

## Automatic deploys

To have Cloudflare redeploy this Worker on every push, without any GitHub
Actions or API tokens: **Workers & Pages → webcam-status → Settings → Builds →
Connect**, then connect this repo. Leave **Root directory** unset (this repo's
root *is* the Worker), set **Git branch** to whichever branch you want to
treat as live (`main` is fine — this repo has no separate release branch the
way the site repo uses `prod`), and leave **Deploy command** as its default,
`npx wrangler deploy`. Your `wrangler.toml` (KV binding, Cron Trigger) and the
`RUN_TOKEN` secret both carry over automatically; secrets are stored
separately from deploys and code deploys don't touch them.

## Editing the webcam list

Edit `webcams-data.js` directly, then redeploy (`npx wrangler deploy`, or
just push if Workers Builds is connected). There's only one copy of the list
anywhere — nothing else to keep in sync.

## Triggering a check on demand

Cloudflare documents a `/__scheduled` testing endpoint for invoking a
deployed Worker's `scheduled()` handler directly, without waiting for the
real cron — on this deployment that didn't reach `scheduled()` (it just fell
through to the normal `fetch()` handler instead, for reasons that weren't
worth chasing further given the alternative below works reliably). Use the
Worker's own `/run` route instead:

```sh
curl "https://webcam-status.<your-subdomain>.workers.dev/run?token=<your RUN_TOKEN>"
```

That runs the same check-and-store logic the cron uses, immediately. Then:

```sh
curl https://webcam-status.<your-subdomain>.workers.dev
```

`checkedAt` should now be a real timestamp, and `cams` the full list with
live `broken` flags.

## Testing locally before deploying

```sh
npx wrangler dev
```

Then, in another terminal:

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
