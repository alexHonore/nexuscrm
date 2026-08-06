import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pgConn?: ReturnType<typeof postgres> };

const url = process.env.DATABASE_URL!;
const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

const conn =
  globalForDb.pgConn ??
  postgres(url, {
    // Compatible pgbouncer/Supavisor (Supabase "Transaction pooler") et Postgres local.
    prepare: false,
    max: 5,
    // Supabase/Neon exigent TLS ; les URI n'incluent pas toujours sslmode=require.
    ...(isLocal ? {} : { ssl: "require" as const }),
  });
if (process.env.NODE_ENV !== "production") globalForDb.pgConn = conn;

export const db = drizzle(conn, { schema });
export * as tables from "./schema";
