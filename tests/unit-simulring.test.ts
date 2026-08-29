/**
 * Unitaire — sonnerie simultanée vers le cellulaire du téléphoniste.
 *
 * Le contrat que ce fichier garde, et qui compte plus que le reste : ÉTEINTE,
 * l'option ne doit rien changer du tout. Pas « presque rien » — le TwiML
 * entrant doit être identique OCTET POUR OCTET à celui que la route produisait
 * avant que ce module existe. C'est pour ça que le premier test compare une
 * chaîne complète recopiée de src/app/api/telephony/twiml/route.ts, et non un
 * `toContain` : un attribut réordonné, un espace de plus, et Twilio accepte
 * pendant que le comportement dérive sans que personne ne le voie.
 *
 * Le second contrat : un cellulaire ne sonne JAMAIS par accident. Réglage
 * global éteint, ligne éteinte, numéro absent ou illisible — chaque cas rend
 * le même TwiML qu'avant, sans `<Number>`.
 *
 * Aucun réseau : tout ce qui est vérifié ici est une chaîne fabriquée en
 * mémoire. `src/lib/voipms.ts` est un module serveur — même convention que
 * tests/unit-voipms-did.test.ts pour pouvoir l'importer.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  INBOUND_DIAL_ACTION,
  INBOUND_DIAL_TIMEOUT_SECONDS,
  MAX_RING_GROUP_FORWARD_MEMBERS,
  MAX_RING_GROUP_SIP_MEMBERS,
  SIMULRING_OFF,
  forwardingDescription,
  forwardingNumber,
  forwardingRouting,
  inboundDialTwiml,
  resolveSimulRing,
  ringGroupMembers,
  ringGroupName,
  ringGroupRouting,
  simulRingSettingsSchema,
  subAccountRouting,
} = await import("@/lib/telephony/simulring");

const UID = "3f1c0e2a-9b44-4a1d-8c7e-5b2f6d0a1e93";

/**
 * Le TwiML entrant TEL QU'IL EST AUJOURD'HUI, recopié de la route. Toute
 * divergence est une régression pour les installations qui n'ont jamais
 * allumé l'option — c'est-à-dire, par défaut, toutes.
 */
const TWIML_AVANT =
  `<Dial answerOnBridge="true" timeout="30" action="/api/telephony/twiml?dialResult=1">` +
  `<Client>user-${UID}</Client></Dial>`;

const settings = (enabled = true, feature = true) =>
  simulRingSettingsSchema.parse({ enabled: feature, lines: { [UID]: { enabled } } });

/**
 * Ce que la personne a accepté. Le numéro ne vit PLUS dans le réglage : il est
 * chiffré dans `user_reach` (règle 4), et l'appelant le déchiffre avant de
 * poser la question. Un cellulaire personnel n'a rien à faire en clair dans un
 * `jsonb` que tout écran d'administration relit.
 */
const reach = (cell: string | null, ringMobile = true) => ({ cell, ringMobile });

describe("resolveSimulRing — l'option est éteinte tant qu'on ne l'allume pas", () => {
  it("§ un réglage jamais enregistré ne fait sonner personne", () => {
    expect(resolveSimulRing(simulRingSettingsSchema.parse({}), UID, reach("+15145550199"))).toEqual({
      status: "skipped",
      reason: "feature_off",
    });
    expect(resolveSimulRing(SIMULRING_OFF, UID, reach("+15145550199"))).toEqual({
      status: "skipped",
      reason: "feature_off",
    });
  });

  it("§ l'interrupteur global prime sur une ligne allumée", () => {
    expect(resolveSimulRing(settings(true, false), UID, reach("+15145550199"))).toEqual({
      status: "skipped",
      reason: "feature_off",
    });
  });

  it("§ une ligne éteinte se distingue d'un réglage éteint", () => {
    // Deux raisons distinctes parce qu'elles ne se corrigent pas au même écran.
    expect(resolveSimulRing(settings(false), UID, reach("+15145550199"))).toEqual({
      status: "skipped",
      reason: "line_off",
    });
  });

  it("§ sans le OUI de la personne, aucun interrupteur d'administration ne suffit", () => {
    // La troisième condition n'est pas une redondance des deux autres : faire
    // sonner un numéro personnel est une décision qui appartient à celui à qui
    // il appartient. L'admin ouvre la porte ; il ne passe pas à sa place.
    expect(resolveSimulRing(settings(), UID, reach("+15145550199", false))).toEqual({
      status: "skipped",
      reason: "not_consented",
    });
    expect(resolveSimulRing(settings(), UID, null)).toEqual({
      status: "skipped",
      reason: "not_consented",
    });
  });

  it("§ une personne sans ligne enregistrée ne sonne pas", () => {
    expect(resolveSimulRing(settings(), "autre-uid", reach("+15145550199"))).toEqual({
      status: "skipped",
      reason: "line_off",
    });
  });

  it("§ un numéro absent ou illisible ne devient jamais un appel", () => {
    expect(resolveSimulRing(settings(), UID, reach(""))).toEqual({ status: "skipped", reason: "no_cell" });
    expect(resolveSimulRing(settings(), UID, reach("poste 22"))).toEqual({
      status: "skipped",
      reason: "no_cell",
    });
  });

  it("§ un numéro saisi à la main est normalisé en E.164", () => {
    // Le réglage se saisit dans un formulaire : « (514) 555-0199 » collé tel
    // quel produirait un <Number> que Twilio refuse — donc un appel perdu.
    expect(resolveSimulRing(settings(), UID, reach("(514) 555-0199"))).toEqual({
      status: "on",
      cell: "+15145550199",
    });
  });
});

