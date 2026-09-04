// One-time seed: reads CAMERAS from cameras-data.js and writes migrations/seed.sql
// with INSERT statements for the D1 `cameras` table. Run once, then apply with:
//   npx wrangler d1 execute finestres-obertes-cameras --remote --file=migrations/seed.sql
//
// Kept in the repo (not deleted after use) as a reproducible path to rebuild the
// `cameras` table from cameras-data.js if the D1 database is ever recreated.
import { writeFileSync } from 'node:fs';
import { CAMERAS } from '../cameras-data.js';

function slugify(name){
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugFor(cam){
  const url = cam.img || cam.src;
  const m = url.match(/erdrag\.workers\.dev\/([^/?#]+?)(\.[a-z]+)?(\?.*)?$/i);
  if(m) return m[1].toLowerCase();
  return slugify(cam.n);
}

function esc(v){
  if(v === null || v === undefined) return 'NULL';
  if(typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

const seen = new Map();
const rows = CAMERAS.map(cam => {
  const publicUrl = cam.img || cam.src;
  let slug = slugFor(cam);
  // guarantee uniqueness — append a numeric suffix on collision
  if(seen.has(slug)){
    const n = seen.get(slug) + 1;
    seen.set(slug, n);
    slug = `${slug}-${n}`;
  } else {
    seen.set(slug, 1);
  }
  const isProxied = /erdrag\.workers\.dev/.test(publicUrl) ? 1 : 0;
  return {
    slug,
    name: cam.n,
    location: cam.loc,
    lat: cam.lat,
    lng: cam.lng,
    media_type: cam.media,
    public_url: publicUrl,
    is_proxied: isProxied
  };
});

const dupSlugs = rows.map(r => r.slug).filter((s, i, a) => a.indexOf(s) !== i);
if(dupSlugs.length){
  console.error('Duplicate slugs after dedupe (should not happen):', dupSlugs);
  process.exit(1);
}

const stmts = rows.map(r =>
  `INSERT INTO cameras (slug, name, location, lat, lng, media_type, public_url, is_proxied) VALUES (${esc(r.slug)}, ${esc(r.name)}, ${esc(r.location)}, ${esc(r.lat)}, ${esc(r.lng)}, ${esc(r.media_type)}, ${esc(r.public_url)}, ${esc(r.is_proxied)});`
);

writeFileSync(new URL('../migrations/seed.sql', import.meta.url), stmts.join('\n') + '\n');
console.log(`Wrote ${stmts.length} INSERT statements to migrations/seed.sql`);
console.log(`Proxied (erdrag) cameras: ${rows.filter(r => r.is_proxied).length}`);
