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
import conversationsFr from "../messages/fr/conversations.json";
import commonFr from "../messages/fr/common.json";
import type { SmsThreadData } from "@/components/clients/sms-thread-card";
import type { EngineHealth, InboxRow } from "@/components/conversations/conversations-inbox";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// Les composants importent les actions serveur ; les simuler évite d'entraîner
// toute la couche base dans un test de rendu.
vi.mock("@/app/(app)/clients/consent-actions", () => ({
  grantSmsConsentAction: vi.fn(),
  revokeSmsConsentAction: vi.fn(),
}));
vi.mock("@/app/(app)/conversations/actions", () => ({
  assignAssistantAction: vi.fn(),
  cancelQueuedSmsAction: vi.fn(),
  cancelOutboundSmsAction: vi.fn(),
  sendManualSmsAction: vi.fn(),
  setConversationAiAction: vi.fn(),
  markConversationHandledAction: vi.fn(),
  assignConversationAction: vi.fn(),
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
  consent: { status: "valid", kind: "express", source: "manual:phone_call", grantedAt: "2026-08-01T12:00:00.000Z", expiresAt: null },
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
    lastBody: "Je préfère parler à quelqu'un",
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
    lastBody: "Merci!",
    lastAt: "2026-08-21T12:00:00.000Z",
  },
];

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

  it("la carte SMS ne ressemble PAS à la carte de commentaires", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    // Teinte et bordure propres : le signal doit être perçu du coin de l'œil,
    // pas lu. Une note envoyée par erreur à un client ne se rattrape pas.
    expect(html).toContain("border-primary/40");
    expect(html).toContain("bg-primary/5");
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

describe("consentement dans le fil", () => {
  it("l'état du consentement est affiché, avec le geste de l'enregistrer ou de le révoquer", () => {
    const html = wrap(createElement(SmsThreadCard, { clientId: "x", thread: THREAD }));
    expect(html).toContain("Consentement SMS");
    expect(html).toContain(">Valide<");
    expect(html).toContain("Révoquer");
    const none = wrap(
      createElement(SmsThreadCard, {
        clientId: "x",
        thread: { ...THREAD, consent: { status: "none", kind: null, source: null, grantedAt: null, expiresAt: null } },
      }),
    );
    expect(none).toContain("Aucun au dossier");
    expect(none).toContain("Enregistrer un consentement");
    expect(none).not.toContain("Révoquer");
  });

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
