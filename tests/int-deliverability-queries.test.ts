/**
 * Intégration — les lectures du tableau de bord de délivrabilité.
 *
 * `src/lib/deliverability-server/queries.ts` est le seul endroit du dépôt qui
 * transforme la table `messages` en chiffres de conformité. Chaque agrégat y
 * repose sur une décision qui ne se voit PAS à la lecture d'un écran, et dont
 * l'erreur ne se remarque jamais : un taux légèrement faux reste vert.
 *
 * Ce que ces tests épinglent, un par un :
 *
 *  · **le dénominateur** — un sortant sans `twilio_sid` n'a jamais atteint le
 *    transporteur ; le compter ferait chuter le taux de remise à chaque essai à
 *    blanc et à chaque coup d'interrupteur d'arrêt ;
 *  · **la grâce de clôture** de `suppressionLeaks` — UN message après un STOP,
 *    jamais deux. C'est la règle la plus délicate du fichier : une fenêtre trop
 *    large blanchit une vraie fuite, une fenêtre trop étroite accuse
 *    l'assistant d'une politesse permise ;
 *  · **« aujourd'hui »** — `sentToday` doit compter EXACTEMENT comme
 *    `outboundCountToday`, l'exécutant du plafond. Les deux sont appelés sur la
 *    MÊME semence et comparés l'un à l'autre, jamais à un nombre écrit à la
 *    main : un tableau de bord qui annonce de la marge pendant que l'envoi
 *    reporte au lendemain est pire que pas de tableau de bord ;
 *  · **le fuseau** — minuit se compte à Toronto, pas à Greenwich.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  resetDb,
  testDb,
} from "./helpers/db";
import { messages, scheduledJobs, suppressions } from "@/db/schema-sms";
import { rangeOf } from "@/lib/deliverability/range";

vi.mock("server-only", () => ({}));

const {
  burstFacts,
  carrierSuppressionFacts,
  destinationFacts,
  engagementFacts,
  numberFacts,
  openerBodies,
  optOutFacts,
  queueFacts,
  quietHoursFacts,
  skipHistogram,
  suppressionLeaks,
} = await import("@/lib/deliverability-server/queries");
const { outboundCountToday } = await import("@/lib/sms-server/daily-cap");

/**
 * Un jeudi d'août : Toronto est à UTC−4 (heure avancée de l'Est). Minuit local
 * du 27 tombe donc à 04:00 UTC — c'est ce décalage que le test de journée
 * exploite, et il serait faux en janvier.
 */
const NOW = new Date("2026-08-27T15:00:00Z");
const RANGE = rangeOf(7, NOW); // [2026-08-20T15:00Z, 2026-08-27T15:00Z)

const TORONTO = "America/Toronto";
/** Une heure LOCALE de Québec, convertie une seule fois et sans arithmétique à la main. */
const toronto = (local: string) => fromZonedTime(local, TORONTO);
const utc = (iso: string) => new Date(iso);

type MessageSeed = typeof messages.$inferInsert;

let sidCounter = 0;
/** `twilio_sid` est unique en base — et c'est LUI qui fait le dénominateur. */
function nextSid(): string {
  sidCounter += 1;
  return `SM${sidCounter.toString().padStart(32, "0")}`;
}

/** Un sortant réellement PARTI : sid présent, donc compté. */
function sent(
  conversationId: string,
  createdAt: Date,
  extra: Partial<MessageSeed> = {},
): MessageSeed {
  return {
    conversationId,
    direction: "out",
    body: "Bonjour, ici Alex du Groupe Nexus.",
    source: "agent",
    twilioSid: nextSid(),
    status: "delivered",
    segments: 1,
    encoding: "GSM-7",
    createdAt,
    ...extra,
  };
}

/** Un sortant qui n'a JAMAIS quitté la maison : pas de sid, donc pas de dénominateur. */
function neverLeft(
  conversationId: string,
  createdAt: Date,
  extra: Partial<MessageSeed> = {},
): MessageSeed {
  return {
    conversationId,
    direction: "out",
    body: "Bonjour, ici Alex du Groupe Nexus.",
    source: "agent",
    twilioSid: null,
    status: "skipped",
    segments: 1,
    encoding: "GSM-7",
    createdAt,
    ...extra,
  };
}

let numberA: string;
let numberB: string;

/** Un fil complet (fiche + conversation) sur le numéro demandé. */
async function thread(phone: string, smsNumberId?: string, fullName = "Client Test") {
  const client = await makeClient({ fullName, phone });
  const conversation = await makeConversation({
    clientId: client.id,
    clientPhone: phone,
    smsNumberId: smsNumberId ?? numberA,
  });
  return { clientId: client.id, conversationId: conversation.id, phone };
}

