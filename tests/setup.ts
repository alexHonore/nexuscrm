/**
 * Configuration commune des tests.
 *
 * Les tests d'intégration tapent sur une base Postgres LOCALE dédiée
 * (nexus_test) — jamais sur Supabase/production.
 */
import { config } from "dotenv";

config({ path: ".env.test", override: true });

// Plusieurs exécutions de la suite en parallèle (agents, CI matricielle) :
// chacune peut désigner SA base — toujours une base nexus_test* (garde ci-dessous).
if (process.env.NEXUS_TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.NEXUS_TEST_DATABASE_URL;
}

process.env.DATABASE_URL ??= "postgres://nexus:nexus@localhost:5455/nexus_test";
process.env.AUTH_SECRET ??= "dGVzdC1zZWNyZXQtMzItYnl0ZXMtbG9uZy1mb3ItaG1hYyEh";
process.env.APP_ENCRYPTION_KEY ??= "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret";

if (!process.env.DATABASE_URL.includes("nexus_test")) {
  throw new Error(
    `Refus de lancer les tests : DATABASE_URL ne pointe pas sur nexus_test (${process.env.DATABASE_URL})`,
  );
}
