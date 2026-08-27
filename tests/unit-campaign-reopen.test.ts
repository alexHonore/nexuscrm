/**
 * Unitaire — RELANCER une inscription terminée.
 *
 * Deux questions, deux modules purs. « Qui a le droit de repartir ? »
 * (`enrollmentReopenable`) : une échelle finie et rien d'autre — un refus, un
 * rendez-vous, une réponse ne se repêchent jamais. « Quand ? » (`planReopen`) :
 * jamais dans le passé, et étalé, parce qu'un lot réveillé d'un coup viderait
 * le plafond du jour du numéro et ferait mentir la trace des barreaux.
 */
import { describe, expect, it } from "vitest";
import {
  LADDER_EXHAUSTED_REASON,
  enrollmentReopenable,
} from "@/lib/campaigns/enrollment-status";
import { REOPEN_GRACE_MS, planReopen, reopenSpacingMs } from "@/lib/campaigns/reopen";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";
import type { LadderStep } from "@/lib/campaigns/schema";

/** Une inscription close par épuisement de l'échelle : le seul cas relançable. */
function closed(overrides: Partial<Parameters<typeof enrollmentReopenable>[0]> = {}) {
  return {
    status: "completed",
    endReason: LADDER_EXHAUSTED_REASON,
    endedAt: new Date("2026-06-18T14:00:00.000Z"),
    step: 1,
    ...overrides,
  };
}

describe("§ qui peut être relancé", () => {
  it("une échelle finie que la campagne a DEPUIS rallongée repart", () => {
    expect(enrollmentReopenable(closed(), { ladderLength: 3 })).toEqual({ allowed: true });
  });

  it("sans nouveau barreau, il n'y a rien à relancer", () => {
    // Rouvrir ici ne produirait aucun message : le moteur refuserait « échelle
    // épuisée » au premier cycle et réécrirait `ended_at` avec la date du jour.
    expect(enrollmentReopenable(closed({ step: 2 }), { ladderLength: 2 })).toEqual({
      allowed: false,
      refusal: "nothing_new",
    });
    expect(enrollmentReopenable(closed({ step: 5 }), { ladderLength: 2 }).allowed).toBe(false);
  });

  it("§ un REFUS ne se repêche jamais, quelle que soit la longueur de l'échelle", () => {
    const nope = [
      ["stopped", "opted_out"],
      ["stopped", "suppressed"],
      ["stopped", "do_not_call"],
      ["replied", "replied"],
      ["booked", "booked"],
      ["excluded", "removed_by_admin"],
      ["excluded", "left_audience"],
      ["excluded", "live_conversation"],
      ["excluded", "client_deleted"],
      ["completed", "campaign_archived"],
      ["completed", "hard_refusal"],
      ["completed", "goal_reached"],
      ["completed", "not_interested"],
    ] as const;
    for (const [status, endReason] of nope) {
      expect(
        enrollmentReopenable(closed({ status, endReason }), { ladderLength: 8 }),
        `${status}/${endReason}`,
      ).toEqual({ allowed: false, refusal: "not_ladder_end" });
    }
  });

  it("une inscription encore en vol ne se « relance » pas — elle se reprend", () => {
    for (const status of ["pending", "active"]) {
      expect(
        enrollmentReopenable(closed({ status, endedAt: null }), { ladderLength: 3 }),
        status,
      ).toEqual({ allowed: false, refusal: "not_closed" });
    }
    // La pause manuelle porte un `end_reason` SANS être close : c'est
    // « Reprendre » qui la remet en file, jamais « Relancer ».
    expect(
      enrollmentReopenable(
        closed({ status: "active", endReason: "paused_by_admin", endedAt: null }),
        { ladderLength: 3 },
      ),
    ).toEqual({ allowed: false, refusal: "not_closed" });
  });

  it("« pas close » passe AVANT « pas la bonne raison » : l'ordre des refus est figé", () => {
    // Une ligne vivante close par personne ne doit pas se voir reprocher son
    // motif : le premier mot juste est « elle n'est pas terminée ».
    expect(
      enrollmentReopenable({ status: "active", step: 0, endedAt: null, endReason: "replied" }, {
        ladderLength: 3,
      }),
    ).toEqual({ allowed: false, refusal: "not_closed" });
  });

  it("`endedAt` est accepté en chaîne ISO — le composant client lit du JSON", () => {
    expect(
      enrollmentReopenable(closed({ endedAt: "2026-06-18T14:00:00.000Z" }), { ladderLength: 2 }),
    ).toEqual({ allowed: true });
  });

  it("une échelle vide ne relance rien", () => {
    expect(enrollmentReopenable(closed({ step: 0 }), { ladderLength: 0 })).toEqual({
      allowed: false,
      refusal: "nothing_new",
    });
  });
});

// ── Calendrier ───────────────────────────────────────────────────────────────

