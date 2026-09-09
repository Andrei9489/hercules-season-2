import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { toggleCommentLike } from "@/lib/social";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import { wrapMetrics } from "@/lib/http-cache";

async function postHandler(req: NextRequest): Promise<Response> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.email ? await getUserIdByEmail(session.user.email) : null;
  if (!userId)
    return NextResponse.json({ error: "Autentificare necesară" }, { status: 401 });

  const rl = rateLimit(`soc-rx:${clientIp(req)}`, { burst: 30, perMinute: 120 });
  if (!rl.ok) return tooMany(rl);

  const body = (await req.json()) as { commentId?: string };
  if (!body.commentId || body.commentId.length > 64)
    return NextResponse.json({ error: "commentId invalid" }, { status: 400 });

  const r = await toggleCommentLike(userId, body.commentId);
  return NextResponse.json({ ok: true, ...r });
}

export const POST = wrapMetrics("social.reactions", postHandler);
