/**
 * Unitaires — participants d'un évènement de réservation (client + courtier).
 * Le courtier est invité pour recevoir l'invitation quand le compte Google
 * connecté n'est pas le sien ; jamais en double avec le client.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { bookingEventAttendees } = await import("@/lib/google");

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
