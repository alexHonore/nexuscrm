/**
 * Unitaire — rendu du fil SMS et de la boîte de réception.
 *
 * Ce que ces écrans DOIVENT dire sans qu'on clique : qui parle, ce qui n'est
 * pas parti, qui a la main, et si le moteur envoie vraiment. Le typage ne voit
 * rien de tout ça.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_LOOK } from "@/components/look";
import conversationsFr from "../messages/fr/conversations.json";
import commonFr from "../messages/fr/common.json";
import type { SmsThreadData } from "@/components/clients/sms-thread-card";
import type { EngineHealth, InboxRow } from "@/components/conversations/conversations-inbox";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// Les composants importent les actions serveur ; les simuler évite d'entraîner
// toute la couche base dans un test de rendu.
vi.mock("@/app/(app)/conversations/actions", () => ({
  assignAssistantAction: vi.fn(),
  cancelQueuedSmsAction: vi.fn(),
  cancelOutboundSmsAction: vi.fn(),
  sendManualSmsAction: vi.fn(),
  setConversationAiAction: vi.fn(),
  markConversationHandledAction: vi.fn(),
  assignConversationAction: vi.fn(),
  handBackToAiAction: vi.fn(),
  retryAiTurnAction: vi.fn(),
}));

const { SmsThreadCard } = await import("@/components/clients/sms-thread-card");
const { ConversationsInbox } = await import("@/components/conversations/conversations-inbox");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function wrap(element: React.ReactElement): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { conversations: conversationsFr, common: commonFr } as unknown as IntlMessages,
      children: element,
    }),
  );
}

const THREAD: SmsThreadData = {
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  clientName: "Marie Tremblay",
  clientPhone: "+14185551234",
  aiEnabled: true,
  pausedByName: null,
  pausedAt: null,
  pauseReason: null,
  needsAttention: false,
  attentionReason: null,
  suppressed: false,
  assistant: { currentId: null, currentName: null, options: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acheteur FB" }] },
  queued: [],
  hasActiveNumber: true,
  messages: [
    {
      id: "m1",
      direction: "out",
      body: "Bonjour, ici Groupe Nexus. Toujours un projet?",
      createdAt: "2026-08-21T14:00:00.000Z",
      status: "delivered",
      errorCode: null,
      skipReason: null,
      source: "opener",
      aiGenerated: false,
      sentByName: null,
    },
    {
      id: "m2",
      direction: "in",
      body: "Oui, mais pas avant l'automne",
      createdAt: "2026-08-21T14:20:00.000Z",
      status: "received",
      errorCode: null,
      skipReason: null,
      source: "human",
      aiGenerated: false,
      sentByName: null,
    },
    {
      id: "m3",
      direction: "out",
      body: "Parfait, je vous relance en septembre.",
      createdAt: "2026-08-21T14:22:00.000Z",
      status: "failed",
      errorCode: 30007,
      skipReason: null,
      source: "agent",
      aiGenerated: true,
      sentByName: null,
    },
    {
      id: "m4",
      direction: "out",
      body: "Je prends la suite, ici Alex.",
      createdAt: "2026-08-21T15:00:00.000Z",
      status: "sent",
      errorCode: null,
      skipReason: null,
      source: "human",
      aiGenerated: false,
      sentByName: "Alex-Honoré",
    },
  ],
};

const HEALTH: EngineHealth = {
  killSwitch: false,
  mode: "live",
  sendWindowOpen: true,
  queued: 3,
  failed: 0,
  suppressed: 12,
};

const ROWS: InboxRow[] = [
  {
    id: "c1",
    clientId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    clientName: "Marie Tremblay",
    clientPhone: "+14185551234",
    needsAttention: true,
    attentionReason: "handoff",
    aiEnabled: false,
    assignedToId: null,
    assignedToName: null,
    assistantName: null,
    lastBody: "Je préfère parler à quelqu'un",
    lastDirection: "in",
    lastSource: "human",
    lastAt: "2026-08-21T15:00:00.000Z",
  },
  {
    id: "c2",
    clientId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    clientName: "Jean Roy",
    clientPhone: "+14185555678",
    needsAttention: false,
    attentionReason: null,
    aiEnabled: true,
    assignedToId: "me",
    assignedToName: "Moi",
    assistantName: "Acheteur FB",
    lastBody: "Merci!",
    lastDirection: "out",
    lastSource: "agent",
    lastAt: "2026-08-21T12:00:00.000Z",
  },
];

/** Une panne de modèle : mêle « réparer » à « répondre » dans l'onglet à traiter. */
const ENGINE_ROW: InboxRow = {
  id: "c3",
  clientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  clientName: "Nathalie Côté",
  clientPhone: "+14185559999",
  needsAttention: true,
  attentionReason: "llm_error",
  aiEnabled: true,
  assignedToId: null,
  assignedToName: null,
  assistantName: "Acheteur FB",
  lastBody: "C'est quoi vos frais?",
  lastDirection: "in",
  lastSource: "human",
  lastAt: "2026-08-21T10:00:00.000Z",
};

