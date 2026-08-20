import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, settings } from "@/db/schema";
import { consents } from "@/db/schema-sms";
import { diffFields, getClientIp, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { getSetting, setSetting, smsSettingsSchema } from "@/lib/settings";
import { CONSENT_VALIDITIES, type ConsentValidity } from "@/lib/sms/consent";
import { readJson } from "../../_helpers";

/**
 * Seule la durée de validité des consentements se règle ici. L'interrupteur
 * d'arrêt (killSwitch) a sa propre route (/api/kill-switch) : on lit l'état
 * courant et on n'écrase QUE consentValidity — une rustine, jamais un reset.
 *
 * Par défaut le registre reste append-only : la durée n'est estampillée que
 * sur les FUTURS consentements. `applyToExisting` recalcule en plus l'échéance
 * des consentements SMS existants NON révoqués, chacun depuis SA date d'octroi
 * (grantedAt n'est jamais réécrit, les révocations jamais touchées). Ce recalcul
 * peut RAVIVER des consentements échus (allongement) ou en PÉRIMER (raccourcis-
 * sement) — `dryRun` renvoie ces décomptes sans rien écrire, pour que le dialogue
 * de confirmation montre l'effet réel avant d'agir.
 */
const patchSchema = z.object({
  consentValidity: z.enum(CONSENT_VALIDITIES),
  applyToExisting: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

/** Littéraux d'intervalle dérivés de l'enum validé — jamais d'entrée libre. */
const INTERVALS: Record<Exclude<ConsentValidity, "unlimited">, string> = {
  "6m": "6 months",
  "1y": "1 year",
  "2y": "2 years",
  "3y": "3 years",
};

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;
  const { consentValidity, applyToExisting, dryRun } = body;

  // Nouvelle échéance recalculée depuis la date d'octroi de CHAQUE rangée.
  const newExpiry =
    consentValidity === "unlimited"
      ? sql`null::timestamptz`
      : sql`${consents.grantedAt} + ${sql.raw(`interval '${INTERVALS[consentValidity]}'`)}`;
  const targetRows = and(eq(consents.channel, "sms"), isNull(consents.revokedAt));

  // updated = échéances qui changent réellement ; revived = échus qui
  // redeviennent valides ; lapsed = valides qui deviennent échus.
  const countsSelection = {
    updated: sql<number>`count(*) filter (where ${consents.expiresAt} is distinct from ${newExpiry})::int`,
    revived: sql<number>`count(*) filter (where ${consents.expiresAt} is not null and ${consents.expiresAt} <= now() and (${newExpiry} is null or ${newExpiry} > now()))::int`,
    lapsed: sql<number>`count(*) filter (where (${consents.expiresAt} is null or ${consents.expiresAt} > now()) and ${newExpiry} is not null and ${newExpiry} <= now())::int`,
  };

  // Aperçu : décomptes seulement, aucune écriture (ni réglage, ni audit).
  if (dryRun) {
    const [preview] = await db.select(countsSelection).from(consents).where(targetRows);
    return NextResponse.json({ preview });
  }

  const current = await getSetting("sms");
  const next = smsSettingsSchema.parse({ ...current, consentValidity });
  const changes = diffFields(current, next, ["consentValidity"]);

  if (!applyToExisting) {
    await setSetting("sms", next);
    await logAudit({
      userId: admin.id,
      action: "settings.sms",
      entity: "settings",
      detail: { consentValidity, ...(changes ? { changes } : {}) },
    });
    return NextResponse.json({ sms: next });
  }

  // Réécriture en masse d'un registre de conformité : le réglage, le recalcul
  // ET les deux traces d'audit committent ensemble ou pas du tout — un recalcul
  // sans trace (ou l'inverse) serait indéfendable. On duplique ici l'upsert de
  // setSetting et l'insert de logAudit exprès : ni l'un ni l'autre n'accepte de
  // transaction. Les décomptes sont lus dans la même transaction juste avant
  // l'UPDATE (dérive concurrente possible en théorie, négligeable à un admin).
  const ip = await getClientIp();
  const backfill = await db.transaction(async (tx) => {
    const [counts] = await tx.select(countsSelection).from(consents).where(targetRows);
    await tx
      .update(consents)
      .set({ expiresAt: newExpiry })
      .where(and(targetRows, sql`${consents.expiresAt} is distinct from ${newExpiry}`));
    await tx
      .insert(settings)
      .values({ key: "sms", value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    await tx.insert(auditLogs).values([
      {
        userId: admin.id,
        action: "settings.sms",
        entity: "settings",
        detail: { consentValidity, ...(changes ? { changes } : {}) },
        ip,
      },
      {
        userId: admin.id,
        action: "consents.expiry_backfill",
        entity: "consents",
        detail: { consentValidity, ...counts },
        ip,
      },
    ]);
    return counts;
  });

  return NextResponse.json({ sms: next, backfill });
}
