-- Camera metadata — replaces the hardcoded CAMERAS array in cameras-data.js.
-- users/favorites/camera_submissions are deferred to the auth phase; not
-- created here.
CREATE TABLE cameras (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,     -- stable id for URLs/history/proxy routing, e.g. "falset-pano"
  name            TEXT NOT NULL,            -- was `n`
  location        TEXT NOT NULL,            -- was `loc`
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  media_type      TEXT NOT NULL CHECK (media_type IN ('photo','video')), -- was `media`
  public_url      TEXT NOT NULL,            -- the URL the frontend loads — was `img` or `src`
  is_proxied      INTEGER NOT NULL DEFAULT 0,  -- SQLite has no native boolean, use 0/1
  proxy_type      TEXT,                     -- 'image-passthrough' | 'hls-passthrough' | 'referer-bypass'; only set when is_proxied=1
  upstream_url    TEXT,                     -- the real source the proxy Worker fetches; only set when is_proxied=1
  is_active       INTEGER NOT NULL DEFAULT 1,  -- admin soft-delete
  is_broken       INTEGER NOT NULL DEFAULT 0,  -- denormalized current status
  last_checked_at INTEGER,                  -- unix ms — replaces the top-level `checkedAt` in the KV blob
  checked_by      TEXT CHECK (checked_by IN ('cron','proxy')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX idx_cameras_active ON cameras(is_active);

-- Availability history — append-only, feeds uptime %/timelines.
CREATE TABLE camera_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id   INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  checked_at  INTEGER NOT NULL,   -- unix ms, matches the Date.now() convention already used in index.js
  is_broken   INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('cron','proxy'))
);
-- Covers the uptime-history query (camera_id + checked_at range/order).
-- Does NOT cover the cron's "is there a fresh proxy observation" query
-- (filters by source first) — left unindexed on purpose: at this project's
-- scale (low hundreds of rows/day) a full scan filtered by source is cheap;
-- revisit with an idx_checks_source_time(source, checked_at DESC) if this
-- table ever grows large enough for it to matter.
CREATE INDEX idx_checks_camera_time ON camera_checks(camera_id, checked_at DESC);
