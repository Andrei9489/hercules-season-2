-- ============================================================
-- FAZA 14 — NEON SYNC HUB
-- Tabele pentru sincronizarea operațiunilor offline (outbox)
-- și jurnalul de sincronizări.
-- Idempotent: poate fi rulat de oricâte ori.
-- ============================================================

-- 1) sync_log: fiecare rulare de sincronizare a unui utilizator
CREATE TABLE IF NOT EXISTS sync_log (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "device" TEXT NOT NULL DEFAULT 'web',
  "pushed" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "opsByType" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "ok" BOOLEAN NOT NULL DEFAULT true,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_log_user_created_idx ON sync_log ("userId", "createdAt" DESC);

-- 2) sync_seen: idempotență per operațiune (opId generat client-side, UUID)
--    Același opId trimis de 2 ori NU se aplică de 2 ori.
CREATE TABLE IF NOT EXISTS sync_seen (
  "userId" TEXT NOT NULL,
  "opId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "result" JSONB,
  "seenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "opId")
);

-- 2b) migrare tabele create anterior (colonia result adăugată în Faza 14)
ALTER TABLE sync_seen ADD COLUMN IF NOT EXISTS "result" JSONB;

-- 3) statistici rapide în sync_log (mărime operațiuni pe tip)
COMMENT ON TABLE sync_log IS 'Faza 14: jurnal de sincronizări Neon Sync (outbox offline → Neon)';
COMMENT ON TABLE sync_seen IS 'Faza 14: idempotență sync — chei (userId, opId) deja aplicate';
