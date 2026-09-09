import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { addComment, listComments, deleteComment } from "@/lib/social";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import { wrapMetrics } from "@/lib/http-cache";

async function requireUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return getUserIdByEmail(session.user.email);
}

async function getHandler(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const mediaId = sp.get("mediaId");
  const mediaType = sp.get("mediaType") || "movie";
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 20, 1), 50);
  const offset = Math.min(Math.max(Number(sp.get("offset")) || 0, 0), 5000);
  if (!mediaId || mediaId.length > 200)
    return NextResponse.json({ items: [], total: 0, authed: false });

  const session = await getServerSession(authOptions);
  const viewerId = session?.user?.email ? await getUserIdByEmail(session.user.email) : null;

  const { items, total } = await listComments(mediaId, mediaType, viewerId, limit, offset);
  return NextResponse.json({ items, total, authed: Boolean(viewerId) });
}

async function postHandler(req: NextRequest): Promise<Response> {
  const userId = await requireUserId();
  if (!userId)
    return NextResponse.json({ error: "Autentificare necesară" }, { status: 401 });

  const rl = rateLimit(`soc-cm:${clientIp(req)}`, { burst: 8, perMinute: 30 });
  if (!rl.ok) return tooMany(rl);

  const body = (await req.json()) as {
    mediaId?: string; mediaType?: string; body?: string;
  };
  if (!body.mediaId || !body.body || typeof body.body !== "string" ||
      body.mediaId.length > 200 || (body.mediaType || "").length > 40)
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });

  const c = await addComment(userId, body.mediaId, body.mediaType || "movie", body.body);
  return NextResponse.json({ ok: true, comment: c });
}

async function deleteHandler(req: NextRequest): Promise<Response> {
  const userId = await requireUserId();
  if (!userId)
    return NextResponse.json({ error: "Autentificare necesară" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id || id.length > 64)
    return NextResponse.json({ error: "ID lipsă" }, { status: 400 });

  const ok = await deleteComment(userId, id);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}

export const GET = (req: NextRequest) => getHandler(req);
export const POST = wrapMetrics("social.comments", postHandler);
export const DELETE = wrapMetrics("social.comments", deleteHandler);
