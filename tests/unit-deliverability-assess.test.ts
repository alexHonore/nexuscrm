/**
 * Unitaire — des chiffres aux constats.
 *
 * Ce test est la raison d'être du découpage : `assess()` est pur, donc la
 * règle « 30007 au-dessus de 1 % = danger, et voici où corriger » se vérifie
 * sans Postgres, sans Twilio et sans horloge. Un seuil qui bouge sans que
 * personne ne s'en aperçoive est le seul vrai risque d'un tableau de bord de
 * conformité : il continue d'afficher du vert.
 *
 * Le cas le plus important n'est pas un cas d'alarme, c'est le PREMIER : un
 * trafic sain ne doit produire AUCUN constat. Un écran qui crie au loup sur un
 * envoi normal cesse d'être lu, et le jour du vrai filtrage il ne protège plus
 * personne.
 */
import { describe, expect, it } from "vitest";
import { MAX_RENDERED_FINDINGS, assess } from "@/lib/deliverability/assess";
import { scanBody } from "@/lib/deliverability/content";
import { FINDING_DOCS } from "@/lib/deliverability/findings";
import { rangeOf } from "@/lib/deliverability/range";
import { METRICS_WITHOUT_THRESHOLD, THRESHOLDS, verdictFor } from "@/lib/deliverability/thresholds";
import {
  FINDING_IDS,
  METRIC_IDS,
  PROVENANCES,
  type CampaignBodyIssue,
  type DeliverabilityFacts,
  type FindingId,
  type NumberFacts,
} from "@/lib/deliverability/types";

const NOW = new Date("2026-08-27T15:00:00Z");
const BRAND = ["Groupe Nexus", "Alex-Honoré"];

function number(overrides: Partial<NumberFacts> = {}): NumberFacts {
  return {
    smsNumberId: "num-1",
    e164: "+14185550111",
    label: "Principal",
    active: true,
    dailyCap: 200,
    messagingServiceSid: "MG000",
    statusCounts: { delivered: 980, undelivered: 10, failed: 10 },
    messages: 1000,
    segments: 1000,
    staleInFlight: 0,
    noDlr: 0,
    dlrEligible: 1000,
    errors: [],
    previousErrors: [],
    previousMessages: 1000,
    ucs2Messages: 0,
    sentToday: 10,
    ...overrides,
  };
}

/** Un trafic sain : mille messages, presque tout remis, des gens qui répondent. */
function healthyFacts(overrides: Partial<DeliverabilityFacts> = {}): DeliverabilityFacts {
  return {
    now: NOW,
    range: rangeOf(7, NOW),
    numbers: [number()],
    skipped: [],
    optOut: { stopped: 2, reached: 800 },
    carrierSuppressions: { total: 0, code30003: 0 },
    suppressionLeaks: [],
    suppressionLeakTotal: 0,
    engagement: {
      conversationsReached: 800,
      conversationsReplied: 240,
      outbound: 1000,
      inbound: 300,
      unansweredTail: 40,
    },
    hostile: { replies: 0, inboundScanned: 300, samples: [] },
    burst: { medianSegments: 4, p99Segments: 9, peakSegments: 12, minutes: 900 },
    senderInconsistency: [],
    senderInconsistencyTotal: 0,
    quietHours: { violations: 0, automated: 1000 },
    destinations: { total: 800, usBound: 0 },
    templates: {
      clusters: [
        { representativeBody: "Bonjour Marie, …", messages: 600, distinctRecipients: 590, distinctSendingNumbers: 1 },
        { representativeBody: "Merci pour votre retour…", messages: 400, distinctRecipients: 380, distinctSendingNumbers: 1 },
      ],
      scanned: 620,
      truncated: false,
    },
    campaignIssues: [],
    unguardedLadderRungs: [],
    engine: {
      lastDispatchAt: new Date(NOW.getTime() - 60_000),
      killSwitch: false,
      killSwitchReason: null,
      backlog: 0,
      oldestPendingAt: null,
      // Une cadence à la minute : le constat structurel du cron quotidien ne
      // doit pas polluer les cas de mesure.
      cronSchedule: "* * * * *",
    },
    openers: { scanned: 200, missingOptOut: 0, missingBrand: 0, samples: [], truncated: false },
    ...overrides,
  };
}

function campaignIssue(body: string, overrides: Partial<CampaignBodyIssue> = {}): CampaignBodyIssue {
  return {
    campaignId: "11111111-1111-4111-8111-111111111111",
    campaignName: "Relance printemps",
    origin: "ladder",
    slot: "0",
    excerpt: body.slice(0, 200),
    flags: scanBody(body, { brandTokens: BRAND, isOpener: true }),
    ...overrides,
  };
}

