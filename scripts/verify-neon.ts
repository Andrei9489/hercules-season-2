import { neon } from "@neondatabase/serverless";
const url = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const sql = neon(url);
const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE '"%' OR tablename = ANY(ARRAY['User','Account','Session','VerificationToken','Profile','Favorite','Watchlist','History','Review'])) ORDER BY tablename`;
console.log("App tables:", JSON.stringify(tables.map((t: { tablename: string }) => t.tablename)));
const all = await sql`SELECT count(*)::int as n FROM pg_tables WHERE schemaname='public'`;
console.log("Total public tables:", all[0].n);
