/* eslint-disable no-console */
/**
 * Seed initial — usage : pnpm db:seed
 * Idempotent : ne recrée pas ce qui existe déjà.
 */
import { config } from "dotenv";
config({ path: ".env" });

import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";

async function main() {
  const { db } = await import("@/db");
  const { categories, sources, users, webhookKeys, settings } = await import("@/db/schema");
  const { hashPassword } = await import("@/lib/auth/password");
  const { encryptSecret, sha256Hex } = await import("@/lib/crypto");

  // ── Catégories système (pipeline) ──
  const systemCategories = [
    { key: "new", nameFr: "Non contacté", nameEn: "Not contacted", color: "#8b5cf6", sortOrder: 0 },
    { key: "voicemail", nameFr: "Boîte vocale", nameEn: "Voicemail", color: "#3b82f6", sortOrder: 1 },
    { key: "callback", nameFr: "À rappeler", nameEn: "Callback", color: "#f59e0b", sortOrder: 2 },
    { key: "booked", nameFr: "Rendez-vous", nameEn: "Booked", color: "#16a34a", sortOrder: 3 },
    { key: "not_interested", nameFr: "Pas intéressé", nameEn: "Not interested", color: "#ef4444", sortOrder: 4 },
    { key: "not_qualified", nameFr: "Non qualifié", nameEn: "Not qualified", color: "#6b7280", sortOrder: 5 },
    { key: "dncl", nameFr: "Ne pas appeler (LNNTE)", nameEn: "Do not call (DNCL)", color: "#1e293b", sortOrder: 6 },
  ];
  for (const cat of systemCategories) {
    await db
      .insert(categories)
      .values({ ...cat, isSystem: true })
      .onConflictDoNothing({ target: categories.key });
  }
  console.log("✓ Catégories système");

  // ── Sources ──
  for (const name of ["Facebook Acheteur", "Facebook Vendeur", "Référence", "Import", "Site web", "Autre"]) {
    await db.insert(sources).values({ name }).onConflictDoNothing({ target: sources.name });
  }
  console.log("✓ Sources");

  // ── Compte admin ──
  const adminEmail = "nsh.alexhonore@gmail.com";
  const existing = await db.query.users.findFirst({ where: eq(users.email, adminEmail) });
  if (!existing) {
    const tempPassword = randomBytes(9).toString("base64url");
    await db.insert(users).values({
      name: "Alex-Honoré Nshimiyimana",
      email: adminEmail,
      passwordHash: await hashPassword(tempPassword),
      role: "admin",
      locale: "fr",
    });
    console.log("✓ Compte admin créé");
    console.log("──────────────────────────────────────────────");
    console.log(`  Courriel      : ${adminEmail}`);
    console.log(`  Mot de passe  : ${tempPassword}`);
    console.log("  (changez-le après la première connexion)");
    console.log("──────────────────────────────────────────────");
  } else {
    console.log("• Compte admin déjà présent");
  }

  // ── Clé webhook (n8n / Facebook) ──
  const seedKey = process.env.WEBHOOK_SEED_KEY;
  if (seedKey) {
    const keyHash = sha256Hex(seedKey);
    const already = await db.query.webhookKeys.findFirst({ where: eq(webhookKeys.keyHash, keyHash) });
    if (!already) {
      await db.insert(webhookKeys).values({
        name: "n8n / Facebook Lead Ads",
        keyEnc: encryptSecret(seedKey),
        keyHash,
        keyLast4: seedKey.slice(-4),
      });
      console.log("✓ Clé webhook seed");
    }
  }

  // ── Réglages par défaut ──
  const defaults: Record<string, unknown> = {
    booking: {
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: "06:00",
      endHour: "23:00",
      meetDurationMin: 30,
      inPersonDurationMin: 60,
      bufferMin: 15,
      timezone: "America/Toronto",
      inPersonDefaultLocation: "",
    },
    telephony: { provider: "voipms" },
  };
  for (const [key, value] of Object.entries(defaults)) {
    await db.insert(settings).values({ key, value }).onConflictDoNothing({ target: settings.key });
  }
  console.log("✓ Réglages par défaut");

  console.log("Seed terminé.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
