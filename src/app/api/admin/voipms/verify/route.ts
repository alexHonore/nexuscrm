import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { apiPerm } from "@/lib/permissions/server";
import { getDids, getSubAccounts, type VoipMsDid, type VoipMsSubAccount } from "@/lib/voipms";
import { readJson, toAdminUser, voipmsErrorResponse } from "../../_helpers";
import { sipGatewayConfigured } from "../../users/_phone-status";
import { didKey } from "../_assignments";
import { findSubAccount, resyncSipPassword, withVoipTimeout } from "../_provisioning";

/**
 * « Vérifier la ligne » — confronte ce que le CRM a enregistré à ce que
 * voip.ms rapporte VRAIMENT. C'est la seule façon de répondre à « son
 * téléphone marche-t-il ? » sans décrocher le combiné.
 *
 * Le résultat est une liste de contrôles structurée ; l'UI la rend en
 * ✓/✗ + explication en français. Aucun secret ne sort d'ici.
 */

export const maxDuration = 60;

type CheckKey = "gateway" | "subaccount" | "password" | "did" | "routing";
type CheckStatus = "ok" | "fail" | "warn" | "unknown";

type Check = {
  key: CheckKey;
  status: CheckStatus;
  /** Slug stable traduit par l'UI (`users.verify.reasons.<reason>`). */
  reason: string;
  /** Donnée d'appoint affichable (cible de routage) — jamais un secret. */
  value?: string;
};

/** "account:551013_alex" → "551013_alex" ; "sys:…"/autre → tel quel. */
function routingTarget(routing: string | null | undefined): { target: string; isAccount: boolean } | null {
  const raw = routing?.trim();
  if (!raw) return null;
  const m = raw.match(/^account:(.+)$/i);
  return m ? { target: m[1], isAccount: true } : { target: raw, isAccount: false };
}

const querySchema = z.object({ userId: z.uuid() });

