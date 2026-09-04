// Cloudflare Worker: the canonical source of the camera list, and its live
// availability. Checks every camera on an hourly Cron Trigger, caches the full
// enriched list (each cam plus a `broken` flag) in Workers KV, and serves it to
// whatever consumes it — currently the finestres-obertes map site's cameras layer
// (js/layers/cameras/load.js in that separate repo), which fetches this Worker's
// cached result on every page load rather than holding any camera data itself.
//
// Runs server-side specifically because most of the photo-hosting third parties
// (3cat.cat, meteoalmoster.net, avametnuvol.es, oratge.es, vigilant.cat, ...) send no
// Access-Control-Allow-Origin header at all, so a browser fetch() to them is always
// CORS-blocked regardless of method — a Worker has no such restriction, and can also
// use a cheap HEAD request instead of downloading the full (often multi-megabyte)
// image the way the old client-side check had to.
//
// Deploy from this directory: `wrangler deploy`. See README.md for one-time setup
// (KV namespace, D1 database, RUN_TOKEN secret, wrangler.toml bindings) and how to
// trigger a check on demand.

const KV_KEY = 'status';
// Shorter than the hourly cron interval on purpose — see checkAllCams().
const PROXY_FRESHNESS_MS = 20 * 60 * 1000;

function extractYoutubeId(src){
  const m = src.match(/embed\/([a-zA-Z0-9_-]{6,})/);
  return (m && m[1] !== 'videoseries') ? m[1] : null;
}

// Reshapes a `cameras` row into the public JSON shape the site already consumes
// (unchanged field names: n/loc/media/lat/lng/img|src/broken).
function toPublicCam(row){
  return {
    n: row.name,
    loc: row.location,
    media: row.media_type,
    lat: row.lat,
    lng: row.lng,
    [row.media_type === 'photo' ? 'img' : 'src']: row.public_url,
    broken: !!row.is_broken
  };
}

// Returns true (fine), false (confirmed broken), or true-on-uncertainty — only mark
// broken on a definitive signal, never on our own network hiccup.
async function checkPhoto(cam){
  try{
    const url = cam.public_url + (cam.public_url.includes('?') ? '&' : '?') + 'chk=' + Date.now();
    const res = await fetch(url, {method:'HEAD'});
    return res.ok;
  }catch(e){ return true; }
}

async function checkVideo(cam){
  const ytId = extractYoutubeId(cam.public_url);
  if(ytId){
    try{
      const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + ytId) + '&format=json');
      return !(res.status === 404 || res.status === 401);
    }catch(e){ return true; }
  }
  try{
    const res = await fetch(cam.public_url);
    if(!res.ok) return false;
    const text = await res.text();
    return /<iframe[\s>]|<img[\s>]|<video[\s>]/i.test(text);
  }catch(e){ return true; }
}

// Checks every active camera from D1, skipping cameras a media proxy already
// observed recently (real click traffic doubling as a liveness signal — see the
// cameras platform architecture plan), and persists is_broken/last_checked_at/
// checked_by plus a camera_checks history row for every camera actively probed
// this cycle. Returns the rows with fresh in-memory state for the KV write.
async function checkAllCams(env){
  const { results: cams } = await env.DB.prepare(
    'SELECT * FROM cameras WHERE is_active = 1'
  ).all();

  const { results: recent } = await env.DB.prepare(
    `SELECT camera_id, is_broken FROM camera_checks
     WHERE source = 'proxy' AND checked_at > ?
     ORDER BY checked_at DESC`
  ).bind(Date.now() - PROXY_FRESHNESS_MS).all();
  const recentByCam = new Map(); // first (=latest) row wins per camera
  for(const r of recent){
    if(!recentByCam.has(r.camera_id)) recentByCam.set(r.camera_id, r);
  }

  const now = Date.now();
  const stmts = [];
  for(const cam of cams){
    const proxyHit = recentByCam.get(cam.id);
    let isBroken, source;
    if(proxyHit){
      isBroken = !!proxyHit.is_broken;
      source = 'proxy';
    }else{
      const ok = cam.media_type === 'photo' ? await checkPhoto(cam) : await checkVideo(cam);
      isBroken = !ok;
      source = 'cron';
      stmts.push(env.DB.prepare(
        'INSERT INTO camera_checks (camera_id, checked_at, is_broken, source) VALUES (?, ?, ?, ?)'
      ).bind(cam.id, now, isBroken ? 1 : 0, 'cron'));
    }
    cam.is_broken = isBroken ? 1 : 0;
    cam.last_checked_at = now;
    cam.checked_by = source;
    stmts.push(env.DB.prepare(
      'UPDATE cameras SET is_broken = ?, last_checked_at = ?, checked_by = ? WHERE id = ?'
    ).bind(cam.is_broken, now, source, cam.id));
  }
  if(stmts.length) await env.DB.batch(stmts);
  return cams;
}

async function runCheck(env){
  const cams = await checkAllCams(env);
  await env.CAMERA_STATUS.put(KV_KEY, JSON.stringify({
    cams: cams.map(toPublicCam),
    checkedAt: Date.now()
  }));
}

export default {
  async scheduled(event, env, ctx){
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request, env, ctx){
    const url = new URL(request.url);
    // Manual trigger, for testing and for forcing a fresh check on demand — Cloudflare's
    // usual `/__scheduled` testing endpoint turned out not to reach this worker's
    // scheduled() handler on this deployment, so this is the reliable equivalent.
    // Requires RUN_TOKEN (set via `wrangler secret put RUN_TOKEN`) so it can't be spammed
    // by anyone who finds the URL.
    if(url.pathname === '/run'){
      if(!env.RUN_TOKEN || url.searchParams.get('token') !== env.RUN_TOKEN){
        return new Response('Forbidden', {status: 403});
      }
      await runCheck(env);
      return new Response('OK — check ran, see / for the result', {status: 200});
    }

    const stored = await env.CAMERA_STATUS.get(KV_KEY);
    // Before the first scheduled run ever completes, fall back to D1's raw list with
    // every cam marked fine, rather than an empty list — the site should show all the
    // cams from the moment it's deployed, not wait an hour for live broken-detection
    // to kick in.
    let body = stored;
    if(!body){
      const { results } = await env.DB.prepare('SELECT * FROM cameras WHERE is_active = 1').all();
      body = JSON.stringify({
        cams: results.map(row => ({...toPublicCam(row), broken: false})),
        checkedAt: null
      });
    }
    return new Response(body, {
      headers: {
        'content-type': 'application/json',
        // The site itself never needs to be same-origin with the worker (it's fetched
        // by JS, not embedded), so this stays permissive rather than hardcoding the
        // site's domain here.
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=300',
      }
    });
  }
};
