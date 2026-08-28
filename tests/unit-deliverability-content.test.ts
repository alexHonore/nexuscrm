/**
 * Unitaire — ce qu'un corps de SMS dit de lui-même.
 *
 * `scanBody` est le SEUL module de l'écran de délivrabilité qui accuse un texte
 * écrit par un humain. La régression qu'il faut empêcher n'est donc pas
 * « le détecteur a raté un pourriel » — c'est l'inverse : un détecteur qui
 * signale « offre d'achat », « mandat exclusif » ou « cave à vin » sur les
 * messages quotidiens d'un courtier est ignoré au bout de trois jours, et un
 * détecteur ignoré ne protège plus rien tout en laissant croire que quelqu'un
 * surveille. Le premier bloc de ce fichier est donc le garde-fou du FAUX
 * POSITIF ; les vrais positifs viennent après, un cas chacun, pour qu'un
 * détecteur qui ne se lève plus du tout ne puisse pas passer pour prudent.
 *
 * Les seuils cités ici (0,35 de majuscules, 3 points d'exclamation) sont ceux
 * de `CONTENT_RULES` dans `src/lib/deliverability/assess.ts` : ce fichier mesure
 * des faits, c'est `assess` qui décide. Les recopier ici est délibéré — si l'un
 * bouge, ce test dit tout de suite quels messages RÉELS changent de camp.
 */
import { describe, expect, it } from "vitest";
import { hasOptOutLanguage, isHostileReply, scanBody } from "@/lib/deliverability/content";
import type { ContentFlags } from "@/lib/deliverability/types";

/** Les marques acceptées du courtier — exactement ce que l'écran passe au scan. */
const BRAND = ["Groupe Nexus", "Alex-Honoré"];

const scan = (body: string, brandTokens: readonly string[] = BRAND): ContentFlags =>
  scanBody(body, { brandTokens: [...brandTokens], isOpener: true });

/** Seuils de `CONTENT_RULES` (assess.ts) — au-delà, le message est reproché. */
const CAPS_ALARM = 0.35;
const EXCLAMATION_ALARM = 3;

/** Taux de majuscules SANS aucun effacement — le témoin du calcul indulgent. */
function rawCapsRatio(text: string): number {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return 0;
  return letters.filter((c) => /\p{Lu}/u.test(c)).length / letters.length;
}

/**
 * L'ouverture conforme de référence : marque, vraie question, mention d'arrêt.
 * C'est la phrase que le module lui-même se donne comme condition de survie.
 */
const CLEAN_OPENER =
  "Bonjour Marie, ici Alex-Honoré du Groupe Nexus. Avez-vous encore un projet immobilier à Lévis ? Répondez STOP pour vous désabonner.";

/**
 * Du vrai courrier de courtier québécois. Chacun contient un mot qui aurait
 * allumé l'écran si les listes avaient été écrites sans réfléchir : « offre »
 * (d'achat), « exclusif » (mandat), « hypothèque », « cash », « vin »,
 * « garantie ».
 */
const REAL_BROKER_MESSAGES: readonly { label: string; body: string }[] = [
  { label: "ouverture conforme", body: CLEAN_OPENER },
  {
    label: "offre d'achat",
    body: "Nous avons reçu une offre d'achat sur votre propriété; je vous appelle cet après-midi.",
  },
  {
    label: "mandat exclusif",
    body: "Votre mandat exclusif vient à échéance le 15 septembre, on en reparle ?",
  },
  {
    label: "hypothèque dans une phrase ordinaire",
    body: "Le taux d'hypothèque a baissé et un acheteur cash veut visiter cette semaine.",
  },
  {
    label: "confirmation de rendez-vous",
    body: "Bonjour, je confirme notre rendez-vous demain 14 h au 123 rue Principale à Lévis.",
  },
  {
    label: "cave à vin dans une fiche descriptive",
    body: "Sous-sol fini, cave à vin et foyer au bois : la visite libre est dimanche.",
  },
  {
    label: "garantie légale",
    body: "La garantie légale de qualité s'applique à cette vente, je vous explique tout.",
  },
];

