import "server-only";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { conversations, messages } from "@/db/schema-sms";
import { MAX_SCAN_ROWS, foldTemplates, type CoarseGroup } from "@/lib/deliverability/dedupe";
import type { DeliverabilityRange, TemplateCluster } from "@/lib/deliverability/types";

/**
 * Regroupement des textes sortants en gabarits — la détection d'essaimage.
 *
 * Le travail se fait en DEUX temps, et c'est la seule raison pour laquelle il
 * tient dans une page :
 *
 *  1. **Postgres plie grossièrement.** Une clé `md5()` sur le corps minusculé,
 *     prénom du destinataire, URLs et chiffres remplacés. Cinq mille messages
 *     qui ne diffèrent que par un prénom deviennent UNE ligne. Sans cette
 *     étape, cinquante mille corps traverseraient le réseau à chaque
 *     chargement de page.
 *  2. **TypeScript plie finement.** Le pliage complet (accents, apostrophes,
 *     dates, montants, pied de page de désabonnement) puis un SimHash sur les
 *     survivants — quelques centaines de lignes, jamais cinquante mille.
 *
 * L'INVARIANT qui rend le raccourci sûr : la clé SQL applique un
 * sous-ensemble STRICT des règles TypeScript. Sa partition est donc plus fine,
 * et le pliage TypeScript ne peut que re-fusionner des représentants — jamais
 * en perdre un. `tests/int-deliverability-templates.test.ts` le vérifie contre
 * la VRAIE requête, parce qu'un invariant démontré à l'oral dérive.
 *
 * Aucune extension : pas d'`unaccent` (le pliage d'accents est en TypeScript),
 * pas de `pg_trgm`. En installer une serait une migration de production.
 */

export interface TemplateScan {
  clusters: TemplateCluster[];
  /** Groupes grossiers réellement lus. */
  scanned: number;
  /** Vrai quand le plafond a coupé : l'écran le dit plutôt que de mentir. */
  truncated: boolean;
}

/**
 * La clé grossière, en SQL. Trois substitutions seulement — chacune est aussi
 * appliquée (plus largement) côté TypeScript, ce qui garantit l'invariant.
 * `split_part(full_name, ' ', 1)` et non un champ « prénom » : la table
 * `clients` n'a qu'un `full_name`.
 */
const coarseKey = sql<string>`md5(
  regexp_replace(
    regexp_replace(
      case when length(split_part(coalesce(${clients.fullName}, ''), ' ', 1)) >= 3
           then replace(lower(${messages.body}),
                        lower(split_part(${clients.fullName}, ' ', 1)), '~p~')
           else lower(${messages.body}) end,
      'https?://[^[:space:]]+|www\\.[^[:space:]]+', '~u~', 'g'),
    '[0-9]+', '~n~', 'g'))`;

export async function scanTemplates(range: DeliverabilityRange): Promise<TemplateScan> {
  const rows = await db
    .select({
      coarseKey,
      // Un corps RÉEL du groupe : l'opérateur doit lire ce que les gens ont
      // reçu, avec un vrai prénom et un vrai lien dedans, pas un gabarit
      // reconstruit qu'il ne reconnaîtrait pas.
      body: sql<string>`min(${messages.body})`,
      firstName: sql<string | null>`min(split_part(coalesce(${clients.fullName}, ''), ' ', 1))`,
      messages: sql<number>`count(*)::int`,
      recipients: sql<number>`count(distinct ${conversations.clientPhone})::int`,
      senders: sql<string>`string_agg(distinct ${conversations.smsNumberId}::text, ',')`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(clients, eq(clients.id, conversations.clientId))
    .where(
      and(
        eq(messages.direction, "out"),
        isNotNull(messages.twilioSid),
        gte(messages.createdAt, range.fromUtc),
        lt(messages.createdAt, range.toUtcExclusive),
      ),
    )
    .groupBy(coarseKey)
    .limit(MAX_SCAN_ROWS + 1);

  const truncated = rows.length > MAX_SCAN_ROWS;
  const kept = truncated ? rows.slice(0, MAX_SCAN_ROWS) : rows;

  const groups: CoarseGroup[] = kept.map((r) => ({
    coarseKey: r.coarseKey,
    body: r.body,
    messages: r.messages,
    distinctRecipients: r.recipients,
    senders: (r.senders ?? "").split(",").filter(Boolean),
    firstName: r.firstName,
  }));

  return { clusters: foldTemplates(groups), scanned: kept.length, truncated };
}
