import type { CampaignConfig } from "./schema";

/**
 * Peut-on inscrire cette personne, et peut-on lui envoyer ce barreau?
 *
 * Module PUR : il reçoit des faits déjà rassemblés et rend une décision. Rien
 * ici ne lit la base — ce qui permet d'écrire noir sur blanc, et de tester, la
 * seule chose qui compte vraiment dans une campagne SMS : **pourquoi on ne
 * devrait PAS écrire à quelqu'un.**
 *
 * Chaque refus porte un motif distinct. Regrouper « numéro supprimé » et
 * « ne pas appeler » sous un « inéligible » unique rendrait impossible de
 * répondre à la question qu'on se posera forcément un jour : cette campagne
 * convertit-elle mal, ou n'a-t-elle jamais eu le droit de partir?
 *
 * PAS de condition de consentement (décision de l'exploitant, 2026-08-22) :
 * toute fiche entrée dans ce CRM a été vérifiée comme joignable, et le registre
 * de consentement n'ajoutait qu'un refus de plus à diagnostiquer. Ce qui reste,
 * et qui compte : un REFUS EXPRIMÉ — désabonnement (« suppressed ») et « ne pas
 * appeler » — passe toujours avant tout le reste.
 */

/**
 * La campagne vise-t-elle ENCORE un client rangé dans cette catégorie?
 *
 * Deux conditions d'une campagne portent sur `clients.categoryId`, et ce sont
 * exactement celles que `audienceConditions` et `triggerConditions` traduisent
 * en SQL au moment d'inscrire :
 *
 *  · `audience.categoryIds` — la population visée ;
 *  · `trigger.toCategoryIds` — les catégories d'ARRIVÉE du déclencheur
 *    « changement de catégorie ».
 *
 * Vide des deux côtés = aucune restriction : la campagne suit la personne où
 * qu'elle aille, et un changement de catégorie ne la remet pas en cause.
 *
 * **Pourquoi une copie pure plutôt que de rejouer `audienceWhere`?** Parce que
 * cette requête-là est écrite pour trouver des gens à INSCRIRE : elle exclut
 * quiconque est déjà inscrit à la campagne examinée, et — quand
 * `excludeActiveInOtherCampaign` est levé, ce qui est le défaut — quiconque est
 * en vol quelque part, c'est-à-dire précisément le client dont on examine
 * l'inscription. La rejouer sur un inscrit répondrait TOUJOURS « plus dans
 * l'audience » et viderait toutes les campagnes au premier changement de
 * catégorie.
 *
 * **Pourquoi la catégorie SEULE, et pas le reste de l'audience?** Parce que les
 * autres conditions dérivent toutes seules avec le temps (`createdWithinDays`,
 * `createdBeforeDays`, `notContactedForDays`). Les rejouer ici ferait expulser,
 * au hasard d'un changement de catégorie sans rapport, des gens qu'aucune règle
 * n'a cessé de viser — et le même client serait gardé ou expulsé selon que
 * quelqu'un a touché ou non à sa catégorie ce jour-là.
 */
export function targetsCategory(
  config: Pick<CampaignConfig, "audience" | "trigger">,
  categoryId: number | null,
): boolean {
  // Une fiche SANS catégorie ne « rentre » dans aucune liste choisie : elle ne
  // satisfait une condition de catégorie que si celle-ci est vide.
  const wanted = (ids: number[]): boolean =>
    ids.length === 0 || (categoryId !== null && ids.includes(categoryId));

  return (
    wanted(config.audience.categoryIds) &&
    (config.trigger.kind !== "category_changed" || wanted(config.trigger.toCategoryIds))
  );
}

export const ENROLL_REFUSALS = [
  "campaign_not_active",
  "outside_window",
  "no_phone",
  "suppressed",
  "do_not_call",
  "already_enrolled",
  /** Un fil SMS est en cours avec cette personne : on ne l'ouvre pas à froid. */
  "live_conversation",
  "active_elsewhere",
  "daily_cap_reached",
  "total_cap_reached",
  "empty_ladder",
] as const;
export type EnrollRefusal = (typeof ENROLL_REFUSALS)[number];

