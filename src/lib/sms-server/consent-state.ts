import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { consents } from "@/db/schema-sms";
import type { SmsConsentState } from "@/lib/sms/consent-sources";

/** Le consentement SMS courant d'un client — lecture seule. */
export async function readSmsConsent(clientId: string, now = new Date()): Promise<SmsConsentState> {
  const row = await db.query.consents.findFirst({
    where: and(eq(consents.clientId, clientId), eq(consents.channel, "sms"), isNull(consents.revokedAt)),
    orderBy: [desc(consents.grantedAt)],
  });
  if (!row) return { status: "none", kind: null, source: null, grantedAt: null, expiresAt: null };
  const expired = row.expiresAt !== null && row.expiresAt <= now;
  return {
    status: expired ? "expired" : "valid",
    kind: row.kind,
    source: row.source,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}
