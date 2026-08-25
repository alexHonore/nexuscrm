/**
 * Tests unitaires — fenêtre d'envoi SMS (src/lib/sms/quiet-hours.ts).
 *
 * Logique pure : aucune base de données, aléa injecté déterministe. Les
 * instants sont construits et vérifiés via date-fns-tz (jamais d'arithmétique
 * d'heures UTC), pour que les cas de changement d'heure testent la base tz.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUIET_HOURS,
  isWithinSendWindow,
  nextSendTime,
  quietHoursSchema,
  quietHoursSettingsSchema,
  type QuietHours,
} from "@/lib/sms/quiet-hours";

const TZ = "America/Toronto";

/** Instant UTC correspondant à une heure murale de Toronto. */
const toronto = (local: string): Date => fromZonedTime(local, TZ);
const localOf = (date: Date): string => formatInTimeZone(date, TZ, "yyyy-MM-dd HH:mm:ss");

const randomZero = (): number => 0;
const randomMax = (): number => 0.999;

// Jours de référence (vérifiés) : 2026-08-19 = mercredi, 2026-08-21 = vendredi,
// 2026-08-22 = samedi, 2026-08-23 = dimanche, 2026-08-24 = lundi.

// ═══════════════════════════════════════════════════════════════════════════
// quietHoursSchema — garde de configuration
// ═══════════════════════════════════════════════════════════════════════════