const idsOf = (facts: DeliverabilityFacts): FindingId[] =>
  assess(facts, "fr").findings.map((f) => f.id);

// ── Les seuils ──────────────────────────────────────────────────────────────

describe("seuils de délivrabilité", () => {
  it("chaque indicateur a un seuil et une provenance", () => {
    expect(METRICS_WITHOUT_THRESHOLD, "un indicateur sans seuil ne peut pas rendre de verdict").toEqual([]);
    for (const id of METRIC_IDS) {
      const threshold = THRESHOLDS[id];
      expect(Number.isFinite(threshold.warn), `${id}.warn`).toBe(true);
      expect(Number.isFinite(threshold.danger), `${id}.danger`).toBe(true);
      expect(PROVENANCES, `${id} porte une provenance connue`).toContain(threshold.provenance);
    }
  });

  it("« danger » est toujours plus loin que « avertissement », dans le bon sens", () => {
    for (const id of METRIC_IDS) {
      const { direction, warn, danger, informational } = THRESHOLDS[id];
      if (informational) continue;
      if (direction === "high") expect(danger, `${id} monte : danger ≥ warn`).toBeGreaterThanOrEqual(warn);
      else expect(danger, `${id} descend : danger ≤ warn`).toBeLessThanOrEqual(warn);
    }
  });

  it("sous l'échantillon minimal, le verdict est « inconnu » et jamais « bon »", () => {
    // Deux échecs sur trois messages ne sont pas un taux d'échec de 67 % :
    // c'est du bruit, et le peindre en rouge est la façon la plus sûre de
    // faire ignorer un tableau de bord.
    expect(verdictFor("delivered_rate", 0, 3)).toBe("unknown");
    expect(verdictFor("optout_rate", 1, 5)).toBe("unknown");
    expect(verdictFor("delivered_rate", null, 10_000)).toBe("unknown");
  });

  it("le taux de répétition ne déclenche JAMAIS d'alarme", () => {
    // Une campagne conforme envoie le même gabarit à tout le monde : c'est
    // exactement ce qu'elle a déclaré. Alarmer là-dessus pousserait à varier
    // les textes — or varier pour échapper à la détection est précisément ce
    // que la politique de Twilio interdit.
    for (const value of [0, 0.5, 0.99, 0.999]) {
      expect(verdictFor("duplication_rate", value, 10_000)).toBe("ok");
    }
  });

  it("un seuil est la DERNIÈRE valeur encore acceptable", () => {
    expect(verdictFor("delivered_rate", 0.95, 1000)).toBe("ok");
    expect(verdictFor("delivered_rate", 0.94, 1000)).toBe("warn");
    expect(verdictFor("delivered_rate", 0.89, 1000)).toBe("danger");
    expect(verdictFor("filtered_rate", 0, 10_000)).toBe("ok");
    expect(verdictFor("filtered_rate", 0.002, 10_000)).toBe("warn");
    expect(verdictFor("filtered_rate", 0.02, 10_000)).toBe("danger");
  });
});

// ── Le rapport ──────────────────────────────────────────────────────────────

describe("assess — un trafic sain", () => {
  it("ne produit AUCUN constat", () => {
    const report = assess(healthyFacts(), "fr");
    expect(report.findings.map((f) => `${f.id} (${f.severity})`), "un envoi normal ne doit rien déclencher").toEqual([]);
    expect(report.verdict).toBe("ok");
    expect(report.empty).toBe(false);
  });

  it("rend les 29 indicateurs, dans l'ordre de lecture", () => {
    const report = assess(healthyFacts(), "fr");
    expect(report.metrics.map((m) => m.id)).toEqual([...METRIC_IDS]);
  });

  it("une période sans aucun envoi se dit « inconnue », jamais « bonne »", () => {
    const report = assess(
      healthyFacts({
        numbers: [number({ messages: 0, segments: 0, statusCounts: {}, previousMessages: 0 })],
        optOut: { stopped: 0, reached: 0 },
        engagement: { conversationsReached: 0, conversationsReplied: 0, outbound: 0, inbound: 0, unansweredTail: 0 },
        templates: { clusters: [], scanned: 0, truncated: false },
        destinations: { total: 0, usBound: 0 },
        hostile: { replies: 0, inboundScanned: 0, samples: [] },
      }),
      "fr",
    );
    expect(report.empty).toBe(true);
    expect(report.verdict).toBe("unknown");
  });
});

