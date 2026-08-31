import { and, eq, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { OUTCOME_REASONS } from "@/components/conversations/state";
import { conversations } from "@/db/schema-sms";

/**
 * « Un humain doit reprendre ce fil » — la règle, écrite UNE fois, en SQL.
 *
 * `needsAttention` seul ne suffit pas : le moteur laisse la colonne à vrai en
 * CLOSANT un fil (il s'en sert pour dater le verdict — voir
 * `conversationStateOf`, où le motif l'emporte sur la pastille). Compter la
 * colonne nue mettait donc les désabonnements, les refus et les objectifs
 * atteints dans « à reprendre » : le tableau de bord annonçait cinq fils là où
 * la boîte de réception en montrait trois, et « reprendre » un désabonnement
 * est exactement ce qu'il ne faut jamais faire.
 *
 * Deux écrans posent cette question (le tableau de bord et, côté affichage, la
 * boîte de réception) : ils la posent maintenant avec les mêmes mots.
 */
export function needsHumanCondition(): SQL {
  return and(eq(conversations.needsAttention, true), noVerdictCondition())!;
}

/**
 * « Aucun verdict n'a encore été rendu sur ce fil. »
 *
 * Le miroir SQL du premier test de `conversationStateOf` : un motif de la
 * famille VERDICT (refus, désabonnement, fil clos) l'emporte sur tout le reste.
 * Deux gardes en dépendent — « à reprendre » ci-dessus, et « entre vos mains »
 * dans les actions du fil.
 */
export function noVerdictCondition(): SQL {
  // `not in` vaut NULL quand la colonne est NULL, et une condition NULLE écarte
  // la rangée : sans ce `or`, un fil sans motif disparaîtrait des deux gardes.
  return or(
    isNull(conversations.attentionReason),
    notInArray(conversations.attentionReason, [...OUTCOME_REASONS]),
  )!;
}
