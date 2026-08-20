import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schemaCrm from "./schema";
import * as schemaSms from "./schema-sms";

const schema = { ...schemaCrm, ...schemaSms };

const globalForDb = globalThis as unknown as { pgConn?: ReturnType<typeof postgres> };

const url = process.env.DATABASE_URL!;
const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

const conn =
  globalForDb.pgConn ??
  postgres(url, {
    // Compatible pgbouncer/Supavisor (Supabase "Transaction pooler") et Postgres local.
    prepare: false,
    max: 10,
    // Supavisor coupe les connexions inactives : on les recycle nous-mêmes,
    // sinon une socket à moitié morte bloque la file d'attente du pool.
    idle_timeout: 20,
    max_lifetime: 60 * 5,
    connect_timeout: 10,
    // Supabase/Neon exigent TLS ; les URI n'incluent pas toujours sslmode=require.
    ...(isLocal ? {} : { ssl: "require" as const }),
  });
// Cache global AUSSI en production : en dev il évite les fuites de connexions
// au rechargement à chaud, en production il garantit UN seul client (donc un
// seul pool, une seule poignée de main TLS) partagé par tous les bundles d'une
// même instance. Ouvrir une connexion coûte plus d'une seconde — la réutiliser
// est ce qui compte le plus.
globalForDb.pgConn = conn;

export const db = drizzle(conn, { schema });
export * as tables from "./schema";
export * as tablesSms from "./schema-sms";
