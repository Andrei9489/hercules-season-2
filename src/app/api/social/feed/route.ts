import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { activityFeed } from "@/lib/social";
import { wrapMetrics } from "@/lib/http-cache";

async function getHandler(req: NextRequest): Promise<Response> {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 20, 1), 50);
  const session = await getServerSession(authOptions);
  const viewerId = session?.user?.email ? await getUserIdByEmail(session.user.email) : null;
  const feed = await activityFeed(viewerId, limit);
  return NextResponse.json({ ...feed, authed: Boolean(viewerId) });
}

export const GET = wrapMetrics("social.feed", getHandler);