beforeEach(async () => {
  await resetDb();
  sidCounter = 0;
  // Deux numéros, ordonnés par E.164 : `numberFacts` trie dessus, et un test
  // qui lirait `[0]` sans le savoir passerait au hasard.
  numberA = (await makeSmsNumber({ e164: "+15815550001", label: "Ligne A", dailyCap: 200 })).id;
  numberB = (await makeSmsNumber({ e164: "+15815550002", label: "Ligne B", dailyCap: 50 })).id;
});

afterAll(async () => {
  await closeDb();
});

// ── Le dénominateur ─────────────────────────────────────────────────────────

describe("dénominateur — seul ce qui a atteint Twilio compte", () => {
  it("une rangée sans twilio_sid ne bouge NI le compte NI les statuts", async () => {
    const t = await thread("+14185550001");
    await testDb.insert(messages).values([
      sent(t.conversationId, utc("2026-08-22T12:00:00Z"), { status: "delivered", segments: 2 }),
      // Interrupteur d'arrêt : la rangée existe pour que le fil client montre
      // « non envoyé », mais rien n'est parti.
      neverLeft(t.conversationId, utc("2026-08-22T12:01:00Z"), { skipReason: "kill_switch" }),
      // Essai à blanc : `handleSendSms` écrit le statut `dry_run` et laisse le
      // sid vide. Même conclusion — rien n'a atteint le transporteur.
      neverLeft(t.conversationId, utc("2026-08-22T12:02:00Z"), {
        status: "dry_run",
        skipReason: null,
      }),
    ]);

    const [a] = await numberFacts(RANGE, NOW);
    expect(a.e164, "numberFacts trie par E.164").toBe("+15815550001");
    expect(a.messages, "seul le sortant parti entre dans le dénominateur").toBe(1);
    expect(a.segments, "les segments suivent le même dénominateur").toBe(2);
    expect(a.statusCounts, "un statut sans sid ne doit pas apparaître ici").toEqual({
      delivered: 1,
    });
  });

  it("un numéro sans le moindre trafic sort quand même, à zéro", async () => {
    // Le faire disparaître donnerait l'illusion qu'il n'existe pas — or un
    // numéro actif et muet est exactement ce qu'un exploitant veut repérer.
    const facts = await numberFacts(RANGE, NOW);
    expect(facts.map((f) => f.e164)).toEqual(["+15815550001", "+15815550002"]);
    expect(facts[1].messages).toBe(0);
    expect(facts[1].statusCounts).toEqual({});
    expect(facts[1].errors).toEqual([]);
    expect(facts[1].sentToday).toBe(0);
    expect(facts[1].dailyCap, "le plafond vient de la table, pas d'une constante").toBe(50);
  });

  it("un statut null est rangé sous « unknown » plutôt que jeté", async () => {
    // Sinon la somme des colonnes de l'histogramme ne fait plus le total, et un
    // histogramme qui ne ferme pas est un histogramme qui ment.
    const t = await thread("+14185550002");
    await testDb
      .insert(messages)
      .values([sent(t.conversationId, utc("2026-08-22T12:00:00Z"), { status: null })]);

    const [a] = await numberFacts(RANGE, NOW);
    expect(a.messages).toBe(1);
    expect(a.statusCounts).toEqual({ unknown: 1 });
  });

  it("les deux angles morts du 25 août : immobile depuis 1 h, sans accusé depuis 24 h", async () => {
    const t = await thread("+14185550003");
    await testDb.insert(messages).values([
      // `queued` depuis deux heures : la file ne l'a jamais débloqué.
      sent(t.conversationId, new Date(NOW.getTime() - 2 * 3600_000), { status: "queued" }),
      // `queued` depuis dix minutes : normal, ce n'est pas une panne.
      sent(t.conversationId, new Date(NOW.getTime() - 10 * 60_000), { status: "queued" }),
      // `sent` depuis deux jours : accepté par l'opérateur, jamais d'accusé —
      // c'est mot pour mot la panne des rappels de statut du 2026-08-25.
      sent(t.conversationId, new Date(NOW.getTime() - 48 * 3600_000), { status: "sent" }),
      sent(t.conversationId, new Date(NOW.getTime() - 2 * 3600_000), { status: "sent" }),
    ]);

    const [a] = await numberFacts(RANGE, NOW);
    expect(a.staleInFlight, "seul le `queued` de plus d'une heure est immobile").toBe(1);
    expect(a.noDlr, "seul le `sent` de plus de 24 h est sans accusé").toBe(1);
  });
});

// ── Ce qui n'est jamais parti ───────────────────────────────────────────────

