import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { q, qOne } from "@/lib/pg";
import { invalidateRecommendations } from "@/lib/recommendations";

type MediaRef = {
  mediaId: string;
  mediaType: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  year?: string | null;
  rating?: number | null;
  source?: string;
};

async function requireUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return getUserIdByEmail(session.user.email);
}

const TABLES: Record<string, string> = {
  favorites: "Favorite",
  watchlist: "Watchlist",
  history: "History",
  profiles: "Profile",
  reviews: "Review",
};

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind") || "favorites";
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ items: [], authed: false });

    const table = TABLES[kind];
    if (!table) return NextResponse.json({ items: [], authed: false });

    const order =
      kind === "history" ? `"updatedAt" DESC` : `"createdAt" DESC`;
    const items = await q(
      `SELECT * FROM "${table}" WHERE "userId" = $1 ORDER BY ${order} LIMIT 200`,
      [userId]
    );
    return NextResponse.json({ items, authed: true });
  } catch (e) {
    console.error("User GET error:", e);
    return NextResponse.json({ items: [], authed: false });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    if (!userId)
      return NextResponse.json({ error: "Autentificare necesară" }, { status: 401 });

    const body = (await req.json()) as {
      action: "add" | "remove" | "toggle" | "progress" | "clear";
      kind: "favorites" | "watchlist" | "history" | "profiles" | "reviews";
      media?: MediaRef;
      trailerKey?: string;
      progress?: number;
      duration?: number;
      rating?: number;
      comment?: string;
      profile?: { name: string; avatar?: string; color?: string; isKid?: boolean };
    };
    const { action, kind, media } = body;

    // Faza 18b — recomandările personalizate se recalculează la următoarea cerere
    // (invalidare L2 fire-and-forget la orice scriere de semnale)
    if (kind === "favorites" || kind === "watchlist" || kind === "history") {
      void invalidateRecommendations(userId).catch(() => {});
    }

    if (kind === "profiles") {
      if (action === "add" && body.profile) {
        const countRow = await qOne<{ n: string }>(
          `SELECT count(*)::text AS n FROM "Profile" WHERE "userId" = $1`, [userId]
        );
        if (Number(countRow?.n || 0) >= 6)
          return NextResponse.json({ error: "Maxim 6 profiluri" }, { status: 400 });
        const p = await qOne(
          `INSERT INTO "Profile" ("id","userId","name","avatar","color","isKid")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5) RETURNING *`,
          [userId, body.profile.name, body.profile.avatar || "🎬", body.profile.color || "#e50914", body.profile.isKid || false]
        );
        return NextResponse.json(p);
      }
      return NextResponse.json({ error: "Acțiune invalidă" }, { status: 400 });
    }

    if (kind === "reviews") {
      if (action === "add" && media && body.rating) {
        const r = await qOne(
          `INSERT INTO "Review" ("id","userId","mediaId","mediaType","rating","comment")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)
           ON CONFLICT ("userId","mediaId","mediaType")
           DO UPDATE SET "rating" = $4, "comment" = $5 RETURNING *`,
          [userId, media.mediaId, media.mediaType, body.rating, body.comment || ""]
        );
        return NextResponse.json(r);
      }
      return NextResponse.json({ error: "Date invalide" }, { status: 400 });
    }

    if (!media) return NextResponse.json({ error: "Lipsesc datele media" }, { status: 400 });

    const common = [
      media.title,
      media.poster ?? null,
      media.backdrop ?? null,
      media.year ?? null,
      media.rating ?? null,
      media.source || "tmdb",
    ];

    if (kind === "favorites" || kind === "watchlist") {
      const table = kind === "favorites" ? "Favorite" : "Watchlist";

      if (action === "remove") {
        await q(
          `DELETE FROM "${table}" WHERE "userId" = $1 AND "mediaId" = $2 AND "mediaType" = $3`,
          [userId, media.mediaId, media.mediaType]
        );
        return NextResponse.json({ ok: true, active: false });
      }
      if (action === "toggle" || action === "add") {
        const existing = await qOne<{ id: string }>(
          `SELECT "id" FROM "${table}" WHERE "userId" = $1 AND "mediaId" = $2 AND "mediaType" = $3`,
          [userId, media.mediaId, media.mediaType]
        );
        if (existing && action === "toggle") {
          await q(`DELETE FROM "${table}" WHERE "id" = $1`, [existing.id]);
          return NextResponse.json({ ok: true, active: false });
        }
        const created = await qOne(
          `INSERT INTO "${table}" ("id","userId","mediaId","mediaType","title","poster","backdrop","year","rating","source")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT ("userId","mediaId","mediaType")
           DO UPDATE SET "title" = $4, "poster" = $5, "backdrop" = $6, "year" = $7, "rating" = $8, "source" = $9
           RETURNING *`,
          [userId, media.mediaId, media.mediaType, ...common]
        );
        return NextResponse.json({ ok: true, active: true, item: created });
      }
    }

    if (kind === "history") {
      if (action === "clear") {
        await q(`DELETE FROM "History" WHERE "userId" = $1`, [userId]);
        return NextResponse.json({ ok: true });
      }
      const h = await qOne(
        `INSERT INTO "History" ("id","userId","mediaId","mediaType","title","poster","backdrop","year","rating","source","progress","duration","trailerKey")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT ("userId","mediaId","mediaType")
         DO UPDATE SET "progress" = $10, "duration" = $11, "trailerKey" = $12, "updatedAt" = now()
         RETURNING *`,
        [userId, media.mediaId, media.mediaType, ...common, body.progress ?? 0, body.duration ?? 0, body.trailerKey ?? null]
      );
      return NextResponse.json(h);
    }

    return NextResponse.json({ error: "Operațiune necunoscută" }, { status: 400 });
  } catch (e) {
    console.error("User POST error:", e);
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
