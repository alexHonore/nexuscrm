import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pgConn?: ReturnType<typeof postgres> };

const conn =
  globalForDb.pgConn ??
  postgres(process.env.DATABASE_URL!, {
    // Neon/pgbouncer compatible; also fine on plain Postgres.
    prepare: false,
    max: 5,
  });
if (process.env.NODE_ENV !== "production") globalForDb.pgConn = conn;

export const db = drizzle(conn, { schema });
export * as tables from "./schema";