/** Un fil clos : le verdict est rendu, il ne compte JAMAIS dans « à traiter ». */
const FINISHED_ROW: InboxRow = {
  id: "c4",
  clientId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  clientName: "Julie Desrosiers",
  clientPhone: "+14185558888",
  needsAttention: true,
  attentionReason: "closed_goal_reached",
  aiEnabled: false,
  assignedToId: null,
  assignedToName: null,
  assistantName: "Acheteur FB",
  lastBody: "Parfait pour mardi 10h!",
  lastDirection: "in",
  lastSource: "human",
  lastAt: "2026-08-21T09:00:00.000Z",
};

/** Un refus explicite : sa vue à lui, jamais dans « à traiter ». */
const REFUSED_ROW: InboxRow = {
  ...FINISHED_ROW,
  id: "c5",
  clientId: "abababab-abab-4bab-8bab-abababababab",
  clientName: "Robert Bouchard",
  attentionReason: "hard_refusal",
  lastBody: "Non merci, plus jamais.",
};

/** Un fil qu'un humain tient (IA en pause, rien d'urgent). */
const HELD_ROW: InboxRow = {
  id: "c6",
  clientId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
  clientName: "François Pelletier",
  clientPhone: "+14185557777",
  needsAttention: false,
  attentionReason: null,
  aiEnabled: false,
  assignedToId: "me",
  assignedToName: "Moi",
  assistantName: "Acheteur FB",
  lastBody: "Je vous appelle demain.",
  lastDirection: "out",
  lastSource: "human",
  lastAt: "2026-08-21T11:00:00.000Z",
};

