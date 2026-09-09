#!/bin/bash
# ============================================================
# FAZA 20a — CLUSTER DE PRODUCȚIE EXTINS: N instanțe Next.js
# standalone (build curent) în spatele load balancer-ului.
# Configurabil: N_INSTANCES=6 bash scripts/cluster-prod-v20.sh
# Porturi 3101..310N + LB pe 3210 (scripts/lb-v15.mjs, UPSTREAMS env).
# Idempotent. Verificare: curl http://127.0.0.1:3210/lb-status
# ============================================================
set -u
cd /home/z/my-project

N="${N_INSTANCES:-6}"
PORTS=$(seq 3101 $((3100 + N)))
echo "── Cluster de ${N} instanțe: $(echo $PORTS | tr '\n' ' ')"

NEON_URL="$(grep -E '^(NEON_DATABASE_URL|DATABASE_URL)=' .env | head -1 | cut -d= -f2-)"
if [ -z "$NEON_URL" ]; then
  echo "❌ NEON_DATABASE_URL lipsește din .env"
  exit 1
fi

if [ ! -f .next/standalone/server.js ]; then
  echo "❌ Lipsește .next/standalone/server.js — rulează întâi: bun run build"
  exit 1
fi

mkdir -p .zscripts

echo "── Opresc instanțele producție vechi (dacă există)…"
for port in $(seq 3101 3120); do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    echo "   port $port: oprit"
  fi
done
sleep 1

echo "── Opresc LB-ul vechi (dacă există)…"
pids=$(lsof -ti tcp:3210 2>/dev/null || true)
if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; echo "   LB oprit"; fi
sleep 1

echo "── Pornesc ${N} instanțe standalone pe NODE…"
for port in $PORTS; do
  PORT="$port" HOSTNAME=0.0.0.0 NODE_ENV=production NEON_DATABASE_URL="$NEON_URL" \
    nohup node .next/standalone/server.js > ".zscripts/prod-$port.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  echo "   instanță :$port pornită"
done

echo "── Aștept health-check pe toate instanțele…"
ALL_OK=0
for i in $(seq 1 30); do
  OK_COUNT=0
  for port in $PORTS; do
    if curl -s --max-time 2 "http://127.0.0.1:$port/api/health" | rg -q '"ok":true' 2>/dev/null; then
      OK_COUNT=$((OK_COUNT + 1))
    fi
  done
  echo "   încercarea $i: $OK_COUNT/${N} instanțe OK"
  if [ "$OK_COUNT" -eq "$N" ]; then ALL_OK=1; break; fi
  sleep 2
done

if [ "$ALL_OK" -ne 1 ]; then
  echo "⚠️  Nu toate instanțele sunt sănătoase — verifică .zscripts/prod-*.log"
fi

echo "── Pornesc load balancer-ul pe :3210…"
UPSTREAMS=$(for port in $PORTS; do echo -n "127.0.0.1:$port,"; done | sed 's/,$//')
PORT=3210 UPSTREAMS="$UPSTREAMS" nohup bun scripts/lb-v15.mjs > .zscripts/lb-v20.log 2>&1 < /dev/null &
disown 2>/dev/null || true
sleep 2

echo "── Verific LB…"
curl -s --max-time 4 http://127.0.0.1:3210/lb-status | head -c 400
echo ""
echo "✅ Cluster ${N} instanțe + LB gata: http://127.0.0.1:3210"
