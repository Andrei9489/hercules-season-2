-- ============================================================
-- FAZA 20b — STRAT SOCIAL REAL (comentarii, reacții, urmăritori,
-- feed activitate, cache L2 distribuit în Neon). Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS social_comment (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  body TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sc_media_idx ON social_comment ("mediaId", "mediaType", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS sc_user_idx ON social_comment ("userId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS social_reaction (
  "userId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'like',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "targetId", kind)
);

CREATE INDEX IF NOT EXISTS sr_target_idx ON social_reaction ("targetId");

CREATE TABLE IF NOT EXISTS social_follow (
  "followerId" TEXT NOT NULL,
  "followeeId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("followerId", "followeeId")
);

CREATE INDEX IF NOT EXISTS sf_followee_idx ON social_follow ("followeeId");

CREATE TABLE IF NOT EXISTS social_activity (
  id BIGSERIAL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  kind TEXT NOT NULL,
  "mediaId" TEXT,
  "mediaType" TEXT,
  title TEXT,
  poster TEXT,
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sa_created_idx ON social_activity ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS sa_user_idx ON social_activity ("userId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS social_cache (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS socache_created_idx ON social_cache (created_at);
