/**
 * Régressions de l'audit — grappe F (réservation / Google Agenda).
 *
 * 1. FreeBusy « fail closed » : Google répond 200 avec `calendars[id].errors`
 *    quand l'agenda demandé n'existe plus (supprimé, départagé, identifiant
 *    périmé). Une liste `busy` vide dans ce cas ne veut PAS dire « libre » —
 *    le vrai `freeBusy` doit échouer, et /api/availability répondre 502
 *    plutôt que d'offrir toute la journée (double réservation silencieuse).
 * 2. Réglages de réservation : bornes serveur (heures « HH:MM », durées
 *    entières positives, fuseau IANA connu, début < fin) → 422, jamais stocké.
 * 3. Déconnexion Google : le refresh token est révoqué CHEZ GOOGLE avant
 *    d'être effacé localement (meilleur effort — une panne de révocation
 *    n'empêche pas la déconnexion locale).
 *
 * Seul googleapis (réseau) est simulé : `freeBusy`, `revokeStoredToken` et
 * les routes exercées sont les vrais modules.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { auditLogs } from "@/db/schema";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";

// ── Doublures (googleapis + contexte de requête Next) ────────────────────────

const H = vi.hoisted(() => ({
  freebusyQuery: vi.fn<(args: unknown) => Promise<{ data: unknown }>>(),
  revokeToken: vi.fn<(token: string) => Promise<void>>(),
  session: { token: null as string | null },
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "nexus_session" && H.session.token ? { name, value: H.session.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        revokeToken(token: string) {
          return H.revokeToken(token);
        }
      },
    },
    calendar: () => ({ freebusy: { query: H.freebusyQuery } }),
  },
}));

import { NextRequest } from "next/server";
import { GET as availabilityGET } from "@/app/api/availability/route";
import { POST as bookingSettingsPOST } from "@/app/api/admin/settings/booking/route";
import { POST as googleDisconnectPOST } from "@/app/api/admin/google/disconnect/route";
import { encryptSecret } from "@/lib/crypto";
import {
  freeBusy,
  GoogleCalendarUnavailableError,
  GoogleNotConnectedError,
} from "@/lib/google";
import { getSetting, setSetting } from "@/lib/settings";

process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";

// ── Outils ───────────────────────────────────────────────────────────────────

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);
const CALENDAR_ID = "agenda-test@group.calendar.google.com";
const REFRESH_TOKEN = "jeton-google-secret";

async function loginAs(role: "admin" | "caller" = "admin") {
  const user = await makeUser({ role });
  H.session.token = await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
  return user;
}

/** Compte Google « connecté » : refresh token réellement chiffré en base. */
async function connectGoogle() {
  await setSetting("google", {
    refreshTokenEnc: encryptSecret(REFRESH_TOKEN),
    email: "info@alexhonore.com",
    calendarId: CALENDAR_ID,
    connectedAt: new Date().toISOString(),
  });
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  H.session.token = null;
  H.freebusyQuery.mockReset();
  H.revokeToken.mockReset();
  H.revokeToken.mockResolvedValue(undefined);
});

afterAll(closeDb);

// ═══════════════════════════════════════════════════════════════════════════
// 1. FreeBusy — un agenda en erreur n'est JAMAIS pris pour un agenda libre.
// ═══════════════════════════════════════════════════════════════════════════