describe("skipHistogram — l'autre dénominateur, gardé à part", () => {
  it("découpe la raison au PREMIER deux-points", async () => {
    const t = await thread("+14185550010");
    await testDb.insert(messages).values([
      // `handleSendSms` écrit `${reason}: ${message}` — le message de Twilio
      // porte des deux-points et des chiffres. Sans la découpe, chaque refus
      // formerait sa propre ligne et le tableau deviendrait illisible.
      neverLeft(t.conversationId, utc("2026-08-22T12:00:00Z"), {
        status: "failed",
        skipReason:
          "provider_rejected: twilio_send_failed http 400 The 'To' number +14185550010 is unsubscribed",
      }),
      neverLeft(t.conversationId, utc("2026-08-22T12:01:00Z"), {
        status: "failed",
        skipReason: "provider_rejected: twilio_send_failed http 400 autre chose",
      }),
      // Une raison sans deux-points doit ressortir entière.
      neverLeft(t.conversationId, utc("2026-08-22T12:02:00Z"), { skipReason: "kill_switch" }),
      // Hors période : ce qui n'est pas parti se compte aussi sur la fenêtre.
      neverLeft(t.conversationId, utc("2026-08-01T12:00:00Z"), { skipReason: "suppressed" }),
    ]);

    const rows = await skipHistogram(RANGE);
    expect(rows, "tri décroissant sur le compte, raisons repliées sur le préfixe").toEqual([
      { reason: "provider_rejected", messages: 2 },
      { reason: "kill_switch", messages: 1 },
    ]);
  });

  it("un essai à blanc apparaît dans le tableau de ce qui n'est jamais parti", async () => {
    // ⚠️ CE TEST ÉCHOUE AUJOURD'HUI — c'est voulu, et voici la démonstration.
    //
    // `handleSendSms` traite l'essai à blanc à part : il n'écrit PAS de
    // `skip_reason`, il pose le statut `dry_run` et laisse le sid vide (voir
    // `if (!result.sent && result.skippedReason !== "dry_run")`). Or
    // `skipHistogram` ne lit que les rangées dont `skip_reason` est non nul, et
    // `statusHistogram` exige un sid : une rangée d'essai à blanc n'est donc
    // comptée NULLE PART sur cet écran.
    //
    // Que c'est bien un oubli et non une décision : `messages/fr/admin.json`
    // porte la clé `deliverability.skipped.r.dry_run` = « Essai à blanc », un
    // libellé qui ne peut jamais s'afficher. Et `status-classes.ts` range
    // `dry_run` dans le seau `never_left`, seau qu'aucune requête n'alimente.
    const t = await thread("+14185550011");
    await testDb.insert(messages).values([
      neverLeft(t.conversationId, utc("2026-08-22T12:00:00Z"), {
        status: "dry_run",
        skipReason: null,
      }),
    ]);

    const rows = await skipHistogram(RANGE);
    expect(
      rows,
      "Un essai à blanc doit se lire dans « Ce qui n'est jamais parti » : sinon le mode " +
        "essai efface silencieusement tout le trafic de l'écran de conformité.",
    ).toEqual([{ reason: "dry_run", messages: 1 }]);
  });
});

// ── Désabonnements ──────────────────────────────────────────────────────────

describe("optOutFacts — un STOP ne compte que si on a écrit à ce numéro", () => {
  it("le STOP d'un téléphone jamais texté dans la fenêtre ne compte pas", async () => {
    const joint = await thread("+14185550101"); // texté ET désabonné dans la fenêtre
    const horsFenetre = await thread("+14185550102"); // désabonné, mais texté avant
    const vieuxStop = await thread("+14185550103"); // texté, désabonné avant la fenêtre
    const erreur = await thread("+14185550104"); // texté, supprimé par l'opérateur

    await testDb.insert(messages).values([
      sent(joint.conversationId, utc("2026-08-22T12:00:00Z")),
      // AVANT la borne basse : ce fil n'a pas été joint sur la période.
      sent(horsFenetre.conversationId, utc("2026-08-10T12:00:00Z")),
      sent(vieuxStop.conversationId, utc("2026-08-22T12:00:00Z")),
      sent(erreur.conversationId, utc("2026-08-22T12:00:00Z")),
    ]);
    await testDb.insert(suppressions).values([
      { phoneE164: joint.phone, reason: "sms_stop", createdAt: utc("2026-08-22T13:00:00Z") },
      { phoneE164: horsFenetre.phone, reason: "sms_stop", createdAt: utc("2026-08-22T13:00:00Z") },
      // Un STOP antérieur à la fenêtre appartient à la période précédente.
      { phoneE164: vieuxStop.phone, reason: "sms_stop", createdAt: utc("2026-08-10T13:00:00Z") },
      // Une suppression pour échec transporteur n'est PAS un désabonnement :
      // les additionner ferait passer un combiné injoignable pour un refus.
      {
        phoneE164: erreur.phone,
        reason: "carrier_error",
        note: "code 30003",
        createdAt: utc("2026-08-22T13:00:00Z"),
      },
    ]);

    const out = await optOutFacts(RANGE);
    expect(out.stopped, "un seul STOP porte sur un téléphone joint dans la fenêtre").toBe(1);
    // Le dénominateur est le nombre de TÉLÉPHONES joints, pas de messages : un
    // taux rapporté aux messages baisserait quand on écrit plus.
    expect(out.reached, "trois fils ont reçu un sortant parti dans la fenêtre").toBe(3);
  });

  it("les suppressions d'opérateur se lisent à part, avec le 30003 isolé", async () => {
    await testDb.insert(suppressions).values([
      {
        phoneE164: "+14185550111",
        reason: "carrier_error",
        note: "code 30003",
        createdAt: utc("2026-08-22T13:00:00Z"),
      },
      { phoneE164: "+14185550112", reason: "carrier_error", createdAt: utc("2026-08-22T13:00:00Z") },
      // Un STOP n'est pas une suppression d'opérateur.
      { phoneE164: "+14185550113", reason: "sms_stop", createdAt: utc("2026-08-22T13:00:00Z") },
      // Hors fenêtre.
      { phoneE164: "+14185550114", reason: "carrier_error", createdAt: utc("2026-08-01T13:00:00Z") },
    ]);

    const carrier = await carrierSuppressionFacts(RANGE);
    expect(carrier.total).toBe(2);
    expect(carrier.code30003, "le 30003 se compte sur la note, pas sur la raison").toBe(1);
  });
});