describe("quietHoursSchema", () => {
  it("accepte la configuration par défaut", () => {
    expect(quietHoursSchema.safeParse(DEFAULT_QUIET_HOURS).success).toBe(true);
  });

  it("rejette une fenêtre inversée (end < start)", () => {
    const cfg = { ...DEFAULT_QUIET_HOURS, weekday: [20, 9] };
    expect(quietHoursSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejette une fenêtre vide (end === start)", () => {
    const cfg = { ...DEFAULT_QUIET_HOURS, sunday: [9, 9] };
    expect(quietHoursSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejette une heure hors bornes", () => {
    const cfg = { ...DEFAULT_QUIET_HOURS, saturday: [10, 25] };
    expect(quietHoursSchema.safeParse(cfg).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isWithinSendWindow — bornes [start, end)
// ═══════════════════════════════════════════════════════════════════════════

describe("isWithinSendWindow", () => {
  it.each([
    ["mercredi 03:00 — nuit", "2026-08-19T03:00:00", false],
    ["mercredi 09:00 — start inclus", "2026-08-19T09:00:00", true],
    ["mercredi 19:59 — dernière minute permise", "2026-08-19T19:59:00", true],
    ["mercredi 20:00 — end exclu", "2026-08-19T20:00:00", false],
    ["samedi 09:30 — le samedi ouvre à 10 h", "2026-08-22T09:30:00", false],
    ["samedi 10:00 — start du samedi", "2026-08-22T10:00:00", true],
    ["dimanche 11:00 — start du dimanche", "2026-08-23T11:00:00", true],
    ["dimanche 19:00 — end du dimanche exclu", "2026-08-23T19:00:00", false],
  ])("%s → %s", (_label, local, expected) => {
    expect(isWithinSendWindow(toronto(local), DEFAULT_QUIET_HOURS)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// nextSendTime — report vers la prochaine ouverture
// ═══════════════════════════════════════════════════════════════════════════

describe("nextSendTime", () => {
  it("03:00 un mercredi → clampe au même jour 09:0x (démo du point de contrôle)", () => {
    const result = nextSendTime(toronto("2026-08-19T03:00:00"), DEFAULT_QUIET_HOURS, () => 0.42);
    expect(formatInTimeZone(result, TZ, "yyyy-MM-dd")).toBe("2026-08-19");
    expect(formatInTimeZone(result, TZ, "H")).toBe("9");
    const minutes = Number(formatInTimeZone(result, TZ, "m"));
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThanOrEqual(9);
  });

  it("10:00 un mercredi → inchangé (même instant, même référence)", () => {
    const date = toronto("2026-08-19T10:00:00");
    expect(nextSendTime(date, DEFAULT_QUIET_HOURS, randomZero)).toBe(date);
  });

  it("19:59 un mercredi → inchangé", () => {
    const date = toronto("2026-08-19T19:59:30");
    expect(nextSendTime(date, DEFAULT_QUIET_HOURS, randomZero)).toBe(date);
  });

  it("20:00 un mercredi (end exclu) → jeudi 09:00", () => {
    const result = nextSendTime(toronto("2026-08-19T20:00:00"), DEFAULT_QUIET_HOURS, randomZero);
    expect(localOf(result)).toBe("2026-08-20 09:00:00");
  });

  it("vendredi 21:30 → samedi 10:0x (fenêtre propre au samedi)", () => {
    const result = nextSendTime(toronto("2026-08-21T21:30:00"), DEFAULT_QUIET_HOURS, randomZero);
    expect(localOf(result)).toBe("2026-08-22 10:00:00");
  });

  it("samedi 05:00 → samedi 10:0x", () => {
    const result = nextSendTime(toronto("2026-08-22T05:00:00"), DEFAULT_QUIET_HOURS, randomZero);
    expect(localOf(result)).toBe("2026-08-22 10:00:00");
  });

  it("samedi 20:30 → dimanche 11:0x", () => {
    const result = nextSendTime(toronto("2026-08-22T20:30:00"), DEFAULT_QUIET_HOURS, randomZero);
    expect(localOf(result)).toBe("2026-08-23 11:00:00");
  });

  it("dimanche 19:10 → lundi 09:0x", () => {
    const result = nextSendTime(toronto("2026-08-23T19:10:00"), DEFAULT_QUIET_HOURS, randomZero);
    expect(localOf(result)).toBe("2026-08-24 09:00:00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Jitter — bornes du décalage dérivé de random()
// ═══════════════════════════════════════════════════════════════════════════

describe("nextSendTime — jitter", () => {
  const night = toronto("2026-08-19T03:00:00");

  it("random = 0 → ouverture exacte à :00:00", () => {
    const result = nextSendTime(night, DEFAULT_QUIET_HOURS, randomZero);
    expect(localOf(result)).toBe("2026-08-19 09:00:00");
  });

  it("random ≈ 1 → borne haute 09:09:59", () => {
    const result = nextSendTime(night, DEFAULT_QUIET_HOURS, randomMax);
    expect(localOf(result)).toBe("2026-08-19 09:09:59");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Changement d'heure — le passage à l'heure avancée est géré par la base tz
// ═══════════════════════════════════════════════════════════════════════════

describe("nextSendTime — changement d'heure", () => {
  // 2026-03-08 est le dimanche du passage à l'heure avancée (02:00 EST →
  // 03:00 EDT). Fenêtre uniforme [9, 20) pour isoler l'effet DST de la
  // fenêtre spéciale du dimanche.
  const uniform: QuietHours = { tz: TZ, weekday: [9, 20], saturday: [9, 20], sunday: [9, 20] };

  it("2026-03-08 03:30 → même jour 09:0x en EDT", () => {
    const result = nextSendTime(toronto("2026-03-08T03:30:00"), uniform, randomZero);
    expect(formatInTimeZone(result, TZ, "yyyy-MM-dd HH:mm:ss zzz")).toBe(
      "2026-03-08 09:00:00 EDT",
    );
  });

  it("la veille au soir (samedi 21:00 EST) → dimanche 09:0x EDT", () => {
    const result = nextSendTime(toronto("2026-03-07T21:00:00"), uniform, randomZero);
    expect(formatInTimeZone(result, TZ, "yyyy-MM-dd HH:mm:ss zzz")).toBe(
      "2026-03-08 09:00:00 EDT",
    );
  });
});

describe("quietHoursSettingsSchema (réglage)", () => {
  it("parse({}) rend exactement DEFAULT_QUIET_HOURS", () => {
    expect(quietHoursSettingsSchema.parse({})).toEqual(DEFAULT_QUIET_HOURS);
  });

  it("refuse une fenêtre dont la fin ne suit pas le début", () => {
    expect(quietHoursSettingsSchema.safeParse({ weekday: [20, 9] }).success).toBe(false);
    expect(quietHoursSettingsSchema.safeParse({ weekday: [9, 9] }).success).toBe(false);
  });

  it("accepte une fenêtre valide et complète les jours non fournis", () => {
    const r = quietHoursSettingsSchema.parse({ weekday: [8, 21] });
    expect(r.weekday).toEqual([8, 21]);
    expect(r.saturday).toEqual(DEFAULT_QUIET_HOURS.saturday);
    expect(r.sunday).toEqual(DEFAULT_QUIET_HOURS.sunday);
    expect(r.tz).toBe(DEFAULT_QUIET_HOURS.tz);
  });

  it("borne les heures (0–23 début, 1–24 fin)", () => {
    expect(quietHoursSettingsSchema.safeParse({ weekday: [-1, 8] }).success).toBe(false);
    expect(quietHoursSettingsSchema.safeParse({ weekday: [8, 25] }).success).toBe(false);
  });
});
