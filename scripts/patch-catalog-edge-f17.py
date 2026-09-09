#!/usr/bin/env python3
"""Faza 17a — aplică wrapPublicGet (edge cache + metrics) pe cele 10 rute de cataloage externe.
Transformare per fișier:
  1. import { wrapPublicGet } adăugat după ultimul import existent
  2. `export async function GET(req: NextRequest) {` → `async function getHandler(req: NextRequest) {`
  3. la final: `export const GET = wrapPublicGet("<route>", getHandler, { sMaxage: N, swr: M });`
Idempotent: sare fișierele deja patch-uite.
"""
import re
from pathlib import Path

ROOT = Path("/home/z/my-project/src/app/api")

# route → (sMaxage, swr) — calibrate: catologuele se schimbă lent; sports/news mai rapid
TTL = {
    "tmdb": (300, 600),
    "tv": (300, 600),
    "anime": (300, 600),
    "music": (600, 900),
    "sports": (60, 120),
    "gaming": (300, 600),
    "kids": (300, 600),
    "news": (60, 180),
    "fun": (300, 600),
    "subtitles": (120, 300),
}

for route, (smax, swr) in TTL.items():
    p = ROOT / route / "route.ts"
    src = p.read_text(encoding="utf-8")

    if "wrapPublicGet" in src:
        print(f"[skip] {route}: deja patch-uit")
        continue

    # 1. adaugă importul după ultimul import de la capul fișierului
    imports = list(re.finditer(r"^import .*?;\s*$", src, re.M))
    if not imports:
        print(f"[ERR] {route}: niciun import găsit")
        continue
    last = imports[-1]
    src = src[: last.end()] + f'\nimport {{ wrapPublicGet }} from "@/lib/http-cache";' + src[last.end():]

    # 2. redenumește exportul GET
    pat = "export async function GET(req: NextRequest) {"
    if pat not in src:
        print(f"[ERR] {route}: semnătura GET nu găsită")
        continue
    src = src.replace(pat, "async function getHandler(req: NextRequest) {", 1)

    # 3. export wrapper la final
    src = src.rstrip() + f'\n\n// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru {route}\nexport const GET = wrapPublicGet("{route}", getHandler, {{ sMaxage: {smax}, swr: {swr} }});\n'

    p.write_text(src, encoding="utf-8")
    print(f"[ok] {route}: s-maxage={smax}, swr={swr}")

print("GATA")