describe("fil SMS", () => {
  it("dit QUI parle pour chaque message", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    // Une ouverture de campagne, une réponse d'assistant et un message tapé par
    // un collègue se ressemblent : les confondre fait répondre par-dessus une
    // machine, ou croire qu'un humain a déjà traité le fil.
    expect(html).toContain("Ouverture de campagne");
    expect(html).toContain("Assistant");
    expect(html).toContain("Alex-Honoré");
  });

  it("un envoi en ÉCHEC se voit, avec son code", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    expect(html).toContain("Échec");
    expect(html).toContain("30007");
  });

  it("un fil en pause affiche la bannière de prise de contrôle", () => {
    const paused = {
      ...THREAD,
      aiEnabled: false,
      pausedByName: "Alex-Honoré",
      pausedAt: "2026-08-21T15:05:00.000Z",
    };
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: paused }));
    expect(html).toContain("Vous avez le contr");
    expect(html).toContain("Alex-Honor");
    // Et le bouton propose de rendre la main, pas de reprendre le contrôle.
    expect(html).toContain("Rendre la main");
  });

  it("un numéro désabonné bloque la rédaction et le dit", () => {
    const html = wrap(
      createElement(SmsThreadCard, { clientId: "x", thread: { ...THREAD, suppressed: true } }),
    );
    expect(html).toContain("désabonn");
    expect(html).toContain("disabled");
  });

  it("sans numéro actif, l'écran l'explique au lieu d'un fil vide", () => {
    const html = wrap(
      createElement(SmsThreadCard, {
        clientId: "x",
        thread: { ...THREAD, messages: [], hasActiveNumber: false },
      }),
    );
    expect(html).toContain("Aucun num");
  });

  it("un fil « à traiter » propose de le marquer traité", () => {
    const html = wrap(
      createElement(SmsThreadCard, {
        clientId: "x",
        thread: { ...THREAD, needsAttention: true, attentionReason: "inbound" },
      }),
    );
    expect(html).toContain("Nouveau message");
    expect(html).toContain("Marquer trait");
  });

  it("le DESTINATAIRE est affiché au-dessus de la zone de rédaction", () => {
    // C'est ce qui distingue le plus sûrement une note interne (aucun
    // destinataire) d'un SMS (quelqu'un le reçoit). Les deux cartes vivent
    // l'une sous l'autre.
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    expect(html).toContain("part par SMS");
    expect(html).toContain("Marie Tremblay");
    expect(html).toContain("418");
  });

  it("la carte SMS ne ressemble PAS à ses voisines", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    // Le signal doit être perçu du coin de l'œil, pas lu : une note envoyée
    // par erreur à un client ne se rattrape pas.
    //
    // La couleur PRIMAIRE ne peut pas jouer ce rôle — c'est celle de tous les
    // boutons de l'application. Il faut une couleur de CANAL, réservée.
    expect(html).toContain(CHANNEL_LOOK.sms.color);
    expect(html).not.toContain("border-primary/40");
    // Un liseré épais à gauche : le signal le moins cher et le plus immédiat.
    expect(html).toContain("border-l-4");
  });

  it("le numéro du destinataire se lit dans l'EN-TÊTE, pas seulement près du champ", () => {
    // Savoir à qui on parle ne doit pas demander de faire défiler la carte.
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    // Avant la zone de saisie, donc dans l'en-tête.
    const composerAt = html.indexOf("Votre message");
    expect(composerAt).toBeGreaterThan(0);
    expect(html.slice(0, composerAt)).toContain("418");
  });

  it("un message ENCORE EN FILE peut être annulé", () => {
    const queued = {
      ...THREAD,
      messages: [
        {
          id: "m9", direction: "out" as const, body: "Envoi imminent",
          createdAt: "2026-08-21T15:00:00.000Z", status: "queued",
          errorCode: null, skipReason: null, source: "human", aiGenerated: false, sentByName: "Alex",
        },
      ],
    };
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: queued }));
    expect(html).toContain("Annuler l&#x27;envoi");
  });

  it("un message DÉJÀ LIVRÉ n'offre pas d'annulation", () => {
    // Un SMS remis à l'opérateur ne se rappelle pas : offrir le bouton serait
    // pire que ne rien offrir, parce que quelqu'un s'y fierait.
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    expect(html).not.toContain("Annuler l&#x27;envoi");
  });

  it("aucune clé i18n non résolue", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/thread\.[a-zA-Z]+\./);
  });
});

