/**
 * Intégration — l'audio CONSERVÉ de la bibliothèque d'écoute (table
 * `recording_audio`, src/lib/recordings/audio.ts et ses routes).
 *
 * Ce que ces tests tiennent, dans l'ordre où ça casserait en production :
 *  1. La base ne se remplit JAMAIS : au plafond on cesse de conserver. Une
 *     base Supabase pleine passe en lecture seule, CRM entier compris.
 *  2. Un audio retiré par quelqu'un ne revient pas en douce — ni par une
 *     écoute, ni par le ramassage. Seul « Conserver » le reprend.
 *  3. On ne garde que la bibliothèque : un appel qui n'y est plus rend sa
 *     place, et un appel qui n'y a jamais été n'en prend pas.
 *  4. L'écoute d'un audio conservé ne dérange pas voip.ms, et reste tracée.
 *  5. Les gardes : ranger pour garder ou retirer, configurer pour la jauge,
 *     et une fiche invisible répond « introuvable ».
 * Le réseau voip.ms est simulé ; la base est réelle.
 */
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string }>(),
  headers: new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    getAll() {
      return [...ctx.cookies.values()];
    },
    has(name: string) {
      return ctx.cookies.has(name);
    },
    set(name: string, value: string) {
      ctx.cookies.set(name, { name, value });
    },
    delete(name: string) {
      ctx.cookies.delete(name);
    },
  }),
  headers: async () => ctx.headers,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

vi.mock("@/lib/voipms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voipms")>();
  return {
    ...actual,
    getCdr: vi.fn(async () => []),
    getCallRecordings: vi.fn(async () => []),
    getCallRecordingFile: vi.fn(),
  };
});

const { getCallRecordingFile, recordingRef } = await import("@/lib/voipms");
const { flushAfterResponse } = await import("@/lib/after-response");
const starRoute = await import("@/app/api/admin/recordings/star/route");
const collectionsRoute = await import("@/app/api/admin/recordings/collections/route");
const collectionRoute = await import("@/app/api/admin/recordings/collections/[id]/route");
const itemsRoute = await import("@/app/api/admin/recordings/collections/[id]/items/route");
const playRoute = await import("@/app/api/admin/recordings/route");
const audioRoute = await import("@/app/api/admin/recordings/audio/route");
const storageRoute = await import("@/app/api/admin/recordings/audio/storage/route");
const { auditLogs, calls } = await import("@/db/schema");
const { callStars, recordingAudio } = await import("@/db/schema-library");
const audio = await import("@/lib/recordings/audio");
const { SESSION_COOKIE_NAME } = await import("@/lib/auth/session");
const { CALLER_ROLE_ID, OBSERVER_ROLE_ID, SUPERVISOR_ROLE_ID, defaultPermissionsConfig } =
  await import("@/lib/permissions/defaults");
const { getSetting, setSetting } = await import("@/lib/settings");
type PermissionsConfig = import("@/lib/permissions/types").PermissionsConfig;

const base = "http://localhost/api/admin/recordings";
const LINE = "551013_chef";
const KB = 1024;

/** Un faux MP3 : un en-tête de trame MPEG, puis du remplissage. */
function fakeMp3(size: number, fill = 7): Buffer {
  const buf = Buffer.alloc(size, fill);
  buf[0] = 0xff;
  buf[1] = 0xe3;
  return buf;
}

/** Ce que voip.ms répond à getCallRecording : l'audio en base64 dans un champ. */
function payload(buf: Buffer) {
  return { status: "success", recording: buf.toString("base64") };
}

