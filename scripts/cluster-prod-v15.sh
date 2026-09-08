#!/bin/bash
# ============================================================
# FAZA 15 — MIGRAȚIE PRODUCȚIE: cluster N instanțe Next.js standalone
# Rulează pe NODE (pattern-ul oficial Next standalone) cu env Neon
# explicit. Porturi 3101..3104 în spatele load balancer-ului
# (scripts/lb-v15.mjs, port 3210). Idempotent.
# ============================================================
set -u
cd /home/z/my-project

INSTANCES=(3101 3102 3103 3104)
mkdir -p .zscripts

NEON_URL="$(grep '^NEON_DATABASE_URL=' .env | cut -d= -f2-)"
if [ -z "$NEON_URL" ]; then
  echo "❌ NEON_DATABASE_URL lipsește din .env"
  exit 1
fi

echo "── Verific build standalone…"
if [ ! -f .next/standalone/server.js ]; then
  echo "❌ Lipsește .next/standalone/server.js — rulează întâi: bun run build"
  exit 1
fi

echo "── Opresc instanțele producție vechi (dacă există)…"
for port in "${INSTANCES[@]}"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || fuser -k "$port"/tcp 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    echo "   port $port: oprit ($pids)"
  fi
done
sleep 1

echo "── Pornesc ${#INSTANCES[@]} instanțe producție pe NODE…"
for port in "${INSTANCES[@]}"; do
  PORT="$port" HOSTNAME=0.0.0.0 NODE_ENV=production NEON_DATABASE_URL="$NEON_URL" \
    nohup node .next/standalone/server.js > ".zscripts/prod-$port.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo "   instanță pe :$port pornită (log .zscripts/prod-$port.log)"
done

echo "── Gata spawn. Health-check: curl http://127.0.0.1:<port>/api/health"
