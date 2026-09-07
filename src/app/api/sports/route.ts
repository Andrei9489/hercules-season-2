import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

const FD_KEY = process.env.FOOTBALL_DATA_API_KEY || "8053ce106f444e9ca7d1bdf859b81b99";
const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "552b85f6-65b9-4aa7-b058-8201ebc06e47";

const FD_HEADERS = { "X-Auth-Token": FD_KEY };

export type SportEvent = {
  id: string;
  competition: string;
  home: string;
  away: string;
  score: string | null;
  date: string;
  status: string;
  sport: string;
  source: string;
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "football";

  try {
    if (mode === "football") {
      // Top competitions: PL, PD(la liga), SA(serie A), BL1(bundesliga), FL1(ligue1), CL(ucl), RWC
      const comp = sp.get("competition") || "PL";
      const status = sp.get("status") || "SCHEDULED"; // SCHEDULED | FINISHED | LIVE
      const data = await cachedFetch<{
        matches: {
          id: number; utcDate: string; status: string;
          homeTeam: { name: string }; awayTeam: { name: string };
          score: { fullTime: { home: number | null; away: number | null } };
          competition: { name: string };
        }[];
      }>(
        `https://api.football-data.org/v4/competitions/${comp}/matches?status=${status}`,
        { ttl: 300, headers: FD_HEADERS }
      );
      const events: SportEvent[] = (data.matches || []).slice(0, 20).map((m) => ({
        id: String(m.id),
        competition: m.competition?.name || comp,
        home: m.homeTeam?.name || "?",
        away: m.awayTeam?.name || "?",
        score:
          m.score?.fullTime?.home != null
            ? `${m.score.fullTime.home} - ${m.score.fullTime.away}`
            : null,
        date: m.utcDate,
        status: m.status,
        sport: "Fotbal",
        source: "football-data",
      }));
      return NextResponse.json(events);
    }

    if (mode === "standings") {
      const comp = sp.get("competition") || "PL";
      const data = await cachedFetch<{
        standings: {
          type: string;
          table: {
            position: number;
            team: { name: string; tla?: string; crest?: string };
            playedGames: number;
            won: number; draw: number; lost: number;
            goalsFor: number; goalsAgainst: number; points: number;
          }[];
        }[];
      }>(
        `https://api.football-data.org/v4/competitions/${comp}/standings`,
        { ttl: 600, headers: FD_HEADERS }
      );
      const table = data.standings?.find((s) => s.type === "TOTAL")?.table || [];
      return NextResponse.json(
        table.slice(0, 20).map((r) => ({
          pos: r.position,
          team: r.team?.name || "?",
          crest: r.team?.crest || null,
          j: r.playedGames, v: r.won, e: r.draw, i: r.lost,
          gm: r.goalsFor, gp: r.goalsAgainst, pct: r.points,
        }))
      );
    }

    if (mode === "nba") {
      const season = sp.get("season") || "2025";
      const data = await cachedFetch<{ data: Record<string, unknown>[] }>(
        `https://api.balldontlie.io/v1/games?season=${season}&per_page=12&postseason=false`,
        { ttl: 600, headers: { Authorization: BDL_KEY } }
      );
      const events: SportEvent[] = (data.data || []).map((g) => {
        const date = String(g.date || "").slice(0, 10);
        return {
          id: String(g.id),
          competition: String((g.league as { name?: string })?.name || "NBA"),
          home: String((g.home_team as { full_name?: string })?.full_name || g.home_team_id),
          away: String((g.visitor_team as { full_name?: string })?.full_name || g.visitor_team_id),
          score:
            g.status === "Final" || g.home_team_score
              ? `${g.home_team_score ?? 0} - ${g.visitor_team_score ?? 0}`
              : null,
          date,
          status: String(g.status || ""),
          sport: "Baschet",
          source: "balldontlie",
        };
      });
      return NextResponse.json(events);
    }

    if (mode === "f1") {
      // Ergast is deprecated; try jolpica-f1 mirror API
      const season = sp.get("season") || "2026";
      const data = await cachedFetch<{
        races?: {
          raceName: string; round: string; date: string; time: string;
          Circuit: { circuitName: string; Location: { locality: string; country: string } };
          Results?: { position: string; Driver: { givenName: string; familyName: string }; Constructor: { name: string }; Time?: { time: string } }[];
        }[];
      }>(
        `https://api.jolpi.ca/ergast/f1/${season}.json`,
        { ttl: 1800 }
      ).catch(() => ({ races: [] }));
      const races = (data.races || []).slice(0, 24).map((r, i) => ({
        id: `f1-${season}-${r.round || i}`,
        competition: r.raceName || "Grand Prix",
        home: r.Circuit?.circuitName || "",
        away: `${r.Circuit?.Location?.locality || ""}, ${r.Circuit?.Location?.country || ""}`,
        score: r.Results?.[0]
          ? `P1: ${r.Results[0].Driver?.givenName} ${r.Results[0].Driver?.familyName} (${r.Results[0].Constructor?.name})`
          : null,
        date: r.date ? `${r.date}${r.time ? `T${r.time}` : ""}` : "",
        status: r.Results?.length ? "Final" : "SCHEDULED",
        sport: "Formula 1",
        source: "ergast",
      }));
      return NextResponse.json(races);
    }

    if (mode === "thousands" || mode === "sportsdb") {
      // TheSportsDB public — lives/events
      const data = await cachedFetch<{
        events?: {
          idEvent: string; strEvent: string; strLeague: string;
          dateEvent: string; strTime: string; strStatus: string;
          intHomeScore: string | null; intAwayScore: string | null;
        }[];
      }>(
        `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${new Date().toISOString().slice(0, 10)}&l=NBA`,
        { ttl: 600 }
      );
      const events: SportEvent[] = (data.events || []).slice(0, 20).map((e) => ({
        id: e.idEvent,
        competition: e.strLeague || "",
        home: e.strEvent?.split(" vs ")[0] || "",
        away: e.strEvent?.split(" vs ")[1] || "",
        score: e.intHomeScore ? `${e.intHomeScore} - ${e.intAwayScore}` : null,
        date: `${e.dateEvent}T${e.strTime || "00:00:00"}`,
        status: e.strStatus || "",
        sport: "Sport",
        source: "thesportsdb",
      }));
      return NextResponse.json(events);
    }

    if (mode === "openliga") {
      // German Bundesliga (league 4786 = 2.BL? 4602 bl3) — bl1
      const data = await cachedFetch<Record<string, unknown>[]>(
        `https://api.openligadb.de/getmatchdata/bl1`, { ttl: 900 }
      );
      const events: SportEvent[] = (data || []).slice(0, 15).map((m) => {
        const t1 = m.team1 as { teamName?: string } | undefined;
        const t2 = m.team2 as { teamName?: string } | undefined;
        const res = m.matchResults as { pointsTeam1: number; pointsTeam2: number; resultTypeID: number }[] | undefined;
        const final = res?.find((r) => r.resultTypeID === 2);
        return {
          id: String(m.matchID),
          competition: "Bundesliga",
          home: t1?.teamName || "?",
          away: t2?.teamName || "?",
          score: final ? `${final.pointsTeam1} - ${final.pointsTeam2}` : null,
          date: String(m.matchDateTimeUTC || m.matchDateTime || ""),
          status: m.matchIsFinished ? "FINISHED" : "SCHEDULED",
          sport: "Fotbal",
          source: "openligadb",
        };
      });
      return NextResponse.json(events);
    }

    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("Sports route error:", e);
    return NextResponse.json(
      { error: "Eroare la preluarea datelor sportive", detail: String(e).slice(0, 150) },
      { status: 502 }
    );
  }
}
