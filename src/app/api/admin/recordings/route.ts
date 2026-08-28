import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiPerm, clientRef, grantsOnClient } from "@/lib/permissions/server";
import {
  extractRecordingAudio,
  getCallRecordingFile,
  parseRecordingRef,
  sniffAudioType,
} from "@/lib/voipms";

export const dynamic = "force-dynamic";
// Le téléchargement passe par l'API voip.ms, qui peut être lente.
export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Renvoie un extrait d'octets quand le lecteur demande une plage (seek). */
function rangeResponse(buf: Buffer, range: string | null, contentType: string) {
  const headers = new Headers({
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  });
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m) {
    headers.set("content-length", String(buf.length));
    return new NextResponse(new Uint8Array(buf), { status: 200, headers });
  }
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= buf.length) {
    headers.set("content-range", `bytes */${buf.length}`);
    return new NextResponse(null, { status: 416, headers });
  }
  const slice = buf.subarray(start, end + 1);
  headers.set("content-range", `bytes ${start}-${end}/${buf.length}`);
  headers.set("content-length", String(slice.length));
  return new NextResponse(new Uint8Array(slice), { status: 206, headers });
}

/**
 * GET /api/admin/recordings?url=<référence>&callId=<uuid>
 *
 * Écoute d'un enregistrement d'appel, réservée au droit `clients.recordings`
 * et auditée à chaque lecture. Deux formes de référence :
 *   - `https://…voip.ms/…`  : URL directe (relayée en continu, avec Range) ;
 *   - `voipms:<compte>:<id>` : voip.ms ne donne pas d'URL — l'audio est
 *     retéléchargé via l'API puis servi ici. C'est le cas réel en production.
 * L'URL voip.ms n'est jamais exposée au navigateur.
 */
export async function GET(req: NextRequest) {
  const actor = await apiPerm("clients.recordings");
  if (actor instanceof NextResponse) return actor;

  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "missing_url" }, { status: 400 });
  }
  const rawCallId = req.nextUrl.searchParams.get("callId");
  const callId = rawCallId && UUID_RE.test(rawCallId) ? rawCallId : undefined;

  /**
   * La référence vient de l'URL : sans cette vérification, le droit
   * `clients.recordings` ouvrait TOUT le compte voip.ms, y compris l'appel
   * d'une fiche que la matrice cache à ce regard. On exige donc que la
   * référence corresponde à un appel RÉEL, et que la fiche derrière cet appel
   * ouvre son historique — c'est la case qui gouverne déjà le fil d'appels sur
   * la fiche. Un appel sans fiche (numéro inconnu, appel entrant non rattaché)
   * reste écoutable : il n'y a pas de fiche à protéger derrière.
   *
   * Réponse indistincte en cas de refus : « introuvable », comme partout
   * ailleurs — dire « interdit » confirmerait que l'enregistrement existe.
   */
  const call = await db.query.calls.findFirst({
    where: callId ? eq(calls.id, callId) : eq(calls.recordingUrl, rawUrl),
    columns: { id: true, clientId: true, recordingUrl: true },
  });
  if (!call || call.recordingUrl !== rawUrl) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (call.clientId) {
    const ref = await clientRef(call.clientId);
    const grants = ref ? await grantsOnClient(actor, ref) : null;
    if (!grants || !grants.visible || !grants.history) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }
  const range = req.headers.get("range");

  // Chaque écoute est tracée, quelle que soit la forme de la référence.
  const audit = (detail: Record<string, unknown>) =>
    logAudit({
      userId: actor.user.id,
      action: "recording.play",
      entity: "call",
      entityId: callId,
      detail,
    });

  // ── Référence interne : retéléchargement par l'API voip.ms ──
  const ref = parseRecordingRef(rawUrl);
  if (ref) {
    await audit({ account: ref.account, recording: ref.callrecording });
    let payload;
    try {
      payload = await getCallRecordingFile(ref.account, ref.callrecording);
    } catch (err) {
      return NextResponse.json(
        { error: "upstream_error", detail: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }

    const audio = extractRecordingAudio(payload);
    if ("base64" in audio) {
      const buf = Buffer.from(audio.base64, "base64");
      return rangeResponse(buf, range, sniffAudioType(buf));
    }
    if ("url" in audio) {
      const upstream = await fetch(audio.url, {
        headers: range ? { range } : {},
        cache: "no-store",
      }).catch(() => null);
      if (!upstream?.ok || !upstream.body) {
        return NextResponse.json({ error: "upstream_error" }, { status: 502 });
      }
      const headers = new Headers({ "cache-control": "private, max-age=3600" });
      const ct = upstream.headers.get("content-type");
      headers.set("content-type", ct?.startsWith("audio/") ? ct : "audio/mpeg");
      for (const h of ["content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }
      return new NextResponse(upstream.body, { status: upstream.status, headers });
    }
    // Format inattendu : on renvoie les NOMS de champs, jamais les valeurs.
    return NextResponse.json(
      { error: "unsupported_payload", fields: audio.fields },
      { status: 502 },
    );
  }

  // ── URL voip.ms directe (forme historique) ──
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const hostOk =
    target.protocol === "https:" &&
    (target.hostname === "voip.ms" || target.hostname.endsWith(".voip.ms"));
  if (!hostOk) {
    return NextResponse.json({ error: "forbidden_host" }, { status: 400 });
  }

  await audit({ url: target.toString() });

  const upstreamHeaders: Record<string, string> = {};
  if (range) upstreamHeaders.range = range;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { headers: upstreamHeaders, cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  headers.set(
    "content-type",
    contentType && contentType.startsWith("audio/") ? contentType : "audio/mpeg",
  );
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "private, max-age=3600");

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
