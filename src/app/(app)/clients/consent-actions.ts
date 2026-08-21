"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { consents } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import { getSetting } from "@/lib/settings";
import { consentExpiresAt } from "@/lib/sms/consent";
import { CONSENT_SOURCES, type ConsentSource } from "@/lib/sms/consent-sources";

/**
 * Consentement SMS enregistré À LA MAIN — par un téléphoniste qui l'a obtenu
 * au téléphone ou en personne, ou par un administrateur.
 *
 * Jusqu'ici le registre ne se remplissait que par le webhook de leads : un
 * client appelé, d'accord pour recevoir des textos, restait « sans
 * consentement » et aucune campagne ne pouvait lui écrire. Le téléphoniste
 * est précisément la personne qui recueille ce oui ; l'action lui est ouverte.
 *
 * Le registre reste append-only : révoquer pose une date, n'efface rien.
 */

const grantSchema = z.object({
  clientId: z.uuid(),
  kind: z.enum(["express", "implied_inquiry"]),
  source: z.enum(CONSENT_SOURCES),
  note: z.string().trim().max(300).default(""),
});

type ConsentActionResult =
  | { ok: true }
  | { ok: false; error: "invalid" | "forbidden" | "notFound" };

export async function grantSmsConsentAction(input: {
  clientId: string;
  kind: "express" | "implied_inquiry";
  source: ConsentSource;
  note?: string;
}): Promise<ConsentActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "forbidden" };
  const parsed = grantSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const client = await db.query.clients.findFirst({
    where: eq(clients.id, parsed.data.clientId),
    columns: { id: true },
  });
  if (!client) return { ok: false, error: "notFound" };

  const now = new Date();
  const settings = await getSetting("sms");
  await db.insert(consents).values({
    clientId: client.id,
    channel: "sms",
    kind: parsed.data.kind,
    source: `manual:${parsed.data.source}`,
    evidence: {
      recordedById: user.id,
      recordedByName: user.name,
      note: parsed.data.note,
      recordedAt: now.toISOString(),
    },
    grantedAt: now,
    // Même politique de durée que le webhook : c'est le réglage SMS qui décide.
    expiresAt: consentExpiresAt(settings.consentValidity, now),
  });
  await logAudit({
    userId: user.id,
    action: "consent.grant",
    entity: "client",
    entityId: client.id,
    detail: { channel: "sms", kind: parsed.data.kind, source: parsed.data.source },
  });
  revalidatePath(`/clients/${client.id}`);
  return { ok: true };
}

export async function revokeSmsConsentAction(clientId: string): Promise<ConsentActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "forbidden" };
  if (!z.uuid().safeParse(clientId).success) return { ok: false, error: "invalid" };
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { id: true },
  });
  if (!client) return { ok: false, error: "notFound" };

  const now = new Date();
  await db
    .update(consents)
    .set({ revokedAt: now })
    .where(and(eq(consents.clientId, clientId), eq(consents.channel, "sms"), isNull(consents.revokedAt)));
  await logAudit({
    userId: user.id,
    action: "consent.revoke",
    entity: "client",
    entityId: clientId,
    detail: { channel: "sms" },
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