describe("assess — les signaux de filtrage", () => {
  it("le code 30007 au-dessus de 1 % des segments est un danger", () => {
    const report = assess(
      healthyFacts({
        numbers: [number({ errors: [{ errorCode: 30007, messages: 30, segments: 30 }] })],
      }),
      "fr",
    );
    const finding = report.findings.find((f) => f.id === "carrier_filtered");
    expect(finding, "un filtrage à 3 % doit remonter").toBeDefined();
    expect(finding?.severity).toBe("danger");
    expect(finding?.fix.length, "un constat sans geste ne sert à rien").toBeGreaterThan(20);
    expect(report.verdict).toBe("danger");
  });

  it("un désabonnement à 3 % remonte, à 0,25 % non", () => {
    expect(idsOf(healthyFacts({ optOut: { stopped: 24, reached: 800 } }))).toContain("optout_rate_high");
    expect(idsOf(healthyFacts({ optOut: { stopped: 2, reached: 800 } }))).not.toContain("optout_rate_high");
  });

  it("un seul message parti vers un numéro supprimé est un danger, avec la fiche en lien", () => {
    const report = assess(
      healthyFacts({
        suppressionLeakTotal: 1,
        suppressionLeaks: [
          {
            messageId: "m1",
            conversationId: "c1",
            clientId: "22222222-2222-4222-8222-222222222222",
            clientPhone: "+15145550142",
            suppressedAt: new Date(NOW.getTime() - 7_200_000),
            sentAt: new Date(NOW.getTime() - 3_600_000),
            source: "ladder",
            excerpt: "Bonjour, avez-vous pensé à…",
          },
        ],
      }),
      "fr",
    );
    const finding = report.findings.find((f) => f.id === "suppression_leak");
    expect(finding?.severity).toBe("danger");
    expect(finding?.deepLink).toBe("/clients/22222222-2222-4222-8222-222222222222");
    expect(finding?.evidence.samples.length).toBe(1);
  });

  it("un gabarit porté par deux numéros est de l'essaimage", () => {
    const report = assess(
      healthyFacts({
        templates: {
          clusters: [
            {
              representativeBody: "Bonjour, une occasion à Lévis…",
              messages: 600,
              distinctRecipients: 590,
              distinctSendingNumbers: 3,
            },
          ],
          scanned: 620,
          truncated: false,
        },
      }),
      "fr",
    );
    const finding = report.findings.find((f) => f.id === "template_spread");
    expect(finding, "le même texte sur trois numéros est LE signal d'essaimage").toBeDefined();
    expect(finding?.severity).toBe("danger");
    expect(finding?.evidence.samples[0]?.count).toBe(3);
  });

  it("le répartiteur muet est un danger, même sans mesure", () => {
    const report = assess(
      healthyFacts({
        engine: { ...healthyFacts().engine, lastDispatchAt: null },
      }),
      "fr",
    );
    expect(idsOf(healthyFacts({ engine: { ...healthyFacts().engine, lastDispatchAt: null } }))).toContain(
      "dispatcher_stale",
    );
    expect(report.findings.find((f) => f.id === "dispatcher_stale")?.severity).toBe("danger");
  });
});

describe("assess — les textes de campagne, avant le premier envoi", () => {
  it("un champ de fusion et un lien raccourci sont vus au repos", () => {
    const body =
      "Bonjour {{prenom}}, une occasion à Lévis : bit.ly/xy2 — Groupe Nexus. Répondez STOP pour vous désabonner.";
    const report = assess(healthyFacts({ campaignIssues: [campaignIssue(body)] }), "fr");
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain("merge_field_leak");
    expect(ids).toContain("public_shortener");
    for (const id of ["merge_field_leak", "public_shortener"] as const) {
      const finding = report.findings.find((f) => f.id === id);
      expect(finding?.deepLink, `${id} doit mener au barreau fautif`).toBe(
        "/admin/campaigns/11111111-1111-4111-8111-111111111111?tab=ladder",
      );
      expect(finding?.subject).toBe("Relance printemps");
    }
  });

  it("un texte conforme ne déclenche rien", () => {
    const body =
      "Bonjour, ici Alex-Honore de Groupe Nexus. Avez-vous encore un projet immobilier a Levis ? Repondez STOP pour vous desabonner.";
    expect(idsOf(healthyFacts({ campaignIssues: [campaignIssue(body)] }))).toEqual([]);
  });

  it("six barreaux fautifs de la MÊME campagne font UN constat, pas six", () => {
    const issues = Array.from({ length: 6 }, (_, i) =>
      campaignIssue(`Bonjour {{prenom}}, message ${i}. Groupe Nexus. Repondez STOP.`, {
        slot: String(i),
        origin: "ladder",
      }),
    );
    const findings = assess(healthyFacts({ campaignIssues: issues }), "fr").findings.filter(
      (f) => f.id === "merge_field_leak",
    );
    expect(findings.length, "sinon un seul gabarit noie les quarante autres constats").toBe(1);
    expect(findings[0]?.evidence.samples.length).toBe(5);
  });

  it("un barreau écrit à la main est signalé comme échappant aux garde-fous", () => {
    const ids = idsOf(
      healthyFacts({
        unguardedLadderRungs: [
          { campaignId: "11111111-1111-4111-8111-111111111111", campaignName: "Relance printemps", rungs: 3 },
        ],
      }),
    );
    expect(ids).toContain("ladder_body_unguarded");
  });
});

