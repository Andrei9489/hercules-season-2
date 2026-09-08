-- FAZA 15 — SHARDING MULTI-COMPUTE: registry shard-uri + hartă rutare lookup
-- Neon multi-compute = mai multe compute-uri (proiecte/branch-uri Neon), fiecare
-- deținând o felie din spațiul HASH al conținutului. Shard-ul 0 = primarul local
-- (tabelul `content` partiționat x64 din acest proiect). Shard-urile remote sunt
-- compute-uri Neon aditionale înregistrate cu DSN — rutarea, scatter-gather-ul
-- căutării și health-check-urile funcționează identic, FĂRĂ schimbări de cod.
-- Idempotent: SIGUR de re-rulat.

-- 1) Registry-ul de shard-uri (sursa de adevăr, în Neon — partajat cross-instance)
CREATE TABLE IF NOT EXISTS shards (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'remote',        -- 'local' (primarul acestui proiect) | 'remote' (compute Neon adițional)
  dsn         TEXT,                                   -- null pentru local, connection string pentru remote
  region      TEXT NOT NULL DEFAULT 'eu-central-1',
  weight      INT  NOT NULL DEFAULT 1,               -- pondere rutare insert (capacitate relativă)
  state       TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'disabled' | 'draining'
  max_rows    BIGINT NOT NULL DEFAULT 400000000,     -- plafon de design per compute (6,25M/partiție × 64)
  -- health (actualizat de probe):
  last_ping_ms INT,
  last_ok_at  TIMESTAMPTZ,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Shard-ul LOCAL (primarul) — seed idempotent, DSN-ul rămâne null (folosește pg.ts)
INSERT INTO shards (name, kind, dsn, region, weight, state)
VALUES ('primary-eu-central-1', 'local', NULL, 'eu-central-1', 1, 'active')
ON CONFLICT (name) DO NOTHING;

-- 3) Hartă de rutare pentru lookup-uri cross-shard: external_id → shard
-- (scrisă la INSERT-urile rute pe shard-uri remote; citită la GET by external_id
-- când rândul nu e găsit local — permite ID-lookup real pe N compute-uri)
CREATE TABLE IF NOT EXISTS content_shard_map (
  external_id TEXT PRIMARY KEY,
  shard_id    INT  NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
  remote_id   BIGINT,                                  -- id-ul numeric al rândului pe shard-ul remote (rezolvare GET by id cross-compute)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- migrare idempotentă pentru instanțe create înainte de coloana remote_id
ALTER TABLE content_shard_map ADD COLUMN IF NOT EXISTS remote_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_shard_map_shard ON content_shard_map (shard_id);
CREATE INDEX IF NOT EXISTS idx_shard_map_remote ON content_shard_map (remote_id);

-- 4) Jurnal de health-check-uri (ultimele probe per shard, pentru diagnoză)
CREATE TABLE IF NOT EXISTS shard_health_log (
  id         BIGSERIAL PRIMARY KEY,
  shard_id   INT  NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
  ok         BOOLEAN NOT NULL,
  ping_ms    INT,
  error      TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shard_health_shard ON shard_health_log (shard_id, checked_at DESC);
