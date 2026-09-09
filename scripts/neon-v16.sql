-- FAZA 16 — READ-REPLICA DEDICATĂ + MULTI-REGION (EU/US/APAC) + AUDIT GESTIONARE
-- Registry de REGIUNI: fiecare regiune = un endpoint Neon (primar sau replică
-- de citire). Primarul = acest proiect (eu-central-1). Replicile devin ACTIVE
-- imediat ce DSN-ul lor e setat în env (NEON_REPLICA_URL / NEON_REPLICA_US_URL /
-- NEON_REPLICA_APAC_URL) — zero schimbări de cod la provisionare.
-- manage_log = audit pentru ștergerile bulk și dedup (cine, ce, câte).
-- Idempotent: SIGUR de re-rulat.

-- 1) Registry regiuni (sursa de adevăr în Neon — partajat cross-instance)
CREATE TABLE IF NOT EXISTS regions (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,                 -- ex: eu-central-1, us-east-1, ap-southeast-1
  name        TEXT NOT NULL,                        -- nume lizibil (ex: Europa — Frankfurt)
  region_group TEXT NOT NULL DEFAULT 'EU',          -- EU | US | APAC
  role        TEXT NOT NULL DEFAULT 'replica',      -- 'primary' | 'replica'
  env_var     TEXT,                                 -- variabila env care conține DSN-ul (NEON_REPLICA_URL etc.)
  state       TEXT NOT NULL DEFAULT 'planned',      -- 'active' | 'planned' | 'disabled'
  weight      INT  NOT NULL DEFAULT 1,
  -- health (actualizat de probe):
  last_ping_ms INT,
  last_ok_at  TIMESTAMPTZ,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Seed idempotent: primar + replici planificate (EU dedicată + US + APAC)
INSERT INTO regions (code, name, region_group, role, env_var, state) VALUES
  ('eu-central-1',        'Europa — Frankfurt (primar)',    'EU',   'primary', NULL,               'active'),
  ('eu-central-1-r',      'Europa — replică de citire dedicată', 'EU', 'replica', 'NEON_REPLICA_URL',     'planned'),
  ('us-east-1',           'America de Nord — Virginia',     'US',   'replica', 'NEON_REPLICA_US_URL',  'planned'),
  ('ap-southeast-1',      'Asia-Pacific — Singapore',       'APAC', 'replica', 'NEON_REPLICA_APAC_URL','planned')
ON CONFLICT (code) DO NOTHING;

-- 3) Audit operațiuni de gestionare (ștergeri bulk, dedup, operare conținut)
CREATE TABLE IF NOT EXISTS manage_log (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,            -- 'bulk_delete' | 'dedupe' | ...
  deleted    INT  NOT NULL DEFAULT 0,  -- câte rânduri au fost eliminate efectiv
  actor      TEXT,                     -- sesiune (email) sau 'token'
  detail     JSONB,                    -- IDs, grupuri, motive, shard-uri implicate
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manage_log_created ON manage_log (created_at DESC);

-- 4) Jurnal rezultate ingest la scară (Faza 16b — dovadă persistentă în Neon)
CREATE TABLE IF NOT EXISTS ingest_scale_log (
  id             BIGSERIAL PRIMARY KEY,
  total_rows     BIGINT NOT NULL,
  peak_live      BIGINT NOT NULL,
  waves          INT    NOT NULL DEFAULT 1,
  shards_used    INT    NOT NULL DEFAULT 1,
  throughput_rps NUMERIC(10,1),
  distribution   JSONB,
  search_p50_ms  INT,
  search_p95_ms  INT,
  duration_s     INT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
