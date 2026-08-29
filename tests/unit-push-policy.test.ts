/**
 * Unitaire — ce qui a le droit de faire vibrer un téléphone.
 *
 * Ce que ces tests protègent tient en deux phrases opposées. D'un côté : un
 * type de notification ajouté au produit sans décision de poussée serait
 * silencieusement MUET sur les téléphones, et personne ne remarque ce qui n'a
 * pas sonné. De l'autre : une application qui vibre à 3 h du matin pour un
 * rappel de suivi se fait couper — pas la notification, l'application entière,
 * dans les réglages du système, définitivement. Les deux pannes se rattrapent
 * mal et aucune ne lève d'exception.
 *
 * Le reste du fichier est de la mécanique dont l'échec est invisible : une
 * fenêtre de nuit qui enjambe minuit (c'est la SEULE forme qu'une nuit puisse
 * prendre), une étiquette de fusion qui doit rassembler cinq textos d'un même
 * client en UNE ligne, et un `Topic` RFC 8030 qui doit tenir dans 32
 * caractères sans que deux fiches s'écrasent l'une l'autre.
 *
 * Module PUR : aucune base, aucune requête, aucune horloge — les minutes sont
 * données, jamais lues.
 */
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TYPES,
  collapseTag,
  isKnownNotificationType,
  isWithinQuietHours,
  parseHhMm,
  pushRule,
  shouldPush,
  topicOf,
  type ReachPrefs,
} from "@/lib/push/policy";

/** Minutes écoulées depuis minuit — la seule unité que la politique connaît. */
const at = (hhmm: string): number => {
  const m = parseHhMm(hhmm);
  if (m === null) throw new Error(`heure de test invalide : ${hhmm}`);
  return m;
};

/** La nuit d'un téléphoniste : 22 h → 7 h. Elle enjambe minuit, forcément. */
const NIGHT = { quietFrom: "22:00", quietTo: "07:00" };

const prefs = (overrides: Partial<ReachPrefs> = {}): ReachPrefs => ({
  pushPrefs: null,
  quietFrom: null,
  quietTo: null,
  quietBypassUrgent: true,
  ...overrides,
});