describe("inboundDialTwiml — éteinte, l'option ne change rien", () => {
  it("§ sans décision, le TwiML est celui d'avant, octet pour octet", () => {
    expect(inboundDialTwiml({ identity: `user-${UID}` })).toBe(TWIML_AVANT);
  });

  it("§ option éteinte : même chaîne exactement", () => {
    const decision = resolveSimulRing(SIMULRING_OFF, UID, reach("+15145550199"));
    expect(inboundDialTwiml({ identity: `user-${UID}`, simulRing: decision })).toBe(TWIML_AVANT);
  });

  it("§ option allumée mais aucun cellulaire : même chaîne exactement", () => {
    const decision = resolveSimulRing(settings(), UID, reach(""));
    expect(decision).toEqual({ status: "skipped", reason: "no_cell" });
    expect(inboundDialTwiml({ identity: `user-${UID}`, simulRing: decision })).toBe(TWIML_AVANT);
  });

  it("§ les valeurs du Dial d'aujourd'hui sont celles des constantes", () => {
    expect(INBOUND_DIAL_TIMEOUT_SECONDS).toBe(30);
    expect(INBOUND_DIAL_ACTION).toBe("/api/telephony/twiml?dialResult=1");
  });
});

describe("inboundDialTwiml — allumée, les deux destinations sonnent ensemble", () => {
  const decision = resolveSimulRing(settings(), UID, reach("+15145550199"));

  it("§ un SEUL Dial contient le poste ET le cellulaire", () => {
    const xml = inboundDialTwiml({ identity: `user-${UID}`, simulRing: decision });
    expect(xml).toBe(
      `<Dial answerOnBridge="true" timeout="30" action="/api/telephony/twiml?dialResult=1">` +
        `<Client>user-${UID}</Client><Number>+15145550199</Number></Dial>`,
    );
    // Un seul <Dial> : deux Dial successifs sonneraient l'un APRÈS l'autre.
    expect(xml.match(/<Dial/g)).toHaveLength(1);
    expect(xml).toContain(`<Client>user-${UID}</Client>`);
    expect(xml).toContain("<Number>+15145550199</Number>");
  });

  it("§ le poste reste en tête", () => {
    const xml = inboundDialTwiml({ identity: `user-${UID}`, simulRing: decision });
    expect(xml.indexOf("<Client>")).toBeLessThan(xml.indexOf("<Number>"));
  });

  it("§ aucun callerId n'est forcé — l'appelant reste identifiable", () => {
    // Le rapprochement de la fiche client lit ce numéro ; l'écraser par le DID
    // afficherait « c'est le travail » et effacerait qui appelle.
    expect(inboundDialTwiml({ identity: `user-${UID}`, simulRing: decision })).not.toContain(
      "callerId",
    );
  });

  it("§ la confirmation « appuyez sur 1 » reste optionnelle", () => {
    expect(inboundDialTwiml({ identity: `user-${UID}`, simulRing: decision })).not.toContain("url=");
    expect(
      inboundDialTwiml({
        identity: `user-${UID}`,
        simulRing: decision,
        confirmUrl: "/api/telephony/twiml?confirm=1&leg=cell",
      }),
    ).toContain('<Number url="/api/telephony/twiml?confirm=1&amp;leg=cell">');
  });

  it("§ tout ce qui entre dans le XML est échappé", () => {
    const xml = inboundDialTwiml({
      identity: 'user-<script>&"',
      simulRing: { status: "on", cell: "+1514555<0199" },
    });
    expect(xml).toContain("<Client>user-&lt;script&gt;&amp;&quot;</Client>");
    expect(xml).toContain("<Number>+1514555&lt;0199</Number>");
  });
});

