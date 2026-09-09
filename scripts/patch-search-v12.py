#!/usr/bin/env python3
# Faza 12: înlocuiește closure-ul exec inline din searchLibrary cu apel searchRecompute
import re

p = "/home/z/my-project/src/lib/neon-search.ts"
src = open(p).read()

start_marker = "  const exec = (async (): Promise<LibraryHit[]> => {"
end_marker = "  })();"

i = src.find(start_marker)
if i < 0:
    raise SystemExit("start marker negăsit")
j = src.find(end_marker, i)
if j < 0:
    raise SystemExit("end marker negăsit")
j += len(end_marker)

replacement = "  const exec = searchRecompute(cacheKey, norm, limit, offset, type, brand);"
src = src[:i] + replacement + src[j:]
open(p, "w").write(src)
print(f"Înlocuit blocul [{i}:{j}] cu apelul searchRecompute")