// ── Le faux positif d'abord ─────────────────────────────────────────────────

describe("scanBody — un message de courtier normal ne lève RIEN", () => {
  it("l'ouverture conforme de référence produit ZÉRO signalement", () => {
    // La régression que ce cas empêche : un mot ajouté à PROMO_TERMS_FR_EN ou à
    // SHAFT_TERMS (« offre », « exclusif », « garantie »…) qui rendrait fautif
    // le seul message que le produit souhaite voir partir.
    const flags = scan(CLEAN_OPENER);
    expect(flags.mergeFields, "un champ de fusion inventé").toEqual([]);
    expect(flags.links, "un lien inventé").toEqual([]);
    expect(flags.shorteners, "un raccourcisseur inventé").toEqual([]);
    expect(flags.promoTerms, "vocabulaire promotionnel inventé").toEqual([]);
    expect(flags.shaftTerms, "SHAFT inventé").toEqual([]);
    expect(flags.evasion, "évasion inventée").toEqual([]);
    expect(flags.exclamations).toBe(0);
    expect(flags.emoji).toBe(0);
    expect(flags.capsRatio, "les mots-clés de conformité comptés comme des cris").toBeLessThan(
      CAPS_ALARM,
    );
    // Ce qui est ATTENDU d'une ouverture : elle se nomme et elle offre la porte.
    expect(flags.hasOptOut, "« Répondez STOP » doit être reconnu").toBe(true);
    expect(flags.hasBrand, "la signature du courtier doit être reconnue").toBe(true);
    // Et le français accentué ordinaire (é, à) reste en GSM-7 : un seul segment.
    expect(flags.encoding, "é et à sont dans la table GSM 03.38").toBe("GSM-7");
    expect(flags.segments).toBe(1);
    expect(flags.ucs2Offenders).toEqual([]);
  });

  it("aucun message réel de courtier ne trébuche sur promo, SHAFT ou majuscules", () => {
    // Balayage groupé : on ramasse TOUS les écarts avant d'échouer, sinon le
    // premier faux positif cache les six suivants et la correction se fait à
    // l'aveugle, un message à la fois.
    const offenders: string[] = [];
    for (const { label, body } of REAL_BROKER_MESSAGES) {
      const flags = scan(body);
      if (flags.promoTerms.length > 0) offenders.push(`${label} → promo : ${flags.promoTerms.join(", ")}`);
      if (flags.shaftTerms.length > 0) offenders.push(`${label} → SHAFT : ${flags.shaftTerms.join(", ")}`);
      if (flags.capsRatio > CAPS_ALARM) offenders.push(`${label} → majuscules ${flags.capsRatio}`);
      if (flags.exclamations >= EXCLAMATION_ALARM) offenders.push(`${label} → ${flags.exclamations} « ! »`);
      if (flags.mergeFields.length > 0) offenders.push(`${label} → fusion : ${flags.mergeFields.join(", ")}`);
      if (flags.links.length > 0) offenders.push(`${label} → lien : ${flags.links.join(", ")}`);
      if (flags.evasion.length > 0) offenders.push(`${label} → évasion : ${flags.evasion.join(", ")}`);
    }
    expect(offenders, `des messages parfaitement normaux sont accusés :\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("le contexte « premier message » ne change AUCUN fait", () => {
    // Un scanner qui adoucit un fait selon son contexte devient impossible à
    // croire : c'est le registre de constats qui décide qu'une ABSENCE de STOP
    // ne vaut reproche que sur le premier message d'un fil.
    const body = "Une occasion a Levis : exemple.ca/fiche";
    expect(scanBody(body, { brandTokens: [...BRAND], isOpener: true })).toEqual(
      scanBody(body, { brandTokens: [...BRAND], isOpener: false }),
    );
  });
});

// ── Champs de fusion ────────────────────────────────────────────────────────

describe("scanBody — champs de fusion", () => {
  it("les cinq formes de gabarit sont vues telles qu'elles partiraient", () => {
    // Le constat le plus concret de l'écran : `renderTemplate` ne sert que le
    // prompt, jamais le corps d'un barreau de campagne — un « {{prenom}} »
    // écrit à la main part LITTÉRALEMENT au contact.
    const flags = scan("Bonjour {{prenom}} {{ nom }}, {prenom} [prenom] %prenom% ${x} — Groupe Nexus.");
    expect(flags.mergeFields).toEqual([
      "{{prenom}}",
      "{{ nom }}",
      "{prenom}",
      "[prenom]",
      "%prenom%",
      "${x}",
    ]);
  });

  it("un même gabarit répété ne compte qu'une fois", () => {
    // Le rapport doit être stable et lisible : six occurrences du même champ,
    // c'est une pièce à conviction, pas six.
    expect(scan("{{prenom}}, votre maison {{prenom}} — Groupe Nexus.").mergeFields).toEqual([
      "{{prenom}}",
    ]);
  });

  it("la prose entre crochets et « [1] » ne sont PAS des champs de fusion", () => {
    // Où la ligne est tracée : l'intérieur doit ressembler à un IDENTIFIANT —
    // lettre ou souligné en tête, puis lettres/chiffres/souligné/point. Sans la
    // règle du premier caractère, « exemple.ca/a%20b%20c » aurait produit
    // « %20b% » et l'écran aurait reproché un champ de fusion imaginaire dans
    // une adresse parfaitement valide.
    const flags = scan("Voir la fiche [inscription 12345], note [1] et photos exemple.ca/a%20b%20c");
    expect(flags.mergeFields, "faux champs de fusion").toEqual([]);
    expect(flags.links, "l'adresse, elle, reste un lien").toEqual(["exemple.ca/a%20b%20c"]);
  });
});

// ── Liens et raccourcisseurs ────────────────────────────────────────────────

describe("scanBody — liens et raccourcisseurs", () => {
  it("un lien raccourci est à la fois un lien et un raccourcisseur", () => {
    // Twilio rejette les échantillons de campagne qui en contiennent (30892) :
    // masquer la destination est exactement ce dont un envoi à froid est
    // soupçonné. Le compter comme raccourcisseur SANS le compter comme lien
    // ferait disparaître le constat « lien dans une ouverture ».
    const flags = scan("Détails : bit.ly/xy2 — Groupe Nexus.");
    expect(flags.links).toEqual(["bit.ly/xy2"]);
    expect(flags.shorteners).toEqual(["bit.ly/xy2"]);
  });

  it("un domaine nu sans schéma est un lien, sans être un raccourcisseur", () => {
    // Troisième branche de `URL_RE` : « voir nos propriétés sur exemple.ca »
    // passait entre les mailles du garde-fou avant qu'elle existe.
    const flags = scan("Voir nos inscriptions sur exemple.ca");
    expect(flags.links).toEqual(["exemple.ca"]);
    expect(flags.shorteners).toEqual([]);
  });

  it("un raccourcisseur invisible pour le garde-fou est quand même vu ici", () => {
    // `.gl` n'est PAS dans la liste fermée d'extensions de `URL_RE` : un
    // « goo.gl/xy » sans schéma lui est invisible, alors que c'est la forme de
    // lien la plus reprochée par les opérateurs. Le rattrapage doit tenir —
    // sinon l'écran certifie « aucun lien » sur le pire des cas.
    const flags = scan("Photos : goo.gl/xy2");
    expect(flags.links).toEqual(["goo.gl/xy2"]);
    expect(flags.shorteners).toEqual(["goo.gl/xy2"]);
  });

  it("le même lien n'est jamais compté deux fois par les deux détecteurs", () => {
    // « https://bit.ly/x » contient « bit.ly/x » : sans la garde d'inclusion,
    // l'écran afficherait deux liens là où il n'y en a qu'un.
    expect(scan("Ici : https://bit.ly/xy2").links).toEqual(["https://bit.ly/xy2"]);
  });

  it("les raccourcisseurs sont TOUJOURS un sous-ensemble des liens", () => {
    // Invariant du contrat (`ContentFlags.shorteners` : « sous-ensemble de
    // links »). Un raccourcisseur hors de `links` casserait tout comptage de
    // liens fait à partir du seul champ `links`.
    const corpus = [
      CLEAN_OPENER,
      "Détails : bit.ly/xy2",
      "Photos : goo.gl/xy2",
      "Voir exemple.ca et https://tinyurl.com/abc",
      "Rien du tout ici",
    ];
    const escapees: string[] = [];
    for (const body of corpus) {
      const flags = scan(body);
      for (const shortener of flags.shorteners) {
        if (!flags.links.includes(shortener)) escapees.push(`${shortener} (dans « ${body} »)`);
      }
    }
    expect(escapees, `raccourcisseurs absents de links :\n${escapees.join("\n")}`).toEqual([]);
  });
});

// ── Encodage ────────────────────────────────────────────────────────────────

describe("scanBody — ce qui force l'UCS-2", () => {
  it("l'apostrophe courbe bascule le message et propose son substitut ASCII", () => {
    // Le clavier français d'iOS produit « ’ » (U+2019) par défaut : le message
    // le plus banal coûte alors trois fois son prix. La suggestion est la
    // moitié utile du constat — sans elle, l'écran dit « c'est cher » sans dire
    // quoi remplacer.
    const flags = scan("C’est confirmé pour demain matin.");
    expect(flags.encoding).toBe("UCS-2");
    expect(flags.ucs2Offenders).toEqual([{ char: "’", suggestion: "'" }]);
  });

  it("« ê » bascule aussi, mais SANS suggestion — la remplacer changerait le sens", () => {
    // é è à ù ì ò sont dans la table GSM 03.38 ; ê, î, ô, û n'y sont pas. Aucun
    // substitut n'est proposé : écrire « pret » pour « prêt » est une faute,
    // pas une économie.
    const flags = scan("Le prêt est accepté par la banque.");
    expect(flags.encoding).toBe("UCS-2");
    expect(flags.ucs2Offenders.map((o) => o.char)).toEqual(["ê"]);
    expect(flags.ucs2Offenders[0]?.suggestion, "aucun substitut fidèle pour « ê »").toBeUndefined();
  });

  it("« ARRÊT » double la facture, « ARRET » non — pour le MÊME message", () => {
    // Le constat que l'exploitant verra vraiment : un seul accent circonflexe
    // dans le pied de conformité fait passer 115 caractères de 1 segment
    // (GSM-7, 160) à 2 segments (UCS-2, 67 par segment au-delà de 70). Les deux
    // orthographes sont reconnues comme mention d'arrêt : le choix est donc
    // gratuit, et c'est exactement pour ça qu'il faut le montrer.
    const gsm =
      "Bonjour, ici Alex-Honore du Groupe Nexus. Avez-vous encore un projet a Levis ? Repondez ARRET pour vous desabonner.";
    const ucs2 = gsm.replace("ARRET", "ARRÊT");
    const flagsGsm = scan(gsm);
    const flagsUcs2 = scan(ucs2);

    expect(flagsGsm.encoding).toBe("GSM-7");
    expect(flagsGsm.segments, "115 caractères GSM-7 tiennent dans un segment").toBe(1);
    expect(flagsGsm.ucs2Offenders).toEqual([]);

    expect(flagsUcs2.encoding, "Ê n'est pas dans la table GSM 03.38").toBe("UCS-2");
    expect(flagsUcs2.segments, "le même texte, deux fois plus cher").toBe(2);
    expect(flagsUcs2.ucs2Offenders).toEqual([{ char: "Ê" }]);

    // Et les deux disent bien « vous pouvez arrêter » : le repli d'accents de
    // l'opt-out est le MÊME que celui qui reconnaît un ARRÊT entrant.
    expect(flagsGsm.hasOptOut).toBe(true);
    expect(flagsUcs2.hasOptOut).toBe(true);
  });

  it("un émoji compte pour UN caractère, pas pour deux", () => {
    // `length` est en points de code : un opérateur qui relit son message
    // compte un pictogramme, pas la paire de substitution UTF-16 qui le code.
    const body = "Merci pour votre visite d'hier 🙏";
    const flags = scan(body);
    expect(flags.emoji).toBe(1);
    expect(flags.length).toBe(body.length - 1);
    expect(flags.encoding, "un émoji force l'UCS-2").toBe("UCS-2");
  });
});

// ── Ton ─────────────────────────────────────────────────────────────────────

describe("scanBody — le ton se mesure APRÈS avoir retiré ce que la conformité impose", () => {
  it("« Répondez STOP » et la marque ne comptent pas comme des cris", () => {
    // La régression exacte que ce cas empêche : compter « STOP » et
    // « GROUPE NEXUS » dans le taux de majuscules ferait sonner l'alarme
    // précisément sur les messages les mieux écrits — ceux qui portent la
    // mention d'arrêt et la signature exigées par la politique de Twilio.
    // La chaîne d'inégalités PROUVE que les deux effacements sont branchés :
    // avec marque < sans marque < aucun effacement.
    const body =
      "Bonjour, ici GROUPE NEXUS. Avez-vous encore un projet immobilier a Levis ? Repondez STOP pour vous desabonner.";
    const withBrand = scan(body, ["Groupe Nexus"]);
    const withoutBrand = scan(body, []);

    expect(
      withBrand.capsRatio,
      "l'effacement des marques n'est pas branché : la signature compte comme un cri",
    ).toBeLessThan(withoutBrand.capsRatio);
    expect(
      withoutBrand.capsRatio,
      "l'effacement de « STOP » n'est pas branché : le mot-clé de conformité compte comme un cri",
    ).toBeLessThan(rawCapsRatio(body));
    expect(withBrand.capsRatio, "un message conforme reste sous le seuil d'alarme").toBeLessThan(
      CAPS_ALARM,
    );
  });

  it("la signature ne pèse rien, quelle que soit sa casse", () => {
    // L'appariement des marques se fait sur le texte BRUT, insensible à la
    // casse : une signature criée (« GROUPE NEXUS ») est justement le cas qu'il
    // faut neutraliser. Le test est une ÉGALITÉ — signer coûte exactement zéro
    // point de majuscule, sinon le courtier serait puni de se nommer.
    const prose = "Bonjour, je vous ecris au sujet de votre maison a Levis.";
    const sansSignature = scan(prose, ["Groupe Nexus"]).capsRatio;
    for (const signature of ["Groupe Nexus", "GROUPE NEXUS", "groupe nexus"]) {
      expect(scan(`${prose} ${signature}`, ["Groupe Nexus"]).capsRatio, signature).toBe(sansSignature);
    }
    // Contrôle : sans marque déclarée, la même signature criée fait monter le
    // taux — c'est bien l'effacement qui produit l'égalité ci-dessus.
    expect(scan(`${prose} GROUPE NEXUS`, []).capsRatio).toBeGreaterThan(sansSignature);
  });

  it("un vrai cri publicitaire reste un cri", () => {
    // Contrôle positif : un détecteur rendu indulgent au point de ne plus
    // jamais se lever passerait les cas précédents sans rien protéger.
    const flags = scan("OFFRE URGENTE! APPELEZ MAINTENANT!! PRIX IMBATTABLE!");
    expect(flags.capsRatio).toBe(1);
    expect(flags.capsRatio).toBeGreaterThan(CAPS_ALARM);
    expect(flags.exclamations).toBe(4);
    expect(flags.exclamations).toBeGreaterThanOrEqual(EXCLAMATION_ALARM);
  });

  it("sous dix lettres, le taux de majuscules vaut 0 — on préfère le silence au bruit", () => {
    // Deux lettres capitales sur trois ne sont pas un cri, c'est du bruit
    // d'échantillon : « OK MERCI! » ne doit pas remonter comme un message
    // criard. Les points d'exclamation, eux, se comptent toujours.
    const flags = scan("OK MERCI!");
    expect(flags.capsRatio).toBe(0);
    expect(flags.exclamations).toBe(1);
  });
});

// ── Évasion ─────────────────────────────────────────────────────────────────

describe("scanBody — les procédés d'évasion", () => {
  it("largeur nulle et mélange d'alphabets sont nommés par leur point de code", () => {
    // Glisser une largeur nulle dans un mot casse la signature qu'un filtre
    // cherche sans rien changer à ce que le destinataire lit ; un « о »
    // cyrillique fait la même chose en restant visuellement IDENTIQUE. La
    // preuve doit donc être un point de code : montrer le glyphe reviendrait à
    // écrire « le problème est ici : » suivi de rien.
    // Échappements explicites : écrits tels quels, ces deux caractères seraient
    // invisibles dans ce fichier — exactement le problème qu'ils causent.
    const flags = scan("Bonjour\u200B, votre pr\u043Epriete a Levis. Repondez STOP.");
    expect(flags.evasion).toEqual(["U+200B", "U+043E"]);
  });

  it("un message entièrement dans un autre alphabet n'est PAS de l'évasion", () => {
    // On n'alarme que sur la CO-OCCURRENCE avec du latin : du cyrillique seul,
    // c'est une autre langue, pas un contournement.
    expect(scan("Привет, как дела ?").evasion).toEqual([]);
  });

  it("le français accentué n'est jamais de l'évasion", () => {
    // Garde-fou du faux positif : « é », « à », « ê » sont du français, pas un
    // procédé — ils coûtent des segments, ils n'accusent personne.
    expect(scan("Château à vendre, très bel arrière-cour, prêt à visiter.").evasion).toEqual([]);
  });
});

// ── Marque et mention d'arrêt ───────────────────────────────────────────────

describe("hasOptOutLanguage / hasBrand — repliés et insensibles à la casse", () => {
  it("« repondez stop » et « Répondez STOP » disent la même chose", () => {
    // Le repli est délégué à `normalizeOptOutInput`, le MÊME que celui qui
    // reconnaît un STOP entrant : si les deux divergeaient, l'écran
    // certifierait « mention d'arrêt présente » sur un message dont le mot-clé
    // ne serait justement pas reconnu à l'entrée.
    expect(hasOptOutLanguage("repondez stop pour ne plus rien recevoir")).toBe(true);
    expect(hasOptOutLanguage("Répondez STOP pour vous désabonner.")).toBe(true);
    expect(hasOptOutLanguage("Texto ARRÊT pour arrêter")).toBe(true);
    expect(hasOptOutLanguage("Répondez DÉSABONNER")).toBe(true);
  });

  it("« annuler votre rendez-vous » n'est PAS une mention de désabonnement", () => {
    // La liste cherchée ici est volontairement plus courte que
    // `OPTOUT_KEYWORDS` : là-bas le message ENTIER doit valoir le mot-clé, ici
    // on cherche à l'intérieur d'une phrase. Avec « ANNULER » dedans, l'écran
    // déclarerait conforme un message qui ne l'est pas — le pire des faux
    // négatifs, celui qui rassure.
    expect(hasOptOutLanguage("Souhaitez-vous annuler votre rendez-vous de demain ?")).toBe(false);
    expect(hasOptOutLanguage("Je peux passer visiter mercredi ?")).toBe(false);
  });

  it("la marque est reconnue sans accents et sans casse", () => {
    expect(scan("bonjour, ici alex-honore du groupe nexus").hasBrand).toBe(true);
    expect(scan("Bonjour, ici Alex-Honoré du Groupe Nexus").hasBrand).toBe(true);
    expect(scan("Bonjour, un courtier vous écrit.").hasBrand).toBe(false);
  });

  it("une marque vide ne rend pas TOUS les messages signés", () => {
    // `"".includes("")` vaut vrai : sans la garde, une organisation au nom vide
    // marquerait chaque message comme signé et le constat « marque absente » ne
    // se lèverait plus jamais.
    expect(scan("Bonjour, un courtier vous écrit.", [""]).hasBrand).toBe(false);
  });
});

// ── Vocabulaire surveillé ───────────────────────────────────────────────────

describe("scanBody — promo et SHAFT : les listes se lèvent quand il le faut", () => {
  it("le vocabulaire promotionnel est rendu sous sa forme ACCENTUÉE", () => {
    // L'appariement se fait sur la forme repliée (« offre limitee » est
    // attrapé), mais la preuve affichée reste française : une page qui
    // reproche « offre limitee » perd sa crédibilité avec son accent.
    expect(scan("Offre limitee : cliquez ici pour votre evaluation gratuite").promoTerms).toEqual([
      "gratuite",
      "offre limitée",
      "cliquez ici",
    ]);
  });

  it("« prêt hypothécaire » et « pré-approbation » sont du crédit, pas du métier", () => {
    // Le piège du courtier immobilier : ces formules-là sont réellement
    // filtrées par les opérateurs nord-américains, et elles s'écrivent sans y
    // voir malice. Le constat doit se lever AVANT l'envoi, pas après le 30007.
    expect(
      scan("Financement disponible : prêt hypothécaire et pré-approbation en 24 h.").shaftTerms,
    ).toEqual(["prêt hypothécaire", "pré-approbation"]);
  });

  it("« hypothèque » seule reste du métier", () => {
    // Contrepartie indispensable du cas précédent : sans elle, la liste dérive
    // vers « tout ce qui parle d'argent » et l'écran devient inutilisable pour
    // un courtier.
    expect(scan("Votre hypothèque arrive à échéance, on en parle ?").shaftTerms).toEqual([]);
  });
});

// ── Hostilité ───────────────────────────────────────────────────────────────

describe("isHostileReply — un PROXY de plainte, jamais la plainte", () => {
  it("la colère explicite est reconnue", () => {
    // Les signalements au 7726 arrivent à l'agrégateur, pas sur la rangée du
    // message : cette liste est tout ce qu'on peut voir. L'apostrophe courbe
    // d'iOS est le cas critique — sans son unification, la moitié des
    // expressions multi-mots serait morte sans que rien ne le signale.
    expect(isHostileReply("c'est du spam")).toBe(true);
    expect(isHostileReply("arrêtez de m’écrire s.v.p.")).toBe(true);
    expect(isHostileReply("je n'ai jamais demandé ça")).toBe(true);
  });

  it("un refus poli n'est PAS de l'hostilité", () => {
    // Ce taux sert d'estimation du taux de plainte : y verser les refus polis
    // ferait clignoter la page en rouge sur une campagne qui se passe bien, et
    // l'exploitant cesserait de la regarder.
    const misread = ["STOP", "stop", "non merci", "je vais y penser", "pas intéressé pour l'instant", ""].filter(
      (body) => isHostileReply(body),
    );
    expect(misread, `réponses ordinaires prises pour de l'hostilité : ${misread.join(", ")}`).toEqual(
      [],
    );
  });
});