// ── Fuite de suppression ────────────────────────────────────────────────────

describe("suppressionLeaks — la grâce d'UN seul tour de clôture", () => {
  it("laisse passer le PREMIER message dans les 5 minutes, signale le second", async () => {
    // La règle la plus délicate du fichier. `rn` est un `row_number()` calculé
    // APRÈS le filtre : il numérote les sortants postérieurs à la suppression,
    // pas les messages du fil depuis sa création. Le premier a droit à la
    // politesse de clôture (CTIA §5.1.3) ; le second n'a plus d'excuse.
    const t = await thread("+14185550201");
    const stopAt = utc("2026-08-22T12:00:00Z");
    await testDb
      .insert(suppressions)
      .values([{ phoneE164: t.phone, reason: "sms_stop", createdAt: stopAt }]);

    const [avant, cloture, faute] = await testDb
      .insert(messages)
      .values([
        // Avant le STOP : parfaitement légitime, jamais une fuite.
        sent(t.conversationId, new Date(stopAt.getTime() - 60_000), { body: "Avant le STOP" }),
        // 2 min après : le tour de clôture permis.
        sent(t.conversationId, new Date(stopAt.getTime() + 120_000), { body: "Bonne journée !" }),
        // 4 min après : dans les 5 minutes, mais ce n'est plus le premier.
        sent(t.conversationId, new Date(stopAt.getTime() + 240_000), { body: "Encore une chose" }),
      ])
      .returning();

    const leaks = await suppressionLeaks(RANGE);
    expect(leaks.total, "exactement un message fautif").toBe(1);
    expect(leaks.samples).toHaveLength(1);
    expect(leaks.samples[0].messageId, "le SECOND message est le fautif").toBe(faute.id);
    expect(
      leaks.samples.map((s) => s.messageId),
      "ni le message d'avant le STOP, ni le tour de clôture ne sont des fuites",
    ).not.toContain(cloture.id);
    expect(leaks.samples.map((s) => s.messageId)).not.toContain(avant.id);
    expect(leaks.samples[0].clientPhone).toBe(t.phone);
    expect(leaks.samples[0].suppressedAt.toISOString()).toBe(stopAt.toISOString());
    expect(leaks.samples[0].excerpt, "l'extrait est le corps tronqué à 160").toBe("Encore une chose");
  });

  it("un premier message plus de 5 minutes après le STOP n'a AUCUNE grâce", async () => {
    // La grâce est une fenêtre de clôture, pas un droit permanent au premier
    // message : sans la borne des 300 secondes, une relance envoyée le
    // lendemain passerait pour une politesse.
    const t = await thread("+14185550202");
    const stopAt = utc("2026-08-22T12:00:00Z");
    await testDb
      .insert(suppressions)
      .values([{ phoneE164: t.phone, reason: "sms_stop", createdAt: stopAt }]);
    const [tardif] = await testDb
      .insert(messages)
      .values([sent(t.conversationId, new Date(stopAt.getTime() + 301_000))])
      .returning();

    const leaks = await suppressionLeaks(RANGE);
    expect(leaks.total).toBe(1);
    expect(leaks.samples[0].messageId).toBe(tardif.id);
  });

  it("une rangée sans twilio_sid n'est pas une fuite : elle n'est jamais partie", async () => {
    const t = await thread("+14185550203");
    const stopAt = utc("2026-08-22T12:00:00Z");
    await testDb
      .insert(suppressions)
      .values([{ phoneE164: t.phone, reason: "sms_stop", createdAt: stopAt }]);
    await testDb.insert(messages).values([
      // Bloquée par le fournisseur au motif « suppressed » : c'est le garde-fou
      // qui a fonctionné. La compter comme fuite accuserait le code qui protège.
      neverLeft(t.conversationId, new Date(stopAt.getTime() + 600_000), {
        skipReason: "suppressed",
      }),
    ]);

    const leaks = await suppressionLeaks(RANGE);
    expect(leaks.total).toBe(0);
    expect(leaks.samples).toEqual([]);
  });
});

