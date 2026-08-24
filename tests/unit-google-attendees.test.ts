/**
 * Unitaires — participants d'un évènement de réservation (client + courtier).
 * Le courtier est invité pour recevoir l'invitation quand le compte Google
 * connecté n'est pas le sien ; jamais en double avec le client.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { bookingEventAttendees, validAttendeeEmail } = await import("@/lib/google");

describe("bookingEventAttendees", () => {
  it("invite le client et le courtier", () => {
    expect(bookingEventAttendees("client@exemple.ca", "info@alexhonore.com")).toEqual([
      { email: "client@exemple.ca" },
      { email: "info@alexhonore.com" },
    ]);
  });

  it("invite le courtier même sans courriel client", () => {
    expect(bookingEventAttendees(null, "info@alexhonore.com")).toEqual([
      { email: "info@alexhonore.com" },
    ]);
    expect(bookingEventAttendees("", "info@alexhonore.com")).toEqual([
      { email: "info@alexhonore.com" },
    ]);
  });

  it("n'invite personne quand aucun courriel n'est fourni", () => {
    expect(bookingEventAttendees(null, null)).toEqual([]);
    expect(bookingEventAttendees("", "")).toEqual([]);
  });

  it("ne double pas le courtier quand le client EST le courtier (insensible à la casse)", () => {
    expect(bookingEventAttendees("Info@AlexHonore.com", "info@alexhonore.com")).toEqual([
      { email: "Info@AlexHonore.com" },
    ]);
  });

  it("garde le client seul quand aucun courtier n'est configuré", () => {
    expect(bookingEventAttendees("client@exemple.ca", null)).toEqual([
      { email: "client@exemple.ca" },
    ]);
  });
});

// ── Courriel client mal formé : ignoré, jamais envoyé à Google ──────────────
// `clients.email` est du texte libre (import, webhook) : un « aucun » ou deux
// adresses collées faisaient rejeter TOUT l'évènement (400 Invalid attendee
// email) — plus d'agenda, plus de lien Meet, et une notification trompeuse.

describe("bookingEventAttendees — courriel client invalide", () => {
  it.each(["aucun", "n/a", "a@x.com, b@y.com", "jean point tremblay arobase gmail", "info@alexhonore"])(
    "« %s » n'invite que le courtier",
    (junk) => {
      expect(bookingEventAttendees(junk, "info@alexhonore.com")).toEqual([
        { email: "info@alexhonore.com" },
      ]);
    },
  );

  it("un courriel invalide sans courtier configuré ne produit aucun participant", () => {
    expect(bookingEventAttendees("aucun", null)).toEqual([]);
  });

  it("un courriel valide entouré d'espaces est invité, nettoyé", () => {
    expect(bookingEventAttendees("  client@exemple.ca ", null)).toEqual([
      { email: "client@exemple.ca" },
    ]);
  });
});

describe("validAttendeeEmail", () => {
  it("rend l'adresse nettoyée quand elle est valide", () => {
    expect(validAttendeeEmail(" Marie.T@Exemple.ca ")).toBe("Marie.T@Exemple.ca");
  });

  it.each([null, undefined, "", "   ", "aucun", "a@x.com, b@y.com", "@exemple.ca"])(
    "rend null pour %j",
    (value) => {
      expect(validAttendeeEmail(value)).toBeNull();
    },
  );
});
