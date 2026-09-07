# Worklog — Multi-Agent Shared Log

---
Task ID: 1
Agent: Main Agent (Super Z)
Task: Construire platformă de streaming universală (StreamVerse) — Next.js 16, NextAuth Google OAuth, Neon Postgres, integrare TMDB/Jikan/TVMaze/iTunes/YouTube/Football-Data/Balldontlie/OpenSubtitles + API-uri publice (F1, OpenLigaDB, TheSportsDB, PokeAPI, OpenDota, Steam, Minecraft, Ghibli, waifu.pics, nekos.best, catboys, RSS BBC/CNN/NHK/Al Jazeera, Trivia, JokeAPI, Quotable, lyrics.ovh, MusicBrainz implicit prin iTunes).

Work Log:
- Inițializat mediul fullstack (init-fullstack.sh), verificat package.json și structura proiectului.
- Testat conectivitate externă: TMDB ✅, YouTube ✅, Football-Data ✅, Jikan ✅, Neon direct 5432 ❌ (port blocat în sandbox).
- Baza de date: portul 5432 blocat → folosit @neondatabase/serverless pe 443. Modul HTTP (`neon()`) a dovedit inconsistent (scrieri pe compute-uri diferite — DB cu tabele vechi "animaxia_*" de la un proiect anterior). Modul WebSocket (`Pool` + `ws`) persistă corect → adoptat.
- Parola corectă Neon: a doua din mesaj (npg_k8zGXZEKr5xV); prima (npg_udxJF6H8KetL) respinsă de server.
- Schema DDL generată cu `prisma migrate diff` și aplicată prin script `scripts/init-neon.ts` (29 instrucțiuni OK): User, Account, Session, VerificationToken, Profile, Favorite, Watchlist, History, Review. Tabelele animaxia_* existente nu au fost atinse.
- Adapterul Prisma `@prisma/adapter-neon` NU funcționează în acest runtime (inclus bun standalone) — înlocuit cu strat de date SQL direct pe driverul Neon (`src/lib/pg.ts`, cu retry la conexiuni WS moarte + idleTimeout 8s).
- NextAuth v4: Google provider (cheile furnizate de utilizator) + Credentials demo; JWT strategy; users sincronizați în Neon la signIn/authorize. NEXTAUTH_URL=https://y1bjb7ep8wv1-d.space-z.ai (domeniul public al sandbox-ului).
- 12 rute API create: tmdb (trending/list/discover/search/details/similar/brand/telenovela), tv (TVMaze), anime (Jikan + fallback TMDB JP), music (iTunes + YouTube + lyrics.ovh), sports (football-data, standings, NBA balldontlie, F1 jolpica/ergast, openligadb, thesportsdb), gaming (pokemon, dota, steam, minecraft status), kids (ghibli, poke, nekos, waifu, catboy), news (RSS parser propriu), fun (trivia/joke/quote), subtitles (OpenSubtitles), user (favorites/watchlist/history/profiles/reviews pe SQL), search (agregat multi-sursă).
- Frontend SPA la `/`: Shell cu sidebar (13 secțiuni), topbar cu căutare globală, hero carousel, rânduri cu scroll orizontal, carduri cu hover-actions, modal detalii (trailer, watchlist, favorit, subtitrări RO, rating cu review), player modal YouTube cu salvare progres, dialoguri profiluri (până la 6, avatar emoji), login dropdown (Google + demo email).
- Branduri curate implementate: Disney, Pixar, Cartoon Network, Jetix, Fox Kids, Boomerang, Minimax, Ghibli (+ Marvel, DC prin company IDs TMDB).
- Fix-uri în timpul verificării: ghilimele românești care rupeau stringuri, erori eslint react-hooks/set-state-in-effect (derive state / async callbacks), useState lipsă din import (SearchView), variabilă duplicat (gaming dota), retry+backoff pentru Jikan 429/504 și TVMaze ETIMEDOUT, dns ipv4first pentru flakiness de rețea sandbox, chei React duplicate (avatar 🎬 dublu), aria-describedby pentru Dialog.
- Verificare Agent Browser: home + hero RO, detalii (Silozul), Kids→Disney/Cartoon Network/Ghibli, Sport (meciuri reale Premier League + clasamente), căutare "Oppenheimer" multi-sursă, login demo end-to-end, creare profil "Copii" ✅ toast, watchlist add 2 titluri ✅, Lista Mea afișează salvările ✅, Anime (fallback), Știri BBC reale, Muzică cu artwork iTunes.

Stage Summary:
- Aplicație completă funcțională pe port 3000; lint curat (0 erori/0 warning-uri); DB Neon funcțională pe WS.
- Fișiere cheie: src/lib/{pg,auth,cache,brands}.ts, src/app/api/* (12 rute), src/components/streaming/* (16 componente), prisma/schema.prisma, .env.
- Cunoscute: YouTube embed poate cere verificare anti-bot în headless (normal la utilizator real); Steam storefront API uneori gol din sandbox (fallback gol elegant); Jikan depinde de serviciul extern (fallback TMDB activ).
- Securitate: utilizatorul a partajat chei în chat — recomandat rotirea lor ulterior.