describe("boîte de réception", () => {
  it("montre le motif et l'état de l'IA de chaque fil", () => {
    const html = wrap(
      createElement(ConversationsInbox, { rows: ROWS, currentUserId: "me", health: HEALTH }),
    );
    expect(html).toContain("Marie Tremblay");
    expect(html).toContain("Passé à un humain");
    expect(html).toContain("IA en pause");
  });

  it("l'interrupteur coupé est une ALERTE, pas une pastille", () => {
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: ROWS,
        currentUserId: "me",
        health: { ...HEALTH, killSwitch: true },
      }),
    );
    // Découvrir après avoir tapé trois réponses que rien ne part est la pire
    // manière de l'apprendre.
    expect(html).toContain("SUSPENDUS");
    expect(html).toContain('role="alert"');
  });

  it("un mode qui n'est pas « réel » est affiché", () => {
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: ROWS,
        currentUserId: "me",
        health: { ...HEALTH, mode: "dry_run" },
      }),
    );
    expect(html).toContain("Simulation");
  });

  it("hors heures de politesse, la bande le dit", () => {
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: ROWS,
        currentUserId: "me",
        health: { ...HEALTH, sendWindowOpen: false },
      }),
    );
    expect(html).toContain("Hors heures");
  });

  it("les échecs en file ne sont montrés que s'il y en a", () => {
    const clean = wrap(
      createElement(ConversationsInbox, { rows: ROWS, currentUserId: "me", health: HEALTH }),
    );
    expect(clean).not.toContain("en échec");

    const broken = wrap(
      createElement(ConversationsInbox, {
        rows: ROWS,
        currentUserId: "me",
        health: { ...HEALTH, failed: 4 },
      }),
    );
    expect(broken).toContain("en échec");
  });

  it("le filtre par défaut est « à traiter »", () => {
    const html = wrap(
      createElement(ConversationsInbox, { rows: ROWS, currentUserId: "me", health: HEALTH }),
    );
    // Marie est à traiter, Jean non : seul Marie doit apparaître au départ.
    expect(html).toContain("Marie Tremblay");
    expect(html).not.toContain("Jean Roy");
  });

  it("un fil CLOS ou REFUSÉ ne compte pas dans « à traiter », même avec needsAttention", () => {
    // Le moteur laisse needsAttention vrai en fermant (ça date le verdict) ;
    // l'écran, lui, range le fil dans sa vue (Refus, ou Conclues de
    // « Toutes ») — le mêler aux fils qui attendent noierait ce qui attend.
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: [...ROWS, FINISHED_ROW, REFUSED_ROW],
        currentUserId: "me",
        health: HEALTH,
      }),
    );
    expect(html).not.toContain("Julie Desrosiers");
    expect(html).not.toContain("Robert Bouchard");
  });

  it("un fil TENU par un humain apparaît dans « à traiter », section « Entre vos mains »", () => {
    // C'est du travail humain : il doit se retrouver là où on cherche le
    // travail humain — pas dans un cinquième onglet.
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: [...ROWS, HELD_ROW],
        currentUserId: "me",
        health: HEALTH,
      }),
    );
    expect(html).toContain("Entre vos mains");
    expect(html).toContain("François Pelletier");
  });

  it("un fil à traiter offre les DÉCISIONS sur place : rendre à l'IA, je réponds, traité", () => {
    // Décider ne doit pas demander d'ouvrir trois écrans. « Rendre à l'IA »
    // n'apparaît que si un assistant tient réellement le fil.
    const withAssistant: InboxRow = { ...ROWS[0], assistantName: "Acheteur FB" };
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: [withAssistant],
        currentUserId: "me",
        health: HEALTH,
      }),
    );
    expect(html).toContain("Rendre à l&#x27;IA");
    expect(html).toContain("Je réponds");
    expect(html).toContain("Marquer trait");
  });

  it("une PANNE offre « Réessayer », pas « Rendre à l'IA »", () => {
    // Réessayer rouvre les entrants consommés et rejoue le tour — rendre la
    // main ne le fait pas : sur une panne, c'est le rejeu qu'il faut offrir.
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: [ENGINE_ROW],
        currentUserId: "me",
        health: HEALTH,
      }),
    );
    expect(html).toContain("Réessayer");
    expect(html).not.toContain("Rendre à l&#x27;IA");
  });

  it("sans assistant sur le fil, « rendre à l'IA » n'est pas offert", () => {
    // Rendre la main à personne laisserait le fil muet en prétendant le
    // contraire — Marie n'a pas d'assistant, le bouton n'existe pas.
    const html = wrap(
      createElement(ConversationsInbox, { rows: [ROWS[0]], currentUserId: "me", health: HEALTH }),
    );
    expect(html).not.toContain("Rendre à l&#x27;IA");
    expect(html).toContain("Je réponds");
  });

  it("répondre et réparer sont DEUX sections, pas un entremêlement", () => {
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: [...ROWS, ENGINE_ROW],
        currentUserId: "me",
        health: HEALTH,
      }),
    );
    expect(html).toContain("Le client attend une réponse");
    expect(html).toContain("Pannes techniques");
    // Et la panne est bien rangée APRÈS les clients qui attendent.
    expect(html.indexOf("Marie Tremblay")).toBeLessThan(html.indexOf("Nathalie Côté"));
  });

  it("chaque dernier message dit QUI l'a écrit", () => {
    // « Parfait, je vous confirme jeudi » n'a pas le même sens selon que
    // c'est le client ou l'assistant : sans préfixe, on répond à la mauvaise
    // personne.
    const html = wrap(
      createElement(ConversationsInbox, { rows: ROWS, currentUserId: "me", health: HEALTH }),
    );
    expect(html).toContain("Client");
    expect(html).toContain("Je préfère parler à quelqu");
  });

  it("toute la carte est un lien vers la fiche", () => {
    const html = wrap(
      createElement(ConversationsInbox, { rows: ROWS, currentUserId: "me", health: HEALTH }),
    );
    // Viser un petit bouton depuis un cellulaire était le geste le plus
    // fréquent et le plus pénible de l'écran.
    expect(html).toContain('href="/clients/cccccccc-cccc-4ccc-8ccc-cccccccccccc"');
    expect(html).toContain("Ouvrir la fiche — Marie Tremblay");
  });

  it("dans la file « à traiter », le plus ancien attend en PREMIER", () => {
    // C'est une file d'attente, pas un journal : le client qui patiente
    // depuis le plus longtemps passe devant.
    const older: InboxRow = {
      ...ROWS[0],
      id: "c9",
      clientId: "99999999-9999-4999-8999-999999999999",
      clientName: "Aline Ancienne",
      attentionReason: "inbound",
      lastAt: "2026-08-20T08:00:00.000Z",
    };
    const html = wrap(
      createElement(ConversationsInbox, {
        rows: [ROWS[0], older],
        currentUserId: "me",
        health: HEALTH,
      }),
    );
    expect(html.indexOf("Aline Ancienne")).toBeLessThan(html.indexOf("Marie Tremblay"));
  });

  it("un état vide reste lisible", () => {
    const html = wrap(
      createElement(ConversationsInbox, { rows: [], currentUserId: "me", health: HEALTH }),
    );
    expect(html).toContain("Rien à traiter");
    expect(html).not.toContain("MISSING_MESSAGE");
  });

  it("aucune clé i18n non résolue", () => {
    const html = wrap(
      createElement(ConversationsInbox, { rows: ROWS, currentUserId: "me", health: HEALTH }),
    );
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/inbox\.[a-zA-Z]+\./);
    expect(html).not.toMatch(/health\.[a-zA-Z]+\./);
  });
});