describe("voip.ms — les chaînes de routage", () => {
  it("§ un sous-compte se route par account:", () => {
    // La forme déjà bâtie par routeDidToSubAccount — elle ne doit pas diverger.
    expect(subAccountRouting("551013_alex")).toBe("account:551013_alex");
  });

  it("§ un groupe de sonnerie par grp:, un renvoi par fwd:", () => {
    expect(ringGroupRouting(4768)).toBe("grp:4768");
    expect(ringGroupRouting("4768")).toBe("grp:4768");
    expect(forwardingRouting(19183)).toBe("fwd:19183");
  });

  it("§ les membres sont des en-têtes séparés par des points-virgules", () => {
    expect(ringGroupMembers({ sipAccounts: ["551013_alex"], forwardIds: ["16006"] })).toEqual({
      status: "ok",
      members: "account:551013_alex;fwd:16006",
    });
  });

  it("§ le poste passe avant le renvoi dans la liste des membres", () => {
    const r = ringGroupMembers({ sipAccounts: ["a", "b"], forwardIds: [1, 2] });
    expect(r).toEqual({ status: "ok", members: "account:a;account:b;fwd:1;fwd:2" });
  });

  it("§ un groupe sans membre n'est pas une liste vide, c'est un refus", () => {
    expect(ringGroupMembers({ sipAccounts: [], forwardIds: [] })).toEqual({
      status: "skipped",
      reason: "no_members",
    });
    expect(ringGroupMembers({ sipAccounts: ["  "], forwardIds: [""] })).toEqual({
      status: "skipped",
      reason: "no_members",
    });
  });

  it("§ les plafonds documentés (8 SIP, 4 renvois) sont refusés AVANT l'appel", () => {
    const sip = Array.from({ length: MAX_RING_GROUP_SIP_MEMBERS + 1 }, (_, i) => `acc${i}`);
    expect(ringGroupMembers({ sipAccounts: sip, forwardIds: ["1"] })).toEqual({
      status: "skipped",
      reason: "too_many_sip",
    });

    const fwd = Array.from({ length: MAX_RING_GROUP_FORWARD_MEMBERS + 1 }, (_, i) => i + 1);
    expect(ringGroupMembers({ sipAccounts: ["acc"], forwardIds: fwd })).toEqual({
      status: "skipped",
      reason: "too_many_forwards",
    });

    // Le maximum EXACT passe : la borne est inclusive.
    expect(
      ringGroupMembers({
        sipAccounts: sip.slice(0, MAX_RING_GROUP_SIP_MEMBERS),
        forwardIds: fwd.slice(0, MAX_RING_GROUP_FORWARD_MEMBERS),
      }).status,
    ).toBe("ok");
  });
});

describe("voip.ms — le numéro d'un renvoi", () => {
  it("§ un numéro nord-américain part à 10 chiffres, sans +1", () => {
    // Même piège que didDigits : la forme E.164 stockée en base fait échouer
    // l'API voip.ms, et l'échec est silencieux côté appel entrant.
    expect(forwardingNumber("+15145550199")).toBe("5145550199");
    expect(forwardingNumber("15145550199")).toBe("5145550199");
    expect(forwardingNumber("(514) 555-0199")).toBe("5145550199");
  });

  it("§ un numéro international prend le préfixe 011 exigé par voip.ms", () => {
    expect(forwardingNumber("+525559876543")).toBe("011525559876543");
    expect(forwardingNumber("+442079460958")).toBe("011442079460958");
  });

  it("§ aucun « + » ne sort jamais d'ici", () => {
    for (const n of ["+15145550199", "+525559876543", "+442079460958"]) {
      expect(forwardingNumber(n)).not.toContain("+");
    }
  });
});

describe("voip.ms — les noms dérivés", () => {
  it("§ le groupe porte le nom du DID, pour être retrouvé et réécrit", () => {
    // Sans nom stable, chaque enregistrement créerait un groupe de plus.
    expect(ringGroupName("+14184761542")).toBe("Nexus 4184761542");
    expect(ringGroupName("4184761542")).toBe("Nexus 4184761542");
  });

  it("§ la description du renvoi nomme la personne et tient dans le champ", () => {
    expect(forwardingDescription("Alex Honoré")).toBe("Nexus cellulaire Alex Honoré");
    expect(forwardingDescription("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