// ── Le compteur du plafond quotidien ────────────────────────────────────────

describe("sentToday — la MÊME définition que l'exécutant du plafond", () => {
  it("reproduit outboundCountToday à la rangée, sur les deux numéros", async () => {
    const a = await thread("+14185550301", numberA);
    const b = await thread("+14185550302", numberB);
    // Minuit à Toronto le 27 août = 2026-08-27T04:00Z ; tout ceci est APRÈS.
    const matin = toronto("2026-08-27T09:00:00");
    await testDb.insert(messages).values([
      sent(a.conversationId, matin, { status: "delivered" }),
      sent(a.conversationId, matin, { status: "queued" }),
      sent(a.conversationId, matin, { status: "failed" }),
      // `undelivered` compte aussi : il a quitté la maison, il est facturé.
      sent(a.conversationId, matin, { status: "undelivered" }),
      // Sans sid, mais avec un statut compté : le plafond compte ce qui est
      // PARTI selon la liste `COUNTED`, pas selon le sid. Les deux lecteurs
      // doivent tomber d'accord même sur ce cas-là.
      neverLeft(a.conversationId, matin, { status: "queued", skipReason: null }),
      // Statut hors liste : ni le plafond ni le tableau ne le comptent.
      neverLeft(a.conversationId, matin, { status: "skipped", skipReason: "kill_switch" }),
      // Un entrant n'est pas un envoi.
      {
        conversationId: a.conversationId,
        direction: "in",
        body: "STOP",
        source: "human",
        status: "received",
        createdAt: matin,
      },
      sent(b.conversationId, matin, { status: "sent" }),
    ]);

    const facts = await numberFacts(RANGE, NOW);
    const byId = new Map(facts.map((f) => [f.smsNumberId, f]));
    for (const [id, label] of [
      [numberA, "Ligne A"],
      [numberB, "Ligne B"],
    ] as const) {
      // L'attendu n'est PAS écrit à la main : c'est la fonction que
      // `handleSendSms` interroge pour reporter au lendemain. Deux définitions
      // de « aujourd'hui » qui divergent, et l'écran promet de la marge là où
      // l'envoi refuse déjà.
      const expected = await outboundCountToday(id, NOW);
      expect(byId.get(id)?.sentToday, `${label} : le tableau compte comme l'exécutant`).toBe(
        expected,
      );
    }
    expect(byId.get(numberA)?.sentToday, "cinq statuts comptés sur la ligne A").toBe(5);
    expect(byId.get(numberB)?.sentToday).toBe(1);
  });

  it("03:30 UTC appartient à la journée de Toronto PRÉCÉDENTE", async () => {
    // 03:30 UTC le 27 = 23:30 le 26 à Québec. Compter par tranche UTC ferait
    // basculer le plafond à 20 h le soir, en pleine plage d'envoi.
    const a = await thread("+14185550303", numberA);
    await testDb
      .insert(messages)
      .values([sent(a.conversationId, utc("2026-08-27T03:30:00Z"), { status: "delivered" })]);

    const facts = await numberFacts(RANGE, NOW);
    const ligneA = facts.find((f) => f.smsNumberId === numberA);
    expect(ligneA?.sentToday, "hier soir à Québec ne consomme pas le plafond d'aujourd'hui").toBe(0);
    expect(await outboundCountToday(numberA, NOW)).toBe(0);
    // La veille, le même message compte : la rangée existe, c'est bien le
    // fuseau qui la range et non un filtre de période.
    expect(await outboundCountToday(numberA, utc("2026-08-26T15:00:00Z"))).toBe(1);
    expect(ligneA?.messages, "il reste dans la période observée").toBe(1);
  });
});

// ── Encodage ────────────────────────────────────────────────────────────────

describe("ucs2Messages — le littéral exact 'UCS-2'", () => {
  it("ne compte que 'UCS-2', ni 'ucs-2' ni 'UCS2'", async () => {
    // `analyzeSms` écrit exactement « UCS-2 ». Une comparaison tolérante ici
    // masquerait le jour où un autre chemin d'écriture inventerait sa graphie —
    // et le coût par segment double en UCS-2, c'est un chiffre d'argent.
    const t = await thread("+14185550401");
    await testDb.insert(messages).values([
      sent(t.conversationId, utc("2026-08-22T12:00:00Z"), { encoding: "UCS-2" }),
      sent(t.conversationId, utc("2026-08-22T12:01:00Z"), { encoding: "ucs-2" }),
      sent(t.conversationId, utc("2026-08-22T12:02:00Z"), { encoding: "UCS2" }),
      sent(t.conversationId, utc("2026-08-22T12:03:00Z"), { encoding: "GSM-7" }),
      sent(t.conversationId, utc("2026-08-22T12:04:00Z"), { encoding: null }),
    ]);

    const [a] = await numberFacts(RANGE, NOW);
    expect(a.messages).toBe(5);
    expect(a.ucs2Messages, "seul le littéral exact compte").toBe(1);
  });
});

