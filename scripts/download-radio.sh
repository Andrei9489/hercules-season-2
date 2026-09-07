#!/bin/bash
# Descărcare paginată radio-browser (throttled ~10KB/s → rulează în background)
cd /home/z/my-project
mkdir -p data/radio
PAGES=${1:-16}
SIZE=500
for i in $(seq 0 $((PAGES-1))); do
  off=$((i*SIZE))
  f="data/radio/p$i.json"
  if [ -s "$f" ] && node -e "const d=require('./$f'); process.exit(d.length>0?0:1)" 2>/dev/null; then
    echo "p$i există OK ($(node -e "console.log(require('./$f').length)") stații)"
    continue
  fi
  for attempt in 1 2; do
    code=$(curl -s "https://all.api.radio-browser.info/json/stations/search?limit=$SIZE&offset=$off&order=clickcount&reverse=true&hidebroken=true&is_https=true" -o "$f.tmp" --compressed -m 240 -w "%{http_code}")
    if [ "$code" = "200" ] && node -e "const d=require('./$f.tmp'); process.exit(d.length>0?0:1)" 2>/dev/null; then
      mv "$f.tmp" "$f"
      echo "p$i OK: $(node -e "console.log(require('./$f').length)") stații (offset $off)"
      break
    else
      echo "p$i eșuare (HTTP $code, încercarea $attempt)"
      sleep 3
    fi
  done
  sleep 1
done
echo "DOWNLOAD DONE"
ls data/radio/ | wc -l
