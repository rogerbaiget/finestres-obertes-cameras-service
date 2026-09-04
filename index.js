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
// (KV namespace, RUN_TOKEN secret, wrangler.toml binding) and how to trigger a check
// on demand.
import { CAMERAS } from './cameras-data.js';

const KV_KEY = 'status';

function extractYoutubeId(src){
  const m = src.match(/embed\/([a-zA-Z0-9_-]{6,})/);
  return (m && m[1] !== 'videoseries') ? m[1] : null;
}

// Returns true (fine), false (confirmed broken), or true-on-uncertainty — only mark
// broken on a definitive signal, never on our own network hiccup.
async function checkPhoto(cam){
  try{
    const url = cam.img + (cam.img.includes('?') ? '&' : '?') + 'chk=' + Date.now();
    const res = await fetch(url, {method:'HEAD'});
    return res.ok;
  }catch(e){ return true; }
}

async function checkVideo(cam){
  const ytId = extractYoutubeId(cam.src);
  if(ytId){
    try{
      const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + ytId) + '&format=json');
      return !(res.status === 404 || res.status === 401);
    }catch(e){ return true; }
  }
  if(cam.playlist) return true;
  try{
    const res = await fetch(cam.src);
    if(!res.ok) return false;
    const text = await res.text();
    return /<iframe[\s>]|<img[\s>]|<video[\s>]/i.test(text);
  }catch(e){ return true; }
}

// Returns every cam from CAMERAS, each with a `broken` flag added — this is the full
// payload the client needs to draw markers, no separate "which cams exist" step.
async function checkAllCams(){
  return Promise.all(CAMERAS.map(async cam => {
    const ok = cam.media === 'photo' ? await checkPhoto(cam) : await checkVideo(cam);
    return {...cam, broken: !ok};
  }));
}

async function runCheck(env){
  const cams = await checkAllCams();
  await env.CAMERA_STATUS.put(KV_KEY, JSON.stringify({cams, checkedAt: Date.now()}));
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
    // Before the first scheduled run ever completes, fall back to the raw list with
    // every cam marked fine, rather than an empty list — the site should show all the
    // cams from the moment it's deployed, not wait an hour for live broken-detection
    // to kick in.
    const body = stored || JSON.stringify({
      cams: CAMERAS.map(cam => ({...cam, broken: false})),
      checkedAt: null
    });
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