// ── Heures de politesse ─────────────────────────────────────────────────────

describe("quietHoursFacts — compté à Toronto, et sans les humains", () => {
  it("02:00 est une infraction, 14:00 non, et un envoi humain ne compte pas", async () => {
    // Un téléphoniste qui répond à 2 h répond à quelqu'un qui vient d'écrire :
    // l'inclure ferait clignoter l'écran sur le seul comportement légitime hors
    // fenêtre, et l'exploitant cesserait de le lire.
    const t = await thread("+14185550501");
    await testDb.insert(messages).values([
      sent(t.conversationId, toronto("2026-08-25T02:00:00"), { source: "agent" }),
      sent(t.conversationId, toronto("2026-08-25T14:00:00"), { source: "ladder" }),
      sent(t.conversationId, toronto("2026-08-25T02:30:00"), { source: "human" }),
    ]);

    const quiet = await quietHoursFacts(RANGE);
    expect(quiet.automated, "les deux envois automatisés, l'humain exclu").toBe(2);
    expect(quiet.violations, "seul le 02:00 automatisé est hors fenêtre").toBe(1);
  });
});

// ── Destinations ────────────────────────────────────────────────────────────

describe("destinationFacts — l'inscription A2P se déclenche sur la DESTINATION", () => {
  it("un +1418 est canadien, un +1212 part aux États-Unis", async () => {
    // Un seul mobile américain change la question posée à l'opérateur, et rien
    // d'autre dans ce dépôt ne le dirait à l'exploitant.
    const quebec = await thread("+14185550601");
    const newYork = await thread("+12125550602");
    const jamaisParti = await thread("+14385550603");
    await testDb.insert(messages).values([
      sent(quebec.conversationId, utc("2026-08-22T12:00:00Z")),
      // Deux messages au même téléphone : le compte porte sur les téléphones
      // DISTINCTS, sinon un fil bavard pèserait comme dix destinataires.
      sent(newYork.conversationId, utc("2026-08-22T12:01:00Z")),
      sent(newYork.conversationId, utc("2026-08-22T12:02:00Z")),
      neverLeft(jamaisParti.conversationId, utc("2026-08-22T12:03:00Z"), {
        skipReason: "kill_switch",
      }),
    ]);

    const dest = await destinationFacts(RANGE);
    expect(dest.total, "deux téléphones réellement joints").toBe(2);
    expect(dest.usBound).toBe(1);
  });
});

// ── Forme du trafic ─────────────────────────────────────────────────────────

describe("burstFacts — la forme du trafic, pas son volume", () => {
  it("médiane, p99 et pointe se lisent par MINUTE de segments", async () => {
    // Un envoi régulier et un envoi en rafale peuvent avoir le même total du
    // jour et une réputation opposée : c'est le rapport p99/médiane qui les
    // sépare. Semence : trois minutes à 1, 2 et 10 segments.
    const t = await thread("+14185550701");
    await testDb.insert(messages).values([
      sent(t.conversationId, utc("2026-08-22T10:00:00Z"), { segments: 1 }),
      sent(t.conversationId, utc("2026-08-22T10:01:00Z"), { segments: 1 }),
      sent(t.conversationId, utc("2026-08-22T10:01:30Z"), { segments: 1 }),
      sent(t.conversationId, utc("2026-08-22T10:02:00Z"), { segments: 10 }),
      // Une minute dont la somme de segments est nulle est écartée : elle
      // tirerait la médiane vers zéro et ferait disparaître la rafale.
      sent(t.conversationId, utc("2026-08-22T10:03:00Z"), { segments: null }),
    ]);

    const burst = await burstFacts(RANGE);
    expect(burst.minutes, "trois minutes portent des segments").toBe(3);
    expect(burst.medianSegments).toBe(2);
    // percentile_cont interpole : 2 + 0,98 × (10 − 2).
    expect(burst.p99Segments).toBeCloseTo(9.84, 5);
    expect(burst.peakSegments).toBe(10);
  });

  it("une base sans le moindre envoi rend des zéros, jamais null ni NaN", async () => {
    const burst = await burstFacts(RANGE);
    expect(burst).toEqual({ medianSegments: 0, p99Segments: 0, peakSegments: 0, minutes: 0 });
  });
});