describe("assess — la discipline du catalogue", () => {
  it("la gravité mesurée n'adoucit jamais la gravité déclarée", () => {
    // `carrier_filtered` est déclaré « danger » : un franchissement en simple
    // avertissement ne doit pas le rétrograder.
    const report = assess(
      healthyFacts({ numbers: [number({ errors: [{ errorCode: 30007, messages: 2, segments: 2 }] })] }),
      "fr",
    );
    const finding = report.findings.find((f) => f.id === "carrier_filtered");
    if (finding) expect(finding.severity).toBe("danger");
  });

  it("chaque constat émis porte un titre, un pourquoi et un geste", () => {
    const report = assess(
      healthyFacts({
        numbers: [
          number({
            statusCounts: { delivered: 700, undelivered: 200, failed: 100 },
            errors: [
              { errorCode: 30007, messages: 40, segments: 40 },
              { errorCode: 30005, messages: 60, segments: 60 },
              { errorCode: 30034, messages: 5, segments: 5 },
            ],
            noDlr: 300,
            ucs2Messages: 700,
            staleInFlight: 40,
            sentToday: 199,
          }),
        ],
        optOut: { stopped: 40, reached: 800 },
        quietHours: { violations: 12, automated: 1000 },
        destinations: { total: 800, usBound: 200 },
        engine: { ...healthyFacts().engine, killSwitch: true, backlog: 500, cronSchedule: "30 12 * * *" },
      }),
      "fr",
    );
    expect(report.findings.length).toBeGreaterThan(6);
    for (const finding of report.findings) {
      expect(finding.title.length, `${finding.id} sans titre`).toBeGreaterThan(3);
      expect(finding.why.length, `${finding.id} sans raison`).toBeGreaterThan(20);
      expect(finding.fix.length, `${finding.id} sans geste`).toBeGreaterThan(15);
    }
    // Le plus grave d'abord : une liste triée par ordre alphabétique se lit
    // de haut en bas sans jamais commencer par ce qui brûle.
    const ranks = report.findings.map((f) => ({ danger: 0, warn: 1, info: 2 })[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(report.findings.length).toBeLessThanOrEqual(MAX_RENDERED_FINDINGS);
  });

  it("l'anglais rend de l'anglais", () => {
    const facts = healthyFacts({ optOut: { stopped: 40, reached: 800 } });
    const fr = assess(facts, "fr").findings.find((f) => f.id === "optout_rate_high");
    const en = assess(facts, "en").findings.find((f) => f.id === "optout_rate_high");
    expect(fr?.title).toBeDefined();
    expect(en?.title).toBeDefined();
    expect(en?.title).not.toBe(fr?.title);
    expect(en?.why).not.toMatch(/[«»]/);
  });

  it("chaque identifiant du catalogue existe dans le registre", () => {
    const missing = FINDING_IDS.filter((id) => !FINDING_DOCS[id]);
    expect(missing, "un constat sans fiche s'afficherait sans texte").toEqual([]);
  });
});

/**
 * Régressions trouvées en revue adverse, épinglées une par une.
 *
 * Chacune était un mensonge silencieux : la page affichait quelque chose de
 * rassurant que les chiffres ne disaient pas. C'est le seul mode de panne qui
 * compte vraiment pour un écran de conformité — il ne plante pas, il rassure.
 */
describe("assess — les mensonges rassurants", () => {
  it("« rien à signaler » exige qu'au moins un indicateur décisif soit MESURÉ", () => {
    // Quarante messages : sous l'échantillon minimal de presque tout. La page
    // ne peut pas conclure « tout va bien » — elle n'a rien mesuré du tout.
    const report = assess(
      healthyFacts({
        numbers: [
          number({
            messages: 40,
            segments: 45,
            statusCounts: { delivered: 20, undelivered: 20 },
            errors: [{ errorCode: 30007, messages: 20, segments: 22 }],
            dlrEligible: 40,
            previousMessages: 40,
          }),
        ],
        optOut: { stopped: 0, reached: 30 },
        engagement: {
          conversationsReached: 30,
          conversationsReplied: 9,
          outbound: 40,
          inbound: 10,
          unansweredTail: 1,
        },
        hostile: { replies: 0, inboundScanned: 10, samples: [] },
        destinations: { total: 30, usBound: 0 },
        burst: { medianSegments: 2, p99Segments: 4, peakSegments: 5, minutes: 30 },
        templates: { clusters: [], scanned: 0, truncated: false },
      }),
      "fr",
    );
    expect(report.verdict, "un demi-trafic filtré ne peut pas se lire « rien à signaler »").not.toBe(
      "ok",
    );
  });

  it("le bandeau suit les INDICATEURS, pas seulement les constats affichés", () => {
    // `segments_per_message` n'a AUCUN constat attaché : fonder le bandeau sur
    // les constats affichait du vert au-dessus d'une tuile rouge.
    const report = assess(
      healthyFacts({
        numbers: [number({ segments: 4000 })], // 4 segments par message
      }),
      "fr",
    );
    const metric = report.metrics.find((m) => m.id === "segments_per_message");
    expect(metric?.verdict).toBe("danger");
    expect(report.findings.some((f) => f.id === "low_delivery_rate")).toBe(false);
    expect(report.verdict, "une tuile rouge et un bandeau vert ne peuvent pas coexister").toBe(
      "danger",
    );
  });

  it("une ouverture sans marque produit un constat, pas seulement un compteur", () => {
    // La LCAP exige DEUX choses du premier message : dire qui écrit, et dire
    // comment arrêter. Seule la seconde était rapportée.
    const ids = idsOf(
      healthyFacts({
        openers: { scanned: 200, missingOptOut: 0, missingBrand: 12, samples: [], truncated: false },
      }),
    );
    expect(ids).toContain("missing_brand");
  });

  it("aucun texte visible n'est écrit en dur dans le calcul", () => {
    // Un `subject` français posé ici s'affichait tel quel à un administrateur
    // anglophone. Tout ce qui se lit vient du registre ou des traductions.
    const report = assess(
      healthyFacts({
        openers: { scanned: 200, missingOptOut: 40, missingBrand: 40, samples: [], truncated: true },
      }),
      "en",
    );
    for (const finding of report.findings) {
      expect(finding.subject ?? "", `${finding.id} porte un sujet français`).not.toMatch(/[àâçéèêëîôùûœ]/i);
    }
    // Et la troncature du balayage est DITE, pas tue.
    expect(report.findings.find((f) => f.id === "missing_optout_language")?.evidence.truncated).toBe(
      true,
    );
  });

  it("le compte des expéditeurs mélangés est le VRAI compte, pas la taille de l'échantillon", () => {
    // La liste d'exemples est plafonnée à 50 ; s'en servir comme valeur
    // affichait « 50 » là où il y en avait douze mille.
    const report = assess(
      healthyFacts({
        senderInconsistency: [{ clientId: "c1", clientName: "Untel", senders: 2 }],
        senderInconsistencyTotal: 12_000,
      }),
      "fr",
    );
    expect(report.metrics.find((m) => m.id === "sender_consistency")?.value).toBe(12_000);
    const finding = report.findings.find((f) => f.id === "sender_inconsistency");
    expect(finding?.evidence.truncated, "un exemple pour douze mille cas doit se dire").toBe(true);
  });

  it("la concentration se juge sur la grappe qu'elle mesure, pas sur toutes", () => {
    // Le dénominateur venait de la somme de toutes les grappes : une grappe de
    // 25 messages était jugée sur la foi des 5 000 autres.
    const report = assess(
      healthyFacts({
        templates: {
          clusters: [
            { representativeBody: "A", messages: 5000, distinctRecipients: 4900, distinctSendingNumbers: 1 },
            { representativeBody: "B", messages: 25, distinctRecipients: 3, distinctSendingNumbers: 1 },
          ],
          scanned: 40,
          truncated: false,
        },
      }),
      "fr",
    );
    const metric = report.metrics.find((m) => m.id === "reach_concentration");
    expect(metric?.denominator, "le dénominateur est le volume de LA grappe").toBe(25);
    expect(metric?.verdict, "25 messages ne suffisent pas pour trancher").toBe("unknown");
  });
});
