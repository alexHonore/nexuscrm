import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schemaCrm from "./schema";
import * as schemaSms from "./schema-sms";
import * as schemaPush from "./schema-push";
import * as schemaLibrary from "./schema-library";

const schema = { ...schemaCrm, ...schemaSms, ...schemaPush, ...schemaLibrary };

const globalForDb = globalThis as unknown as { pgConn?: ReturnType<typeof postgres> };

const url = process.env.DATABASE_URL!;
const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

const poolOptions = {
  // Compatible pgbouncer/Supavisor (Supabase "Transaction pooler") et Postgres local.
  prepare: false,
  // ⚠ Le pool est la seule chose qui empêche la corruption des paramètres.
  // Quand toutes les connexions sont prises, postgres.js n'attend PAS : il
  // écrit la requête sur une connexion déjà active (`handler` →
  // `go(busy.shift(), query)`) et jusqu'à 100 requêtes s'empilent sur la même
  // socket. Or Supavisor en mode TRANSACTION réaffecte son backend à chaque
  // `Sync` : les groupes Parse/Bind/Execute partent mêlés vers des backends
  // différents, et un Bind atterrit sur le Parse d'une AUTRE requête. Vu en
  // production — un `count(*) … where assigned_to_id = $1` recevant « f » (le
  // booléen d'une autre requête), un `in (…)` d'uuid recevant des entiers,
  // « unnamed prepared statement does not exist » malgré `prepare: false`, et
  // des rangées livrées à la mauvaise promesse (`toISOString` de undefined).
  // Ne PAS « corriger » ça avec `max_pipeline` : à 0 comme à 1, une requête
  // émise sur une connexion déjà pleine repart dans la file GLOBALE du pilote,
  // y compris à l'intérieur d'une transaction — ce qui casse le
  // `FOR UPDATE SKIP LOCKED` de la file de jobs (mesuré : 31 tests rouges).
  // Le seul levier sûr est de ne jamais épuiser le pool.
  // Une instance Fluid multiplexe plusieurs requêtes HTTP dans le MÊME
  // processus, donc dans ce seul pool : une ouverture de fiche en demande
  // plus de dix à elle seule. Sous-dimensionner ne ralentit pas, ça déborde.
  max: 30,
  // Supavisor coupe les connexions inactives : on les recycle nous-mêmes,
  // sinon une socket à moitié morte bloque la file d'attente du pool.
  idle_timeout: 20,
  max_lifetime: 60 * 5,
  connect_timeout: 10,
  // Supabase/Neon exigent TLS ; les URI n'incluent pas toujours sslmode=require.
  ...(isLocal ? {} : { ssl: "require" as const }),
};

const conn = globalForDb.pgConn ?? postgres(url, poolOptions);
// Cache global AUSSI en production : en dev il évite les fuites de connexions
// au rechargement à chaud, en production il garantit UN seul client (donc un
// seul pool, une seule poignée de main TLS) partagé par tous les bundles d'une
// même instance. Ouvrir une connexion coûte plus d'une seconde — la réutiliser
// est ce qui compte le plus.
globalForDb.pgConn = conn;

export const db = drizzle(conn, { schema });
export * as tables from "./schema";
export * as tablesSms from "./schema-sms";
export * as tablesPush from "./schema-push";
export * as tablesLibrary from "./schema-library";