/**
 * Fenêtre pendant laquelle un fil est considéré VIVANT après un message entrant.
 *
 * Une personne qui a écrit au numéro il y a trois jours est en conversation —
 * l'assistant ou un humain lui répond. Lui envoyer l'ouverture froide d'une
 * campagne par-dessus, c'est faire parler deux voix à la même personne :
 * exactement ce que la règle « réponse = fin de l'échelle » sert à éviter,
 * sauf qu'ici la réponse est arrivée AVANT le premier barreau. Au-delà de la
 * fenêtre, le fil est dormant et une réactivation a de nouveau sa place.
 */
export const LIVE_CONVERSATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Fenêtre d'attribution d'une réponse APRÈS la fin de l'échelle.
 *
 * Le dernier barreau clôt l'inscription sur-le-champ (« completed ») ; la
 * personne qui répond deux heures plus tard répond pourtant bien à ce barreau,
 * et c'est précisément ce qu'un test A/B mesure. On lui attribue la réponse
 * tant qu'elle arrive dans cette fenêtre après le dernier envoi ; au-delà, le
 * lien est trop ténu pour créditer une variante.
 */
export const REPLY_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface EnrollFacts {
  /** État de la campagne au moment de la décision. */
  status: string;
  now: Date;
  hasPhone: boolean;
  suppressed: boolean;
  doNotCall: boolean;
  alreadyEnrolled: boolean;
  /** Un message entrant récent sur un fil de ce numéro (LIVE_CONVERSATION_WINDOW_MS). */
  liveConversation: boolean;
  activeInOtherCampaign: boolean;
  enrolledTodayCount: number;
  enrolledTotalCount: number;
}

export type EnrollDecision =
  | { allowed: true }
  | { allowed: false; refusal: EnrollRefusal };

export function canEnroll(config: CampaignConfig, facts: EnrollFacts): EnrollDecision {
  const deny = (refusal: EnrollRefusal): EnrollDecision => ({ allowed: false, refusal });

  if (facts.status !== "active") return deny("campaign_not_active");

  if (config.startsAt !== null && facts.now < config.startsAt) return deny("outside_window");
  if (config.endsAt !== null && facts.now >= config.endsAt) return deny("outside_window");

  // Une échelle vide inscrirait des gens pour ne jamais leur écrire : la
  // campagne paraîtrait vivante et ne ferait rien.
  if (config.ladder.length === 0) return deny("empty_ladder");

  if (!facts.hasPhone) return deny("no_phone");

  // L'ordre suit la gravité : un numéro désabonné est un refus exprimé, il
  // passe AVANT toute considération de capacité ou de doublon.
  if (facts.suppressed) return deny("suppressed");
  if (config.audience.excludeDoNotCall && facts.doNotCall) return deny("do_not_call");

  if (facts.alreadyEnrolled) return deny("already_enrolled");
  // Une conversation en cours n'est pas une audience à ouvrir : l'ouverture
  // froide arriverait au milieu d'un échange que quelqu'un mène déjà.
  if (facts.liveConversation) return deny("live_conversation");
  if (config.audience.excludeActiveInOtherCampaign && facts.activeInOtherCampaign) {
    return deny("active_elsewhere");
  }

  if (
    config.totalEnrollmentCap !== null &&
    facts.enrolledTotalCount >= config.totalEnrollmentCap
  ) {
    return deny("total_cap_reached");
  }
  if (facts.enrolledTodayCount >= config.dailyEnrollmentCap) return deny("daily_cap_reached");

  return { allowed: true };
}

// ── Envoi d'un barreau ───────────────────────────────────────────────────────

export const TOUCH_REFUSALS = [
  /** Interrupteur d'arrêt global levé — on attend, on n'avance pas l'échelle. */
  "kill_switch",
  "campaign_not_active",
  "enrollment_ended",
  "suppressed",
  /** `clients.doNotCall` posé APRÈS l'inscription (disposition d'après-appel). */
  "do_not_call",
  "ai_paused",
  "ladder_exhausted",
  "already_sent",
  "replied",
  /** Un fil vivant existait déjà avant le premier barreau. */
  "live_conversation",
  /** La fiche a changé de catégorie : la campagne ne la vise plus. */
  "left_audience",
  /** Aucun numéro expéditeur actif : panne de configuration, pas une décision. */
  "no_sender",
  /** Hors heures de politesse — le barreau attend l'ouverture de la fenêtre. */
  "quiet_hours",
  /** Pas encore l'heure — un rejeu ne doit pas avancer l'échelle. */
  "not_due",
] as const;
export type TouchRefusal = (typeof TOUCH_REFUSALS)[number];

