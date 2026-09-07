import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { q, qOne } from "@/lib/pg";

type UserRow = { id: string; name: string | null; email: string | null; image: string | null };

async function upsertUser(name: string | null, email: string, image: string | null): Promise<void> {
  await q(
    `INSERT INTO "User" ("id", "name", "email", "image")
     VALUES (gen_random_uuid()::text, $1, $2, $3)
     ON CONFLICT ("email") DO UPDATE SET "name" = COALESCE($1, "User"."name"), "image" = COALESCE($3, "User"."image")`,
    [name, email, image]
  );
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET || "sUp3rZ-stream1ng-platf0rm-9x7Kq2Wn8Lp4Vt6Rm3Jb5Dy1",
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/" },
  providers: [
    GoogleProvider({
      clientId:
        process.env.GOOGLE_CLIENT_ID ||
        "891945100564-hbkdabcpacfc0tadn0r7dg8h8c4hpp7h.apps.googleusercontent.com",
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET ||
        "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",
      authorization: { params: { prompt: "select_account" } },
    }),
    CredentialsProvider({
      name: "Cont Demo",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "demo@streamverse.ro" },
        name: { label: "Nume", type: "text", placeholder: "Vizitator" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        if (!email || !email.includes("@")) return null;
        const name = credentials?.name?.trim() || email.split("@")[0];
        try {
          await upsertUser(name, email, null);
        } catch (e) {
          console.error("DB upsert failed (auth continues with JWT):", e);
        }
        return { id: `demo:${email}`, name, email, image: null };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      try {
        if (account?.provider === "google" && user.email) {
          await upsertUser(user.name ?? null, user.email, user.image ?? null);
        }
      } catch (e) {
        console.error("signIn DB sync failed:", e);
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.name = user.name;
        token.email = user.email;
        token.picture = user.image;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email as string | null;
        session.user.name = token.name as string | null;
        session.user.image = token.picture as string | null;
      }
      return session;
    },
  },
};

export async function getUserIdByEmail(email: string): Promise<string | null> {
  const row = await qOne<{ id: string }>(`SELECT "id" FROM "User" WHERE "email" = $1 LIMIT 1`, [email]);
  if (row) return row.id;
  const name = email.split("@")[0];
  const created = await qOne<{ id: string }>(
    `INSERT INTO "User" ("id", "name", "email") VALUES (gen_random_uuid()::text, $1, $2) RETURNING "id"`,
    [name, email]
  );
  return created?.id ?? null;
}

export type { UserRow };
