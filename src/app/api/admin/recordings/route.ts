import { type NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/recordings?url=<url voip.ms>&callId=<uuid>
 * Proxy de lecture des enregistrements d'appels : l'admin écoute via l'app
 * sans exposer l'URL voip.ms au navigateur d'un tiers. Hôte strictement
 * limité à voip.ms ; chaque écoute est auditée (rattachée à l'appel via
 * callId quand il est fourni).
 */
export async function GET(req: NextRequest) {
  const auth = await apiAdmin();
  if (auth instanceof NextResponse) return auth;

  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "missing_url" }, { status: 400 });
  }
  const rawCallId = req.nextUrl.searchParams.get("callId");
  const callId = rawCallId && UUID_RE.test(rawCallId) ? rawCallId : undefined;

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

  await logAudit({
    userId: auth.id,
    action: "recording.play",
    entity: "call",
    entityId: callId,
    detail: { url: target.toString() },
  });

  // Transfert de l'en-tête Range pour permettre l'avance rapide dans <audio>.
  const upstreamHeaders: Record<string, string> = {};
  const range = req.headers.get("range");
  if (range) upstreamHeaders.range = range;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      headers: upstreamHeaders,
      cache: "no-store",
    });
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