export interface TouchFacts {
  campaignStatus: string;
  enrollmentStatus: string;
  /** Interrupteur d'arrêt global (`sms.killSwitch`). */
  killSwitch: boolean;
  suppressed: boolean;
  /** `clients.doNotCall` au moment du barreau, pas à l'inscription. */
  doNotCall: boolean;
  /** `audience.excludeDoNotCall` de la campagne. */
  excludeDoNotCall: boolean;
  /** conversations.aiEnabled — un humain a repris la main. */
  aiEnabled: boolean;
  ladderLength: number;
  step: number;
  /** Ce barreau a déjà une trace d'envoi. */
  alreadySent: boolean;
  /** Le client a répondu depuis le dernier barreau. */
  repliedSince: boolean;
  /** Rien n'est encore parti, mais un fil vivant existe déjà (message entrant récent). */
  liveConversation: boolean;
  /**
   * La campagne vise-t-elle encore la catégorie ACTUELLE de la fiche
   * (`targetsCategory`) ? Relu à chaque barreau, et pas seulement au moment du
   * changement de catégorie : `clients.category_id` porte `on delete set null`,
   * donc la base elle-même peut vider une catégorie sans qu'aucune ligne de
   * code applicatif ne s'exécute. C'est aussi ce qui rattrape les inscriptions
   * déjà périmées avant que ce garde-fou n'existe.
   */
  stillTargeted: boolean;
  /** Un numéro expéditeur actif est disponible. */
  hasSender: boolean;
  /** L'instant courant tombe dans la fenêtre d'envoi (heures de politesse). */
  withinSendWindow: boolean;
}

export type TouchDecision = { allowed: true } | { allowed: false; refusal: TouchRefusal };

/**
 * Les conditions sont RE-VÉRIFIÉES à chaque barreau, jamais seulement à
 * l'inscription. Une échelle de trois semaines peut très bien atteindre son
 * dernier barreau après un désabonnement : la décision d'inscrire ne vaut pas
 * autorisation permanente d'écrire.
 *
 * L'ordre compte : les « non » définitifs (désabonnement, ne pas appeler,
 * réponse) passent AVANT les « pas maintenant » (interrupteur, numéro manquant,
 * heures de politesse). Sinon une personne désabonnée verrait son inscription
 * simplement repoussée au lendemain matin au lieu d'être close.
 */
export function canSendTouch(facts: TouchFacts): TouchDecision {
  const deny = (refusal: TouchRefusal): TouchDecision => ({ allowed: false, refusal });

  if (facts.suppressed) return deny("suppressed");
  if (facts.excludeDoNotCall && facts.doNotCall) return deny("do_not_call");
  if (facts.campaignStatus !== "active") return deny("campaign_not_active");

  if (facts.enrollmentStatus !== "pending" && facts.enrollmentStatus !== "active") {
    return deny("enrollment_ended");
  }
  // Une réponse rend la main à l'assistant : continuer l'échelle par-dessus une
  // conversation en cours ferait parler deux voix à la même personne.
  if (facts.repliedSince) return deny("replied");
  if (facts.liveConversation) return deny("live_conversation");
  // APRÈS « a répondu » : quand les deux sont vrais, c'est la réponse qui
  // compte pour le bilan d'un test A/B — la classer « sortie d'audience »
  // effacerait la conversion qu'on cherchait justement à mesurer.
  if (!facts.stillTargeted) return deny("left_audience");
  if (!facts.aiEnabled) return deny("ai_paused");
  if (facts.step >= facts.ladderLength) return deny("ladder_exhausted");
  if (facts.alreadySent) return deny("already_sent");

  // « Pas maintenant » — rien n'est décidé sur la personne, on attend.
  if (facts.killSwitch) return deny("kill_switch");
  if (!facts.hasSender) return deny("no_sender");
  if (!facts.withinSendWindow) return deny("quiet_hours");

  return { allowed: true };
}