function json(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Account = { id: string; role: "admin" | "caller"; tokenVersion: number };

async function loginAs(user: Account | null): Promise<void> {
  ctx.cookies.clear();
  if (!user) return;
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
}

let seq = 0;
async function makeCall(overrides: Partial<typeof calls.$inferInsert> = {}) {
  seq += 1;
  const [row] = await testDb
    .insert(calls)
    .values({
      userId: chef.id,
      direction: "outbound",
      startedAt: new Date("2026-09-09T14:00:00Z"),
      answeredAt: new Date("2026-09-09T14:00:05Z"),
      durationSec: 240,
      recordingUrl: recordingRef(LINE, `r-${seq}`),
      ...overrides,
    })
    .returning();
  return row;
}

async function audioRow(callId: string) {
  const [row] = await testDb.select().from(recordingAudio).where(eq(recordingAudio.callId, callId));
  return row ?? null;
}

const star = async (callId: string) => {
  const res = await starRoute.POST(json(`${base}/star`, "POST", { callId }));
  await flushAfterResponse();
  return res;
};
const unstar = async (callId: string) => {
  const res = await starRoute.DELETE(json(`${base}/star`, "DELETE", { callId }));
  await flushAfterResponse();
  return res;
};
const keep = (callId: string) => audioRoute.POST(json(`${base}/audio`, "POST", { callId }));
const remove = (callId: string) => audioRoute.DELETE(json(`${base}/audio`, "DELETE", { callId }));
const play = async (call: { id: string; recordingUrl: string | null }, range?: string) => {
  const url = `${base}?url=${encodeURIComponent(call.recordingUrl!)}&callId=${call.id}`;
  const res = await playRoute.GET(new NextRequest(url, range ? { headers: { range } } : {}));
  await flushAfterResponse();
  return res;
};

let patron: Awaited<ReturnType<typeof makeUser>>;
let chef: Awaited<ReturnType<typeof makeUser>>;
let luc: Awaited<ReturnType<typeof makeUser>>;
let stagiaire: Awaited<ReturnType<typeof makeUser>>;

/** Le téléphoniste peut ÉCOUTER mais pas ranger ; le superviseur fait les deux. */
async function writeConfig(patch?: (cfg: PermissionsConfig) => PermissionsConfig): Promise<void> {
  const cfgBase = defaultPermissionsConfig();
  const cfg: PermissionsConfig = {
    ...cfgBase,
    roles: cfgBase.roles.map((r) =>
      r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, "clients.recordings": true } } : r,
    ),
    userRoles: {
      [chef.id]: SUPERVISOR_ROLE_ID,
      [luc.id]: CALLER_ROLE_ID,
      [stagiaire.id]: OBSERVER_ROLE_ID,
    },
  };
  await setSetting("permissions", patch ? patch(cfg) : cfg);
}

beforeEach(async () => {
  await resetDb();
  patron = await makeUser({ name: "Alex-Honoré", role: "admin" });
  chef = await makeUser({ name: "Chef", role: "caller", sipUsername: LINE });
  luc = await makeUser({ name: "Luc", role: "caller" });
  stagiaire = await makeUser({ name: "Stagiaire", role: "caller" });
  await writeConfig();
  await setSetting("recordings", {});
  vi.mocked(getCallRecordingFile).mockReset();
  vi.mocked(getCallRecordingFile).mockImplementation(async () => payload(fakeMp3(4 * KB)));
  await loginAs(chef);
});