export async function GET(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const parsed = querySchema.safeParse({
    userId: new URL(req.url).searchParams.get("userId") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "validation" }, { status: 422 });

  const target = await db.query.users.findFirst({ where: eq(users.id, parsed.data.userId) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const checks: Check[] = [];

  // 1. Passerelle SIP-WSS — sans elle, aucun poste ne peut appeler.
  const gateway = sipGatewayConfigured();
  checks.push({ key: "gateway", status: gateway ? "ok" : "fail", reason: gateway ? "gateway_ok" : "gateway_missing" });

  // Les DID sont accessoires : si `getDIDsInfo` échoue, le reste du
  // diagnostic reste utile — on ne fait pas tout tomber pour autant.
  const [subsResult, didsResult] = await Promise.allSettled([
    withVoipTimeout(getSubAccounts()),
    withVoipTimeout(getDids()),
  ]);
  // Sans la liste des sous-comptes il n'y a rien à vérifier : erreur explicite
  // (« voip.ms ne répond pas ») plutôt qu'un diagnostic trompeur.
  if (subsResult.status === "rejected") return voipmsErrorResponse(subsResult.reason);
  const accounts: VoipMsSubAccount[] = subsResult.value;
  const dids: PromiseSettledResult<VoipMsDid[]> = didsResult;

  // 2. Le sous-compte existe-t-il réellement chez voip.ms ?
  const existing = findSubAccount(accounts, target.sipUsername);
  if (!target.sipUsername) {
    checks.push({ key: "subaccount", status: "fail", reason: "sip_missing" });
  } else if (!existing) {
    checks.push({ key: "subaccount", status: "fail", reason: "sub_not_found", value: target.sipUsername });
  } else {
    checks.push({ key: "subaccount", status: "ok", reason: "sub_ok", value: existing.account });
  }

  // 3. Le mot de passe stocké est-il celui que voip.ms utilise ?
  let canResync = false;
  if (!existing) {
    checks.push({ key: "password", status: "unknown", reason: "password_no_subaccount" });
  } else if (!target.sipPasswordEnc) {
    checks.push({ key: "password", status: "fail", reason: "password_missing" });
    canResync = true;
  } else if (!existing.password) {
    // voip.ms ne renvoie pas toujours le mot de passe dans la liste.
    checks.push({ key: "password", status: "unknown", reason: "password_unknown" });
  } else {
    let stored: string | null = null;
    try {
      stored = decryptSecret(target.sipPasswordEnc);
    } catch {
      stored = null;
    }
    if (stored === null) {
      checks.push({ key: "password", status: "fail", reason: "password_unreadable" });
      canResync = true;
    } else if (stored === existing.password) {
      checks.push({ key: "password", status: "ok", reason: "password_ok" });
    } else {
      checks.push({ key: "password", status: "fail", reason: "password_mismatch" });
      canResync = true;
    }
  }

  // 4. Un numéro (DID) est-il attribué ? Sans lui : appels sortants seulement.
  const hasDid = Boolean(target.didNumber);
  checks.push({
    key: "did",
    status: hasDid ? "ok" : "warn",
    reason: hasDid ? "did_ok" : "did_missing",
    ...(target.didNumber ? { value: target.didNumber } : {}),
  });

  // 5. Le routage entrant du DID pointe-t-il sur CE sous-compte ?
  const wantedKey = didKey(target.didNumber);
  if (!hasDid) {
    checks.push({ key: "routing", status: "unknown", reason: "routing_no_did" });
  } else if (dids.status === "rejected") {
    checks.push({ key: "routing", status: "unknown", reason: "routing_unavailable" });
  } else {
    const did = dids.value.find((d) => didKey(d.did) === wantedKey);
    const routing = routingTarget(did?.routing);
    const account = existing?.account ?? target.sipUsername ?? "";
    if (!did) {
      checks.push({ key: "routing", status: "fail", reason: "routing_did_unknown" });
    } else if (!routing) {
      checks.push({ key: "routing", status: "fail", reason: "routing_none" });
    } else if (!routing.isAccount) {
      checks.push({ key: "routing", status: "warn", reason: "routing_other", value: routing.target });
    } else if (routing.target.toLowerCase() === account.toLowerCase()) {
      checks.push({ key: "routing", status: "ok", reason: "routing_ok", value: routing.target });
    } else if (!routing.target.includes("_")) {
      checks.push({ key: "routing", status: "fail", reason: "routing_main", value: routing.target });
    } else {
      checks.push({ key: "routing", status: "fail", reason: "routing_elsewhere", value: routing.target });
    }
  }

  await logAudit({
    userId: actor.user.id,
    action: "voipms.line_verify",
    entity: "user",
    entityId: target.id,
    detail: { checks: checks.map((c) => ({ key: c.key, status: c.status, reason: c.reason })) },
  });

  return NextResponse.json({
    /** true = la personne peut appeler ET recevoir. */
    ok: checks.every((c) => c.status === "ok"),
    /** true = elle peut au moins passer des appels sortants. */
    canCall: checks
      .filter((c) => c.key === "gateway" || c.key === "subaccount" || c.key === "password")
      .every((c) => c.status !== "fail"),
    checks,
    canResync,
    user: toAdminUser(target, gateway),
  });
}

const resyncSchema = z.object({ userId: z.uuid() });

/**
 * « Resynchroniser » — enregistre le mot de passe que voip.ms utilise
 * réellement, pour que le softphone puisse enfin s'enregistrer.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, resyncSchema);
  if (body instanceof NextResponse) return body;

  const target = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const { account } = await withVoipTimeout(resyncSipPassword(target));

    await logAudit({
      userId: actor.user.id,
      action: "voipms.password_resync",
      entity: "user",
      entityId: target.id,
      detail: { account },
    });

    const [updated] = await db.select().from(users).where(eq(users.id, target.id));
    return NextResponse.json({ account, user: toAdminUser(updated) });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
