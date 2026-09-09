import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { toggleFollow, followStatus } from "@/lib/social";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import { wrapMetrics } from "@/lib/http-cache";

async function requireUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return getUserIdByEmail(session.user.email);
}

async function getHandler(req: NextRequest): Promise<Response> {
  const target = req.nextUrl.searchParams.get("userId");
  if (!target || target.length > 64)
    return NextResponse.json({ error: "userId lipsă" }, { status: 400 });

  const session = await getServerSession(authOptions);
  const viewerId = session?.user?.email ? await getUserIdByEmail(session.user.email) : null;
  const st = await followStatus(viewerId, target);
  return NextResponse.json(st);
}

async function postHandler(req: NextRequest): Promise<Response> {
  const userId = await requireUserId();
  if (!userId)
    return NextResponse.json({ error: "Autentificare necesară" }, { status: 401 });

  const rl = rateLimit(`soc-fl:${clientIp(req)}`, { burst: 15, perMinute: 60 });
  if (!rl.ok) return tooMany(rl);

  const body = (await req.json()) as { userId?: string };
  if (!body.userId || body.userId.length > 64)
    return NextResponse.json({ error: "userId invalid" }, { status: 400 });

  try {
    const r = await toggleFollow(userId, body.userId);
    const st = await followStatus(userId, body.userId);
    return NextResponse.json({ ok: true, ...r, followers: st.followers, following: st.following });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 120) }, { status: 400 });
  }
}

export const GET = (req: NextRequest) => getHandler(req);
export const POST = wrapMetrics("social.follow", postHandler);