const LADDER: LadderStep[] = [
  { delayHours: 0, body: "Bonjour", label: "ouverture" },
  { delayHours: 48, body: "Relance", label: "j+2" },
];

/** 11 h de fenêtre / 200 messages = 198 s. */
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    step: 1,
    enrolledAt: new Date("2026-06-16T14:00:00.000Z"),
    lastTouchAt: new Date("2026-06-18T14:00:00.000Z"),
  }));

const NOON = new Date("2026-08-20T15:00:00.000Z"); // 11 h à Toronto, en pleine fenêtre

const plan = (n: number, over: Partial<Parameters<typeof planReopen>[1]> = {}) =>
  planReopen(rows(n), {
    ladder: LADDER,
    quietHours: DEFAULT_QUIET_HOURS,
    dailyCap: 200,
    sentToday: 0,
    now: NOON,
    // Hasard figé : le jitter d'ouverture ne doit pas rendre le test capricieux.
    random: () => 0,
    ...over,
  });

describe("§ quand les relances repartent", () => {
  it("l'espacement se DÉDUIT du plafond du numéro", () => {
    expect(reopenSpacingMs(200)).toBe(198_000); // 11 h / 200
    expect(reopenSpacingMs(20)).toBe(1_980_000); // 33 min
    // Un plafond démesuré ne fait pas partir deux SMS dans la même seconde.
    expect(reopenSpacingMs(10_000)).toBe(60_000);
    // Un plafond absurde (0) ne divise pas par zéro : il donne un par journée.
    expect(reopenSpacingMs(0)).toBe(39_600_000);
  });

  it("§ aucune date dans le passé — c'est tout l'objet du module", () => {
    // La date « naturelle » serait `dernier envoi + 48 h`, soit juin : elle
    // rendrait tout le lot dû à la même seconde, devant les campagnes vivantes.
    for (const slot of plan(50)) {
      expect(slot.dueAt.getTime()).toBeGreaterThanOrEqual(NOON.getTime());
    }
  });

  it("le premier départ respecte le délai de grâce — de quoi se raviser", () => {
    const [first] = plan(1);
    expect(first.dueAt.getTime()).toBe(NOON.getTime() + REOPEN_GRACE_MS);
  });

  it("les départs sont étalés, jamais simultanés", () => {
    const slots = plan(5);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i].dueAt.getTime() - slots[i - 1].dueAt.getTime()).toBe(198_000);
    }
  });

  it("le plafond DÉJÀ consommé aujourd'hui repousse le lot au lendemain", () => {
    // Une autre campagne a rempli la journée : rien ne part ce soir.
    const [first] = plan(1, { dailyCap: 200, sentToday: 200 });
    const torontoHour = Number(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        hour: "numeric",
        hour12: false,
      }).format(first.dueAt),
    );
    expect(first.dueAt.getTime()).toBeGreaterThan(NOON.getTime());
    expect(torontoHour).toBe(9); // l'ouverture du lendemain
  });

  it("§ le lot déborde sur les jours suivants au lieu de crever le plafond", () => {
    // Trois messages par jour : le quatrième ne peut pas partir aujourd'hui.
    const slots = plan(7, { dailyCap: 3 });
    const day = (d: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
    const byDay = new Map<string, number>();
    for (const s of slots) byDay.set(day(s.dueAt), (byDay.get(day(s.dueAt)) ?? 0) + 1);
    expect([...byDay.values()].every((n) => n <= 3)).toBe(true);
    expect(byDay.size).toBeGreaterThanOrEqual(3);
  });

  it("un envoi hors fenêtre est reporté à l'ouverture, pas expédié la nuit", () => {
    const night = new Date("2026-08-21T03:00:00.000Z"); // 23 h à Toronto
    const [first] = planReopen(rows(1), {
      ladder: LADDER,
      quietHours: DEFAULT_QUIET_HOURS,
      dailyCap: 200,
      sentToday: 0,
      now: night,
      random: () => 0,
    });
    const hour = Number(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        hour: "numeric",
        hour12: false,
      }).format(first.dueAt),
    );
    expect(hour).toBe(9);
  });

  it("un délai d'échelle encore DEVANT nous reste souverain", () => {
    // Barreau à 48 h d'un envoi d'hier : il n'y a aucune raison de l'avancer
    // parce qu'on vient de cliquer.
    const lastTouchAt = new Date(NOON.getTime() - 24 * 60 * 60 * 1000);
    const [slot] = planReopen(
      [{ id: "e0", step: 1, enrolledAt: new Date("2026-08-01T14:00:00.000Z"), lastTouchAt }],
      {
        ladder: LADDER,
        quietHours: DEFAULT_QUIET_HOURS,
        dailyCap: 200,
        sentToday: 0,
        now: NOON,
        random: () => 0,
      },
    );
    expect(slot.dueAt.getTime()).toBe(lastTouchAt.getTime() + 48 * 60 * 60 * 1000);
  });
});