// ── Engagement ──────────────────────────────────────────────────────────────

describe("engagementFacts — le contrepoids du volume", () => {
  it("compte l'atteinte, la réponse et les fils où l'on parle tout seul", async () => {
    const muet = await thread("+14185550801"); // 4 sortants, 0 réponse
    const vivant = await thread("+14185550802"); // 2 sortants, 1 réponse
    const bloque = await thread("+14185550803"); // rien n'est parti
    const base = utc("2026-08-22T10:00:00Z");
    const plus = (min: number) => new Date(base.getTime() + min * 60_000);

    await testDb.insert(messages).values([
      sent(muet.conversationId, plus(0)),
      sent(muet.conversationId, plus(1)),
      sent(muet.conversationId, plus(2)),
      sent(muet.conversationId, plus(3)),
      sent(vivant.conversationId, plus(0)),
      sent(vivant.conversationId, plus(1)),
      {
        conversationId: vivant.conversationId,
        direction: "in",
        body: "Oui, ça m'intéresse",
        source: "human",
        status: "received",
        createdAt: plus(5),
      },
      neverLeft(bloque.conversationId, plus(0), { skipReason: "kill_switch" }),
    ]);

    const e = await engagementFacts(RANGE);
    expect(e.outbound, "six sortants réellement partis").toBe(6);
    expect(e.conversationsReached, "le fil bloqué n'a jamais été joint").toBe(2);
    expect(e.inbound).toBe(1);
    expect(e.conversationsReplied).toBe(1);
    // Quatre sortants sans un mot en retour : c'est le profil que les
    // opérateurs lisent comme du démarchage à froid. Le fil bloqué n'y entre
    // pas — ses sortants ne sont jamais partis.
    expect(e.unansweredTail).toBe(1);
  });
});

// ── État de la file ─────────────────────────────────────────────────────────

describe("queueFacts — l'arriéré du répartiteur", () => {
  it("ne compte que les envois SMS en attente dont l'heure est passée", async () => {
    // Un job programmé pour plus tard n'est pas un arriéré : le compter ferait
    // paraître en panne une file qui fonctionne, et le vrai retard s'y noierait.
    await testDb.insert(scheduledJobs).values([
      {
        type: "send_sms",
        status: "pending",
        runAt: new Date(NOW.getTime() - 10 * 60_000),
        payload: {},
      },
      {
        type: "send_sms",
        status: "pending",
        runAt: new Date(NOW.getTime() - 60 * 60_000),
        payload: {},
      },
      {
        type: "send_sms",
        status: "pending",
        runAt: new Date(NOW.getTime() + 10 * 60_000),
        payload: {},
      },
      {
        type: "send_sms",
        status: "done",
        runAt: new Date(NOW.getTime() - 30 * 60_000),
        payload: {},
      },
      {
        type: "agent_turn",
        status: "pending",
        runAt: new Date(NOW.getTime() - 30 * 60_000),
        payload: {},
      },
    ]);

    const queue = await queueFacts(NOW);
    expect(queue.backlog).toBe(2);
    // Une vraie `Date`, pas la chaîne brute du pilote : le type annoncé est
    // `Date | null` et le premier `.getTime()` en aval doit fonctionner. Le
    // client Drizzle désactive le lecteur de dates de postgres.js, donc une
    // agrégation écrite à la main revient en chaîne si personne ne la décode.
    expect(queue.oldestPendingAt, "le plus vieux job en attente est une Date").toBeInstanceOf(Date);
    expect(queue.oldestPendingAt?.toISOString()).toBe(
      new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    );
  });

  it("une file vide rend 0 et null, jamais une date inventée", async () => {
    const queue = await queueFacts(NOW);
    expect(queue).toEqual({ backlog: 0, oldestPendingAt: null });
  });
});

// ── Les premiers messages d'un fil ──────────────────────────────────────────