describe("fil SMS", () => {
  it("un message en simulation (dry_run) a un libellé, pas une clé brute", () => {
    // Trouvé en essai local : le fil affichait « thread.status.dry_run ».
    const html = wrap(
      createElement(SmsThreadCard, {
        clientId: "x",
        thread: {
          ...THREAD,
          messages: [
            {
              id: "m-dry", direction: "out", body: "Bonjour", createdAt: "2026-08-21T15:00:00.000Z",
              status: "dry_run", errorCode: null, skipReason: null, source: "agent", aiGenerated: true, sentByName: null,
            },
          ],
        },
      }),
    );
    expect(html).toContain("Simulation");
    expect(html).not.toContain("thread.status.");
  });
});

describe("le modèle d'état d'un fil", () => {
  it("cinq états exclusifs, dans le bon ordre de priorité", async () => {
    const { conversationStateOf } = await import("@/components/conversations/state");
    // Un verdict gagne sur tout : le moteur laisse needsAttention vrai en
    // fermant — et un NON explicite ne se range pas avec les conclusions.
    expect(
      conversationStateOf({ needsAttention: true, attentionReason: "optout", aiEnabled: false }),
    ).toBe("refused");
    expect(
      conversationStateOf({
        needsAttention: true,
        attentionReason: "hard_refusal",
        aiEnabled: false,
      }),
    ).toBe("refused");
    expect(
      conversationStateOf({
        needsAttention: true,
        attentionReason: "closed_not_interested",
        aiEnabled: false,
      }),
    ).toBe("refused");
    expect(
      conversationStateOf({
        needsAttention: true,
        attentionReason: "closed_goal_reached",
        aiEnabled: false,
      }),
    ).toBe("concluded");
    expect(
      conversationStateOf({ needsAttention: true, attentionReason: "inbound", aiEnabled: true }),
    ).toBe("attention");
    // À traiter gagne sur la pause : couper l'IA ne traite rien.
    expect(
      conversationStateOf({ needsAttention: true, attentionReason: "handoff", aiEnabled: false }),
    ).toBe("attention");
    expect(
      conversationStateOf({ needsAttention: false, attentionReason: null, aiEnabled: false }),
    ).toBe("human");
    expect(
      conversationStateOf({ needsAttention: false, attentionReason: null, aiEnabled: true }),
    ).toBe("ai");
  });

  it("un motif INCONNU demande un humain, jamais la corbeille", async () => {
    // Le moteur gagnera d'autres motifs ; le jour où il en écrit un que
    // l'écran ne connaît pas, ce fil doit réclamer quelqu'un — pas être rangé
    // dans les pannes ni, pire, dans les fils finis.
    const { attentionKindOf, conversationStateOf } = await import(
      "@/components/conversations/state"
    );
    expect(attentionKindOf("reason_of_the_future")).toBe("reply");
    expect(
      conversationStateOf({
        needsAttention: true,
        attentionReason: "reason_of_the_future",
        aiEnabled: true,
      }),
    ).toBe("attention");
  });

  it("chaque motif du modèle a son libellé français ET anglais", async () => {
    // Un motif écrit par le moteur sans libellé s'afficherait en clé brute
    // (« inbox.reason.llm_error ») au milieu de l'écran.
    const { ATTENTION_REASONS } = await import("@/components/conversations/state");
    const en = (await import("../messages/en/conversations.json")).default as {
      inbox: { reason: Record<string, string> };
    };
    for (const reason of ATTENTION_REASONS) {
      expect(
        (conversationsFr as { inbox: { reason: Record<string, string> } }).inbox.reason[reason],
        `fr: ${reason}`,
      ).toBeTruthy();
      expect(en.inbox.reason[reason], `en: ${reason}`).toBeTruthy();
    }
  });
});

