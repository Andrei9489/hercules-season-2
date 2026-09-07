// Izolează problema PrismaNeon: bun standalone vs Next runtime
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;
const url = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 2 });
const adapter = new PrismaNeon(pool);
const client = new PrismaClient({ adapter });
try {
  const n = await client.user.count();
  console.log("PRISMA+ADAPTER in bun standalone: OK — users:", n);
} catch (e) {
  console.log("PRISMA+ADAPTER in bun standalone: FAIL —", String(e).slice(0, 200));
} finally {
  await client.$disconnect();
}