describe("openerBodies — une ligne par fil, la PREMIÈRE", () => {
  it("rend le premier sortant parti de chaque fil, et une vraie Date", async () => {
    // L'obligation de s'identifier et d'indiquer comment arrêter porte sur le
    // premier message d'un fil, pas sur chaque réplique : `distinct on` doit
    // donc prendre le PLUS ANCIEN, pas le dernier écrit.
    //
    // Et `createdAt` doit être une `Date` : `collectFacts` appelle
    // `.toISOString()` dessus pour étiqueter la pièce à conviction. Une chaîne
    // fait tomber toute la page de conformité, et seulement le jour où une
    // ouverture oublie la mention d'arrêt — donc jamais en essai.
    const a = await thread("+14185550901");
    const b = await thread("+14185550902");
    await testDb.insert(messages).values([
      sent(a.conversationId, utc("2026-08-22T10:05:00Z"), { body: "Deuxième", source: "agent" }),
      sent(a.conversationId, utc("2026-08-22T10:00:00Z"), { body: "Première", source: "opener" }),
      sent(b.conversationId, utc("2026-08-23T10:00:00Z"), { body: "Autre fil", source: "opener" }),
      // Jamais partie : ce n'est pas une ouverture, personne ne l'a lue.
      neverLeft(b.conversationId, utc("2026-08-23T09:00:00Z"), { skipReason: "kill_switch" }),
    ]);

    const { rows: openers, truncated } = await openerBodies(RANGE);
    expect(truncated, "deux fils ne dépassent aucun plafond").toBe(false);
    expect(openers).toHaveLength(2);
    const bodies = openers.map((o) => o.body).sort();
    expect(bodies, "un seul corps par fil, le plus ancien PARTI").toEqual([
      "Autre fil",
      "Première",
    ]);
    for (const opener of openers) {
      expect(opener.createdAt, "createdAt doit être une Date, pas la chaîne du pilote").toBeInstanceOf(
        Date,
      );
      expect(Number.isNaN(opener.createdAt.getTime())).toBe(false);
    }
    const premiere = openers.find((o) => o.body === "Première");
    expect(premiere?.createdAt.toISOString()).toBe("2026-08-22T10:00:00.000Z");
    expect(premiere?.clientId).toBe(a.clientId);
  });
});

// ── Régressions de revue ────────────────────────────────────────────────────

/**
 * Deux mensonges rassurants, trouvés en revue adverse et épinglés ici parce
 * qu'ils ne se voient QUE contre un vrai Postgres : les deux naissent de la
 * frontière de la fenêtre, que rien en TypeScript ne peut simuler.
 */
describe("régressions — la frontière de la fenêtre", () => {
  it("l'ouverture est le premier message du FIL, pas le premier de la fenêtre", async () => {
    // Le fil est ouvert AVANT la fenêtre, avec une ouverture conforme. Dedans,
    // il ne reste qu'une réplique d'agent — qui ne contient évidemment ni
    // marque ni mention d'arrêt.
    //
    // Sans la garde `not exists`, cette réplique passait pour l'ouverture du
    // fil : sur une fenêtre de sept jours, où la plupart des fils actifs sont
    // plus vieux que ça, PRESQUE CHAQUE conversation devenait une ouverture
    // non conforme. Un constat entièrement faux, sur l'obligation légale la
    // plus sérieuse de l'écran.
    const t = await thread("+14185550301");
    await testDb.insert(messages).values([
      sent(t.conversationId, utc("2026-08-10T12:00:00Z"), {
        body: "Bonjour, ici Alex du Groupe Nexus. Repondez STOP pour vous desabonner.",
      }),
      sent(t.conversationId, utc("2026-08-24T12:00:00Z"), { body: "Parfait, mardi 14 h." }),
    ]);

    const { rows } = await openerBodies(RANGE);
    expect(
      rows.filter((r) => r.conversationId === t.conversationId),
      "un fil ouvert avant la fenêtre n'a pas d'ouverture DANS la fenêtre",
    ).toEqual([]);
  });

  it("le taux de réponse ne compte que des fils réellement texté dans la fenêtre", async () => {
    // Un fil ouvert la semaine d'avant qui répond aujourd'hui comptait comme
    // une réponse sans jamais compter comme un envoi : le taux montait tout
    // seul. Et il monte toujours du MAUVAIS côté — il n'alarme jamais à tort,
    // il étouffe une vraie alerte.
    const inWindow = await thread("+14185550302");
    const outsideWindow = await thread("+14185550303");
    await testDb.insert(messages).values([
      sent(inWindow.conversationId, utc("2026-08-24T12:00:00Z")),
      {
        conversationId: inWindow.conversationId,
        direction: "in",
        body: "oui",
        source: "human",
        status: "received",
        createdAt: utc("2026-08-24T13:00:00Z"),
      },
      // Sorti AVANT la fenêtre, réponse DEDANS : ne doit compter ni au
      // numérateur ni au dénominateur.
      sent(outsideWindow.conversationId, utc("2026-08-10T12:00:00Z")),
      {
        conversationId: outsideWindow.conversationId,
        direction: "in",
        body: "oui aussi",
        source: "human",
        status: "received",
        createdAt: utc("2026-08-25T13:00:00Z"),
      },
    ]);

    const facts = await engagementFacts(RANGE);
    expect(facts.conversationsReached, "un seul fil texté dans la fenêtre").toBe(1);
    expect(
      facts.conversationsReplied,
      "le numérateur doit être un SOUS-ENSEMBLE du dénominateur",
    ).toBe(1);
    expect(facts.conversationsReplied).toBeLessThanOrEqual(facts.conversationsReached);
    // Les entrants bruts, eux, comptent tout : c'est `out_per_in` qui les lit.
    expect(facts.inbound).toBe(2);
  });
});