describe("envois en file, envois non partis, assistant du fil", () => {
  it("un envoi EN FILE est visible et annulable", () => {
    const html = wrap(
      createElement(SmsThreadCard, {
        clientId: "x",
        thread: {
          ...THREAD,
          queued: [{ jobId: "j1", body: "Bonjour, ça part bientôt", source: "human", automated: false, runAt: new Date().toISOString() }],
        },
      }),
    );
    expect(html).toContain("Bonjour, ça part bientôt");
    expect(html).toContain("En file");
    expect(html).toContain("Annuler");
  });

  it("un envoi NON PARTI dit pourquoi, au lieu de disparaître", () => {
    const html = wrap(
      createElement(SmsThreadCard, {
        clientId: "x",
        thread: {
          ...THREAD,
          messages: [
            {
              id: "m-skip", direction: "out", body: "Bonjour", createdAt: "2026-08-21T15:00:00.000Z",
              status: "skipped", errorCode: null, skipReason: "kill_switch", source: "human", aiGenerated: false, sentByName: "Alex",
            },
          ],
        },
      }),
    );
    expect(html).toContain("Non envoyé");
    expect(html).toContain("interrupteur d&#x27;arrêt baissé");
  });

  it("le fil montre à quel assistant il est confié, et propose de changer", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    expect(html).toContain("Assistant");
    expect(html).toContain("Aucun (un humain répond)");
  });
});