describe("freeBusy — erreurs par calendrier (fail closed)", () => {
  const MIN = new Date("2026-09-01T04:00:00.000Z");
  const MAX = new Date("2026-09-02T04:00:00.000Z");

  beforeEach(connectGoogle);

  it("agenda introuvable (errors: notFound, busy: []) → GoogleCalendarUnavailableError", async () => {
    H.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          [CALENDAR_ID]: { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
        },
      },
    });

    const err = await freeBusy(MIN, MAX).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleCalendarUnavailableError);
    // PAS une absence de connexion : computeAvailability doit relancer, pas
    // basculer en mode « Google non connecté » (qui offrirait les créneaux).
    expect(err).not.toBeInstanceOf(GoogleNotConnectedError);
    expect(String(err.message)).toContain(CALENDAR_ID);
    expect(String(err.message)).toContain("notFound");
  });

  it("réponse sans le calendrier demandé (aucune entrée) → erreur aussi", async () => {
    H.freebusyQuery.mockResolvedValue({ data: { calendars: {} } });
    await expect(freeBusy(MIN, MAX)).rejects.toBeInstanceOf(GoogleCalendarUnavailableError);
  });

  it("réponse recadrée sur le courriel résolu (clé différente, sans erreur) → occupations lues", async () => {
    H.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          "resolu@group.calendar.google.com": {
            busy: [{ start: "2026-09-01T14:00:00Z", end: "2026-09-01T15:00:00Z" }],
          },
        },
      },
    });
    const busy = await freeBusy(MIN, MAX);
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe("2026-09-01T14:00:00.000Z");
  });

  it("GET /api/availability → 502 availability_failed (aucun créneau offert à l'aveugle)", async () => {
    await loginAs("caller");
    H.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          [CALENDAR_ID]: { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
        },
      },
    });

    const res = await availabilityGET(
      new NextRequest("http://localhost/api/availability?date=2026-09-01&type=meet"),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "availability_failed" });
  });

  it("compte non connecté : GoogleNotConnectedError reste distinct (dégradé, pas 502)", async () => {
    await setSetting("google", {
      refreshTokenEnc: null,
      email: null,
      calendarId: "primary",
      connectedAt: null,
    });
    await expect(freeBusy(MIN, MAX)).rejects.toBeInstanceOf(GoogleNotConnectedError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Réglages de réservation — bornes serveur (422, jamais stocké).
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/admin/settings/booking — bornes serveur", () => {
  const url = "http://localhost/api/admin/settings/booking";

  beforeEach(async () => {
    await loginAs("admin");
  });

  it.each([
    ["heure vidée", { startHour: "" }],
    ["heure impossible", { startHour: "25:99" }],
    ["durée nulle (champ vidé → 0)", { meetDurationMin: 0 }],
    ["durée négative", { inPersonDurationMin: -30 }],
    ["durée non entière", { meetDurationMin: 22.5 }],
    ["tampon négatif", { bufferMin: -5 }],
    ["fuseau inventé", { timezone: "Mars/Olympus" }],
    ["jour hors semaine", { days: [0, 7] }],
  ] as const)("refuse %s en 422 sans rien stocker", async (_label, patch) => {
    const res = await bookingSettingsPOST(jsonRequest(url, patch));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation");

    const saved = await getSetting("booking");
    // Les valeurs par défaut (saines) sont intactes.
    expect(saved.startHour).toBe("06:00");
    expect(saved.meetDurationMin).toBe(30);
    expect(saved.timezone).toBe("America/Toronto");
  });

  it("refuse une fenêtre inversée RECOMPOSÉE (début posé après la fin enregistrée)", async () => {
    await setSetting("booking", { endHour: "12:00" });
    // Chaque champ est valide isolément ; c'est le réglage recomposé qui ne l'est pas.
    const res = await bookingSettingsPOST(jsonRequest(url, { startHour: "18:00" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation");
    expect((await getSetting("booking")).startHour).toBe("06:00");
  });

  it("accepte une rustine valide, et les valeurs par défaut passent toujours le schéma", async () => {
    const res = await bookingSettingsPOST(
      jsonRequest(url, { startHour: "08:30", meetDurationMin: 45, bufferMin: 0 }),
    );
    expect(res.status).toBe(200);
    const saved = await getSetting("booking");
    expect(saved.startHour).toBe("08:30");
    expect(saved.meetDurationMin).toBe(45);
    expect(saved.bufferMin).toBe(0);

    // Un POST vide (aucun champ) reste un 200 : les défauts sont valides.
    expect((await bookingSettingsPOST(jsonRequest(url, {}))).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Déconnexion Google — révocation chez Google AVANT l'effacement local.
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/admin/google/disconnect", () => {
  it("révoque le refresh token chez Google, puis efface le réglage (calendarId conservé)", async () => {
    const admin = await loginAs("admin");
    await connectGoogle();

    const res = await googleDisconnectPOST();
    expect(res.status).toBe(200);

    // Révoqué AVANT l'effacement : le jeton déchiffré a bien atteint Google.
    // (Si l'effacement passait d'abord, revokeStoredToken ne trouverait plus
    // rien à révoquer et cet appel n'aurait jamais lieu.)
    expect(H.revokeToken).toHaveBeenCalledTimes(1);
    expect(H.revokeToken).toHaveBeenCalledWith(REFRESH_TOKEN);

    const saved = await getSetting("google");
    expect(saved.refreshTokenEnc).toBeNull();
    expect(saved.email).toBeNull();
    expect(saved.connectedAt).toBeNull();
    expect(saved.calendarId).toBe(CALENDAR_ID);

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "settings.google_disconnect"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(admin.id);
  });

  it("révocation en panne (réseau) : meilleur effort — la déconnexion locale a quand même lieu", async () => {
    await loginAs("admin");
    await connectGoogle();
    H.revokeToken.mockRejectedValue(new Error("réseau injoignable"));

    const res = await googleDisconnectPOST();
    expect(res.status).toBe(200);
    expect((await getSetting("google")).refreshTokenEnc).toBeNull();
  });

  it("téléphoniste → 403, rien n'est touché", async () => {
    await loginAs("caller");
    await connectGoogle();

    const res = await googleDisconnectPOST();
    expect(res.status).toBe(403);
    expect(H.revokeToken).not.toHaveBeenCalled();
    expect((await getSetting("google")).refreshTokenEnc).not.toBeNull();
  });
});