afterEach(async () => {
  await flushAfterResponse();
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("garder automatiquement", () => {
  it("marquer un appel garde son audio — une seule fois, même marqué par deux", async () => {
    const call = await makeCall();
    await star(call.id);

    const row = await audioRow(call.id);
    expect(row?.bytes).toBe(4 * KB);
    expect(row?.audio?.equals(fakeMp3(4 * KB))).toBe(true);
    expect(row?.contentType).toBe("audio/mpeg");
    expect(row?.sourceRef).toBe(call.recordingUrl);

    await loginAs(luc);
    await star(call.id);
    expect(getCallRecordingFile).toHaveBeenCalledTimes(1);
  });

  it("un appel sans enregistrement : rien à garder, et voip.ms n'est pas dérangé", async () => {
    const call = await makeCall({ recordingUrl: null });
    await star(call.id);
    expect(await audioRow(call.id)).toBeNull();
    expect(getCallRecordingFile).not.toHaveBeenCalled();
  });

  it("ranger un appel dans un dossier garde aussi son audio", async () => {
    const call = await makeCall();
    const created = await collectionsRoute.POST(
      json(`${base}/collections`, "POST", { kind: "folder", name: "Formation" }),
    );
    const { collection } = (await created.json()) as { collection: { id: string } };
    await itemsRoute.POST(json(`${base}/collections/${collection.id}/items`, "POST", { callId: call.id }), {
      params: Promise.resolve({ id: collection.id }),
    });
    await flushAfterResponse();

    expect((await audioRow(call.id))?.bytes).toBe(4 * KB);
  });

  it("le ramassage garde la bibliothèque qui n'a pas encore sa copie — et rien d'autre", async () => {
    // Marqués sans passer par la route : aucune copie n'a été prise.
    const a = await makeCall();
    const b = await makeCall();
    const outside = await makeCall();
    await testDb.insert(callStars).values([
      { callId: a.id, userId: chef.id },
      { callId: b.id, userId: luc.id },
    ]);

    const result = await audio.keepPendingAudio();
    expect(result).toEqual({ kept: 2, failed: 0, capReached: false });
    expect((await audioRow(a.id))?.bytes).toBe(4 * KB);
    expect((await audioRow(b.id))?.bytes).toBe(4 * KB);
    expect(await audioRow(outside.id)).toBeNull();
  });

  it("voip.ms en panne : rien d'écrit, et le ramassage le compte", async () => {
    const call = await makeCall();
    await testDb.insert(callStars).values({ callId: call.id, userId: chef.id });
    vi.mocked(getCallRecordingFile).mockRejectedValue(new Error("timeout"));

    expect(await audio.keepPendingAudio()).toEqual({ kept: 0, failed: 1, capReached: false });
    expect(await audioRow(call.id)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("l'écoute", () => {
  it("sert la copie conservée sans déranger voip.ms — et la trace quand même", async () => {
    const call = await makeCall();
    await star(call.id);
    vi.mocked(getCallRecordingFile).mockClear();

    const res = await play(call);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(fakeMp3(4 * KB))).toBe(true);
    expect(getCallRecordingFile).not.toHaveBeenCalled();

    const partial = await play(call, "bytes=0-99");
    expect(partial.status).toBe(206);
    expect((await partial.arrayBuffer()).byteLength).toBe(100);

    const plays = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "recording.play"));
    expect(plays).toHaveLength(2);
    expect((plays[0].detail as { source?: string }).source).toBe("kept");
  });

  it("garde au passage l'audio d'un appel de la bibliothèque qu'on écoute", async () => {
    const call = await makeCall();
    await testDb.insert(callStars).values({ callId: call.id, userId: chef.id });

    await play(call);
    expect(getCallRecordingFile).toHaveBeenCalledTimes(1);
    expect((await audioRow(call.id))?.bytes).toBe(4 * KB);
  });

  it("n'en garde aucun pour un appel HORS de la bibliothèque", async () => {
    const call = await makeCall();
    await play(call);
    expect(await audioRow(call.id)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("retirer", () => {
  it("rend la place ; l'écoute repasse par voip.ms SANS reprendre la copie", async () => {
    const call = await makeCall();
    await star(call.id);

    const res = await remove(call.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bytes: 4 * KB });
    const row = await audioRow(call.id);
    expect(row?.audio).toBeNull();
    expect(row?.bytes).toBe(0);
    expect(row?.removedById).toBe(chef.id);
    expect((await audio.audioUsage()).bytes).toBe(0);

    vi.mocked(getCallRecordingFile).mockClear();
    expect((await play(call)).status).toBe(200);
    expect(getCallRecordingFile).toHaveBeenCalledTimes(1);
    // Ni l'écoute ni le ramassage ne reprennent un audio retiré.
    await audio.keepPendingAudio();
    expect((await audioRow(call.id))?.audio).toBeNull();
  });

  it("« Conserver » est le seul geste qui le reprend", async () => {
    const call = await makeCall();
    await star(call.id);
    await remove(call.id);

    const res = await keep(call.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "kept" });
    const row = await audioRow(call.id);
    expect(row?.bytes).toBe(4 * KB);
    expect(row?.removedAt).toBeNull();
  });

  it("retirer ce qui n'est pas conservé : 404", async () => {
    const call = await makeCall();
    expect((await remove(call.id)).status).toBe(404);
  });

  it("laisse une trace nominative", async () => {
    const call = await makeCall();
    await star(call.id);
    await remove(call.id);
    await keep(call.id);
    const actions = (await testDb.select().from(auditLogs))
      .filter((l) => l.action.startsWith("recording_audio."))
      .map((l) => `${l.action}:${l.userId === chef.id}`);
    expect(actions).toEqual(["recording_audio.remove:true", "recording_audio.keep:true"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("le plafond", () => {
  it("au plafond on cesse de conserver — on ne remplit jamais", async () => {
    await setSetting("recordings", { audioCapMb: 1 });
    vi.mocked(getCallRecordingFile).mockImplementation(async () => payload(fakeMp3(600 * KB)));
    const a = await makeCall();
    const b = await makeCall();

    await star(a.id);
    await star(b.id);
    expect((await audioRow(a.id))?.bytes).toBe(600 * KB);
    expect(await audioRow(b.id)).toBeNull();
    expect((await audio.audioUsage()).bytes).toBe(600 * KB);

    // Et le bouton explicite le dit au lieu de se taire.
    expect(await (await keep(b.id)).json()).toEqual({ status: "cap_reached" });
  });

  it("plafond à 0 : rien n'est gardé, et voip.ms n'est même pas interrogé", async () => {
    await setSetting("recordings", { audioCapMb: 0 });
    const call = await makeCall();
    await star(call.id);
    expect(await audioRow(call.id)).toBeNull();
    expect(getCallRecordingFile).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("le ménage", () => {
  it("la dernière étoile retirée rend la place ; une autre étoile la garde", async () => {
    const call = await makeCall();
    await star(call.id);
    await loginAs(luc);
    await star(call.id);

    await unstar(call.id);
    expect((await audioRow(call.id))?.bytes).toBe(4 * KB);

    await loginAs(chef);
    await unstar(call.id);
    expect(await audioRow(call.id)).toBeNull();
  });

  it("supprimer un dossier rend la place de ses appels non marqués", async () => {
    const filedOnly = await makeCall();
    const alsoStarred = await makeCall();
    const created = await collectionsRoute.POST(
      json(`${base}/collections`, "POST", { kind: "folder", name: "Formation" }),
    );
    const { collection } = (await created.json()) as { collection: { id: string } };
    for (const c of [filedOnly, alsoStarred]) {
      await itemsRoute.POST(json(`${base}/collections/${collection.id}/items`, "POST", { callId: c.id }), {
        params: Promise.resolve({ id: collection.id }),
      });
    }
    await star(alsoStarred.id);

    await collectionRoute.DELETE(json(`${base}/collections/${collection.id}`, "DELETE"), {
      params: Promise.resolve({ id: collection.id }),
    });
    await flushAfterResponse();

    expect(await audioRow(filedOnly.id)).toBeNull();
    expect((await audioRow(alsoStarred.id))?.bytes).toBe(4 * KB);
  });

  it("supprimer l'appel emporte sa copie", async () => {
    const call = await makeCall();
    await star(call.id);
    await testDb.delete(calls).where(eq(calls.id, call.id));
    expect(await testDb.select().from(recordingAudio)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("les gardes", () => {
  it("garder ou retirer demande le droit de RANGER", async () => {
    const call = await makeCall();
    await star(call.id);
    await loginAs(luc);
    expect((await keep(call.id)).status).toBe(403);
    expect((await remove(call.id)).status).toBe(403);
  });

  it("sur une fiche invisible : INTROUVABLE, pas « interdit »", async () => {
    const fiche = await makeClient({ fullName: "Client du patron", assignedToId: patron.id });
    const call = await makeCall({ userId: patron.id, clientId: fiche.id });
    await testDb.insert(callStars).values({ callId: call.id, userId: patron.id });
    await audio.keepPendingAudio();

    // Luc reçoit le droit de ranger — il ne voit toujours pas les fiches du patron.
    await writeConfig((cfg) => ({
      ...cfg,
      roles: cfg.roles.map((r) =>
        r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, "clients.recordingsCurate": true } } : r,
      ),
    }));
    await loginAs(luc);
    const res = await remove(call.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect((await audioRow(call.id))?.bytes).toBe(4 * KB);
  });

  it("la jauge est réservée à qui configure l'application", async () => {
    await loginAs(luc);
    expect((await storageRoute.GET()).status).toBe(403);
    expect((await storageRoute.DELETE()).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la jauge", () => {
  it("compte les octets conservés, et « tout retirer » les rend", async () => {
    const a = await makeCall();
    const b = await makeCall();
    await star(a.id);
    await star(b.id);

    await loginAs(patron);
    expect(await (await storageRoute.GET()).json()).toEqual({
      bytes: 8 * KB,
      calls: 2,
      capBytes: 200 * audio.MB,
    });

    const res = await storageRoute.DELETE();
    expect(await res.json()).toEqual({ ok: true, calls: 2, bytes: 8 * KB });
    expect(await (await storageRoute.GET()).json()).toMatchObject({ bytes: 0, calls: 0 });
    // Chacune se souvient du retrait : le ramassage ne les reprend pas.
    await audio.keepPendingAudio();
    expect((await audio.audioUsage()).bytes).toBe(0);
  });

  it("le plafond se règle, se borne, et se trace", async () => {
    await loginAs(patron);
    const patch = (body: unknown) =>
      storageRoute.PATCH(json(`${base}/audio/storage`, "PATCH", body));

    expect((await patch({ capMb: 50 })).status).toBe(200);
    expect((await getSetting("recordings")).audioCapMb).toBe(50);
    expect((await patch({ capMb: -1 })).status).toBe(422);
    expect((await patch({ capMb: 1.5 })).status).toBe(422);

    const [log] = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "recording_audio.cap"));
    expect(log.detail).toEqual({ from: 200, to: 50 });
  });
});