const uuid = (n: number): string =>
  `0000${n.toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36);

// ═══════════════════════════════════════════════════════════════════════════
// La liste est FERMÉE : aucun type ne tombe dans le repli
// ═══════════════════════════════════════════════════════════════════════════

describe("couverture des types", () => {
  it("chacun des treize types a SA règle, aucun ne retombe sur l'inconnu", () => {
    // C'est le test qui empêche un quatorzième type d'être muet. Le typage
    // l'attraperait à la compilation, mais la suite ne type-vérifie pas : un
    // `Record` incomplet passe le transpileur sans un mot, et la seule trace
    // de l'oubli serait un téléphone qui ne sonne pas.
    const fallback = pushRule("un_type_qui_n_existe_pas");
    const orphans = NOTIFICATION_TYPES.filter((t) => pushRule(t) === fallback);
    expect(orphans, `types sans règle explicite : ${orphans.join(", ")}`).toEqual([]);
  });

  it("chaque règle est complète — pas de champ oublié à moitié écrit", () => {
    for (const type of NOTIFICATION_TYPES) {
      const rule = pushRule(type);
      expect(typeof rule.push, type).toBe("boolean");
      expect(typeof rule.urgent, type).toBe("boolean");
      expect(["very-low", "low", "normal", "high"], type).toContain(rule.urgency);
      expect(["client", "type", "none"], type).toContain(rule.collapse);
      expect(rule.ttl, type).toBeGreaterThanOrEqual(0);
    }
  });

  it("un type inconnu prévient quand même — le repli n'est pas le silence", () => {
    // Une notification écrite par un producteur plus récent que cette liste
    // doit arriver. Se taire par prudence, c'est perdre l'événement.
    expect(isKnownNotificationType("mention")).toBe(true);
    expect(isKnownNotificationType("un_type_qui_n_existe_pas")).toBe(false);
    expect(pushRule("un_type_qui_n_existe_pas").push).toBe(true);
    expect(pushRule("un_type_qui_n_existe_pas").urgent).toBe(false);
  });

  it("seuls les types qui n'appellent AUCUNE action sont muets par défaut", () => {
    // `system` s'adresse à quelqu'un devant un écran, `sms_closed` annonce que
    // tout s'est bien passé. Tout le reste demande quelque chose à quelqu'un.
    const mute = NOTIFICATION_TYPES.filter((t) => !pushRule(t).push);
    expect(mute.sort()).toEqual(["sms_closed", "system"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// shouldPush — le silence se demande, jamais le bruit
// ═══════════════════════════════════════════════════════════════════════════

describe("shouldPush", () => {
  it("un type muet par nature ne part JAMAIS, même réclamé", () => {
    expect(shouldPush("system", null, at("10:00"))).toEqual({ push: false, reason: "type_off" });
    // Et la préférence de l'utilisateur ne le ressuscite pas : ce n'est pas un
    // réglage, c'est la nature de l'événement.
    const eager = prefs({ pushPrefs: { system: true, sms_closed: true } });
    expect(shouldPush("system", eager, at("10:00")).push).toBe(false);
    expect(shouldPush("sms_closed", eager, at("10:00")).push).toBe(false);
  });

  it("un « non » explicite de la personne suffit à faire taire un type", () => {
    const quiet = prefs({ pushPrefs: { followup_due: false } });
    expect(shouldPush("followup_due", quiet, at("10:00"))).toEqual({
      push: false,
      reason: "user_off",
    });
    // …et ne touche pas les autres types.
    expect(shouldPush("missed_call", quiet, at("10:00")).push).toBe(true);
  });

  it("une préférence ABSENTE vaut oui — c'est le silence qui se demande", () => {
    // Le défaut inverse produit une application installée qui ne fait rien, et
    // qu'on croit cassée. Personne ne va chercher l'écran des réglages pour
    // ALLUMER ce qu'il vient d'installer.
    expect(shouldPush("missed_call", null, at("10:00"))).toEqual({ push: true, reason: "ok" });
    expect(shouldPush("missed_call", prefs(), at("10:00")).push).toBe(true);
    expect(shouldPush("missed_call", prefs({ pushPrefs: {} }), at("10:00")).push).toBe(true);
    // Un réglage écrit pour un AUTRE type ne rend pas celui-ci silencieux.
    expect(shouldPush("mention", prefs({ pushPrefs: { followup_due: false } }), at("10:00")).push)
      .toBe(true);
    // Et un « oui » explicite reste un oui.
    expect(shouldPush("mention", prefs({ pushPrefs: { mention: true } }), at("10:00")).push)
      .toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Les heures de silence — une nuit enjambe minuit, c'est le cas NORMAL
// ═══════════════════════════════════════════════════════════════════════════

describe("heures de silence", () => {
  it("22:00 → 07:00 contient 23:30 et 03:00, et laisse midi dehors", () => {
    // L'erreur classique est d'écrire `minutes >= start && minutes < end` et de
    // n'y voir que du feu : la fenêtre devient vide, plus personne n'est jamais
    // protégé, et le bogue ne se manifeste qu'à 3 h du matin.
    expect(isWithinQuietHours(at("23:30"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(true);
    expect(isWithinQuietHours(at("03:00"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(true);
    expect(isWithinQuietHours(at("12:00"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(false);
  });

  it("les bornes : le début est dedans, la fin est dehors", () => {
    // Sans quoi 07:00 pile serait encore la nuit, et le premier appel manqué
    // de la journée n'arriverait pas.
    expect(isWithinQuietHours(at("22:00"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(true);
    expect(isWithinQuietHours(at("21:59"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(false);
    expect(isWithinQuietHours(at("06:59"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(true);
    expect(isWithinQuietHours(at("07:00"), NIGHT.quietFrom, NIGHT.quietTo)).toBe(false);
  });

  it("une fenêtre qui n'enjambe pas minuit fonctionne aussi", () => {
    // Quelqu'un peut vouloir le silence pendant sa sieste ou sa messe.
    expect(isWithinQuietHours(at("13:30"), "13:00", "15:00")).toBe(true);
    expect(isWithinQuietHours(at("23:30"), "13:00", "15:00")).toBe(false);
  });

  it("pas de fenêtre, ou une fenêtre vide, ne fait taire personne", () => {
    expect(isWithinQuietHours(at("03:00"), null, null)).toBe(false);
    expect(isWithinQuietHours(at("03:00"), "22:00", null)).toBe(false);
    expect(isWithinQuietHours(at("03:00"), null, "07:00")).toBe(false);
    // Début = fin : une nuit de zéro minute, pas une nuit de 24 heures. La
    // lecture inverse ferait taire l'application toute la journée.
    expect(isWithinQuietHours(at("03:00"), "22:00", "22:00")).toBe(false);
  });

  it("l'appel manqué traverse la nuit, le rappel de suivi non", () => {
    // C'est la distinction qui justifie l'installation : un client qui appelle
    // à 21 h 30 est précisément ce qu'on ne veut pas manquer ; un rappel de
    // suivi à 6 h 30 est précisément ce qui fait désinstaller l'application.
    const night = prefs({ ...NIGHT, quietBypassUrgent: true });
    expect(shouldPush("missed_call", night, at("23:30"))).toEqual({ push: true, reason: "ok" });
    expect(shouldPush("followup_due", night, at("23:30"))).toEqual({
      push: false,
      reason: "quiet_hours",
    });
  });

  it("qui refuse le passage en force n'est réveillé par RIEN", () => {
    const sealed = prefs({ ...NIGHT, quietBypassUrgent: false });
    expect(shouldPush("missed_call", sealed, at("03:00"))).toEqual({
      push: false,
      reason: "quiet_hours",
    });
    // …et en journée, la même personne reçoit tout normalement.
    expect(shouldPush("missed_call", sealed, at("12:00")).push).toBe(true);
  });

  it("un « non » de la personne l'emporte sur le passage en force", () => {
    // L'urgence traverse la NUIT, pas un refus explicite : sinon un réglage
    // affiché comme éteint continuerait de sonner.
    const night = prefs({ ...NIGHT, pushPrefs: { missed_call: false } });
    expect(shouldPush("missed_call", night, at("23:30")).reason).toBe("user_off");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseHhMm — ce qui vient d'un formulaire, donc n'importe quoi
// ═══════════════════════════════════════════════════════════════════════════

describe("parseHhMm", () => {
  it("lit une heure murale bien formée", () => {
    expect(parseHhMm("00:00")).toBe(0);
    expect(parseHhMm("07:00")).toBe(420);
    expect(parseHhMm("22:00")).toBe(1320);
    expect(parseHhMm("23:59")).toBe(1439);
    expect(parseHhMm(" 22:00 ")).toBe(1320);
  });

  it("refuse tout le reste plutôt que de deviner", () => {
    // Une heure mal lue ne lève rien : elle décale la nuit de quelqu'un et
    // c'est tout. Mieux vaut « pas de fenêtre » qu'une fenêtre inventée.
    for (const bad of ["25:00", "7:00", "", "22:60", "22h00", "abc", "1320"]) {
      expect(parseHhMm(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseHhMm(null)).toBeNull();
    expect(parseHhMm(undefined)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// collapseTag — cinq textos d'un client font UNE ligne
// ═══════════════════════════════════════════════════════════════════════════

describe("collapseTag", () => {
  const linkA = `/clients/${uuid(1)}`;
  const linkB = `/clients/${uuid(2)}`;

  it("deux notifications sur la MÊME fiche partagent leur étiquette", () => {
    // Sans ça, cinq textos d'un même client empilent cinq lignes sur l'écran
    // verrouillé, et le premier réflexe du téléphoniste est de couper les
    // notifications de l'application entière.
    expect(collapseTag("sms_inbound", linkA)).toBe(collapseTag("sms_inbound", linkA));
    // Même par-dessus une ancre : l'étiquette porte la FICHE, pas l'URL.
    expect(collapseTag("sms_inbound", `${linkA}#conversation`)).toBe(collapseTag("sms_inbound", linkA));
    // Et deux types différents sur la même fiche se rassemblent aussi : c'est
    // le client dont on parle, pas la catégorie de l'événement.
    expect(collapseTag("sms_handoff", linkA)).toBe(collapseTag("sms_inbound", linkA));
  });

  it("deux fiches différentes ne se fondent JAMAIS l'une dans l'autre", () => {
    // La panne serait l'inverse de la précédente et bien pire : un texto de
    // Marie remplacerait celui de Jean, et Jean n'aurait jamais existé.
    expect(collapseTag("sms_inbound", linkA)).not.toBe(collapseTag("sms_inbound", linkB));
  });

  it("un type « none » reste seul, il ne rejoint pas le tas de la fiche", () => {
    // `missed_call` et `incoming_lead` sont les deux événements qui rapportent
    // de l'argent : les laisser écraser par un texto arrivé ensuite sur la même
    // fiche les ferait disparaître de l'écran verrouillé sans être lus.
    for (const type of ["missed_call", "incoming_lead"] as const) {
      expect(pushRule(type).collapse).toBe("none");
      expect(collapseTag(type, linkA)).not.toBe(collapseTag("sms_inbound", linkA));
      expect(collapseTag(type, linkA)).not.toContain("client:");
      expect(collapseTag(type, linkA)).not.toBe(collapseTag(type, linkB));
    }
  });

  it("un type « type » se rassemble par CATÉGORIE, toutes fiches confondues", () => {
    // « Des suivis sont dus » est une seule information, quel que soit le
    // nombre de fiches concernées — et l'application les liste déjà.
    expect(pushRule("followup_due").collapse).toBe("type");
    expect(collapseTag("followup_due", linkA)).toBe(collapseTag("followup_due", linkB));
    expect(collapseTag("followup_due", null)).toBe(collapseTag("followup_due", linkA));
  });

  it("un lien qui n'est pas une fiche ne fabrique pas de faux voisinage", () => {
    // Deux notifications « client » sans fiche identifiable retombent sur leur
    // type et leur lien : elles ne doivent pas se rassembler par accident sous
    // une étiquette vide.
    expect(collapseTag("sms_inbound", null)).not.toBe(collapseTag("sms_inbound", "/conversations"));
    expect(collapseTag("sms_inbound", "/clients/pas-un-uuid")).not.toContain("client:");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// topicOf — la contrainte de la RFC 8030
// ═══════════════════════════════════════════════════════════════════════════

describe("topicOf", () => {
  const tags = [
    ...Array.from({ length: 400 }, (_, i) => `client:${uuid(i)}`),
    ...NOTIFICATION_TYPES,
    ...NOTIFICATION_TYPES.flatMap((t) => [
      `${t}:`,
      `${t}:/clients/${uuid(7)}`,
      `${t}:/appointments/${uuid(7)}`,
      `${t}:/notifications`,
    ]),
  ];

  it("l'étiquette réduite tient dans les 32 caractères base64url exigés", () => {
    // Un `Topic` hors format n'est pas rejeté bruyamment : le service de push
    // répond 400 et la notification n'apparaît simplement jamais.
    for (const tag of tags) {
      expect(topicOf(tag), tag).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
  });

  it("deux étiquettes différentes ne se réduisent pas au même sujet", () => {
    // C'est pour ça qu'on empreinte au lieu de tronquer : deux fiches dont les
    // UUID commencent pareil s'écraseraient l'une l'autre AVANT d'arriver sur
    // le téléphone, et la seconde n'existerait pour personne.
    const seen = new Map<string, string>();
    for (const tag of tags) {
      const topic = topicOf(tag);
      const clash = seen.get(topic);
      expect(clash, `collision : « ${tag} » et « ${clash} » → ${topic}`).toBeUndefined();
      seen.set(topic, tag);
    }
  });

  it("la même étiquette donne toujours le même sujet", () => {
    // Sinon la fusion ne fonctionne plus du tout : chaque envoi ouvrirait un
    // sujet neuf et l'écran verrouillé réempilerait les lignes.
    expect(topicOf("client:xyz")).toBe(topicOf("client:xyz"));
  });
});
