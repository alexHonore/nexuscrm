import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assistants } from "@/db/schema-sms";
import { approachSchema } from "@/lib/assistants/schema";
import { DEFAULT_QUIET_HOURS, type QuietHours } from "@/lib/sms/quiet-hours";

/**
 * Fenêtre d'envoi (« heures de travail ») de l'assistant qui écrit — propre à
 * chaque assistant, rangée dans son `approach`.
 *
 * `null`/inconnu → défaut de politesse : un envoi sans assistant identifié (une
 * réponse humaine, un barreau de campagne à texte fixe) reste borné à des
 * heures raisonnables plutôt qu'à aucune. Ne lève jamais.
 */
export async function resolveQuietHours(
  assistantId: string | null | undefined,
): Promise<QuietHours> {
  if (!assistantId) return DEFAULT_QUIET_HOURS;
  const row = await db.query.assistants.findFirst({
    where: eq(assistants.id, assistantId),
    columns: { approach: true },
  });
  if (!row) return DEFAULT_QUIET_HOURS;
  const parsed = approachSchema.safeParse(row.approach);
  return parsed.success ? parsed.data.quietHours : DEFAULT_QUIET_HOURS;
}
