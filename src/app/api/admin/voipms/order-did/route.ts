import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { normalizePhone } from "@/lib/phone";
import {
  didDigits,
  getDids,
  getServersInfo,
  orderDid,
  routeDidToSubAccount,
  sipDomain,
  updateSubAccountCallerId,
  VoipMsError,
  type VoipMsDid,
} from "@/lib/voipms";
import { readJson, toAdminUser, voipmsErrorResponse } from "../../_helpers";
import { releaseDidFromOthers } from "../_assignments";
import { provisionSipLine, withVoipTimeout, type ProvisionResult } from "../_provisioning";

/**
 * La commande enchaîne jusqu'à quatre appels voip.ms, chacun borné à 45 s par
 * `withVoipTimeout` — et leur API dépasse régulièrement la minute. Une limite
 * de 60 s couperait la requête EN PLEIN ACHAT : c'est le seul geste de l'app
 * qui dépense de l'argent, mieux vaut le laisser aller jusqu'au bout.
 */
export const maxDuration = 300;

const schema = z.object({
  userId: z.uuid(),
  /** Numéro choisi dans la vitrine (10 chiffres ou E.164). */
  did: z.string().trim().min(7).max(32),
  billingType: z.enum(["perminute", "flat"]).default("perminute"),
});

/**
 * POP (serveur voip.ms) du nouveau numéro : celui de la passerelle
 * (VOIPMS_SIP_DOMAIN), sinon celui des numéros déjà en service, sinon le
 * serveur recommandé par voip.ms. Sans candidat, on refuse plutôt que de
 * commander vers un serveur arbitraire.
 */
async function defaultPop(owned: VoipMsDid[]): Promise<string | number> {
  const domain = sipDomain().toLowerCase();
  const ownedPop = owned.find((d) => d.pop)?.pop;
  try {
    const servers = await getServersInfo();
    const match = servers.find((s) => (s.server_hostname ?? "").trim().toLowerCase() === domain);
    if (match?.server_pop) return match.server_pop;
    if (ownedPop) return ownedPop;
    const recommended = servers.find(
      (s) => String(s.server_recommended) === "1" || s.server_recommended === true,
    );
    if (recommended?.server_pop) return recommended.server_pop;
  } catch (err) {
    // Un POP déjà en service reste un choix sûr ; sinon la VRAIE cause (souvent
    // « ip_not_enabled ») doit remonter telle quelle, pas déguisée en « no_pop ».
    if (ownedPop) return ownedPop;
    throw err;
  }
  // Aucun candidat crédible : on refuse plutôt que d'acheter un numéro hébergé
  // sur un serveur sans rapport avec la passerelle (le premier de la liste peut
  // être aux États-Unis alors que la passerelle est à Montréal).
  throw new VoipMsError("no_pop", "Impossible de déterminer le serveur (POP) du numéro");
}

/**
 * Le numéro est-il (finalement) arrivé sur le compte ? Relu deux fois à
 * quelques secondes d'intervalle : après une commande dont la réponse s'est
 * perdue, voip.ms ne liste pas toujours le numéro dans la seconde qui suit, et
 * conclure trop vite ferait racheter un numéro déjà payé.
 */
async function didLandedOnAccount(wantedDigits: string): Promise<boolean> {
  for (const waitMs of [0, 3_000]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const list = await withVoipTimeout(getDids().catch(() => [] as VoipMsDid[]));
    if (list.some((d) => didDigits(d.did) === wantedDigits)) return true;
  }
  return false;
}

/**
 * ACHÈTE un numéro chez voip.ms (débité du solde prépayé du compte principal),
 * le route vers la ligne SIP de l'utilisateur — provisionnée d'abord si elle
 * n'existe pas — puis l'attribue dans le CRM. Rejouable sans double achat : un
 * numéro déjà présent sur le compte est simplement routé et attribué.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const target = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  const didE164 = normalizePhone(body.did);
  if (!didE164) return NextResponse.json({ error: "invalid_did" }, { status: 422 });

  let account = target.sipUsername;
  let provision: ProvisionResult | null = null;
  let alreadyOwned = false;

  try {
    // 1. Le routage exige une ligne SIP : au besoin elle est créée d'abord
    //    (idempotent et auto-réparateur — voir _provisioning.ts).
    if (!account) {
      provision = await withVoipTimeout(provisionSipLine(target));
      account = provision.account;
    }

    // 2. Rejeu sûr : un numéro DÉJÀ sur le compte (commande précédente dont la
    //    réponse s'est perdue, ou numéro acheté au portail) n'est pas racheté.
    //    Cette lecture est BLOQUANTE : sans elle on ne sait pas si le numéro
    //    est déjà payé, et « dans le doute on commande » ferait payer deux
    //    fois. Mieux vaut refuser et laisser l'admin réessayer.
    const owned = await withVoipTimeout(getDids());
    const wanted = didDigits(didE164);
    alreadyOwned = owned.some((d) => didDigits(d.did) === wanted);

    if (alreadyOwned) {
      await withVoipTimeout(routeDidToSubAccount(didE164, account));
    } else {
      const pop = await withVoipTimeout(defaultPop(owned));
      let recovered = false;
      try {
        // Budget PLUS LARGE que les autres appels : couper une commande en
        // vol ne l'annule pas chez voip.ms (le débit a lieu quand même), ça
        // ne fait que nous priver de la réponse.
        await withVoipTimeout(
          orderDid({ did: didE164, account, pop, billingType: body.billingType }),
          120_000,
        );
      } catch (err) {
        // L'achat a pu aboutir malgré l'erreur (réponse perdue) : on relit la
        // liste avant d'abandonner — même philosophie que les sous-comptes.
        // Deux lectures espacées : voip.ms met parfois quelques secondes à
        // faire apparaître un numéro tout juste acheté.
        recovered = await didLandedOnAccount(wanted);
        if (!recovered) {
          // On n'a PAS pu confirmer — ce qui ne prouve pas que rien n'a été
          // débité. Le journal doit donc garder la trace de la tentative,
          // sinon un achat réel disparaîtrait sans laisser de trace.
          await logAudit({
            userId: actor.user.id,
            action: "voipms.did_order_failed",
            entity: "user",
            entityId: target.id,
            detail: {
              did: didE164,
              account,
              billingType: body.billingType,
              pop,
              status: err instanceof VoipMsError ? err.status : "unknown",
            },
          });
          throw err;
        }
      }

      // TRACE DU DÉBIT, écrite immédiatement : c'est ici que l'argent est
      // engagé. Tout ce qui suit (routage, identité d'appelant, attribution)
      // peut encore échouer ou être interrompu — le journal doit garder la
      // preuve de l'achat même dans ce cas.
      await logAudit({
        userId: actor.user.id,
        action: "voipms.did_purchase",
        entity: "user",
        entityId: target.id,
        detail: { did: didE164, account, billingType: body.billingType, pop, recovered },
      });

      // La commande route elle-même le numéro ; après récupération, non.
      if (recovered) await withVoipTimeout(routeDidToSubAccount(didE164, account));
    }
  } catch (err) {
    return voipmsErrorResponse(err);
  }

  // L'identité de l'appelant sortant suit le numéro. Meilleur effort : l'échec
  // n'annule pas un achat déjà débité, mais il est signalé à l'admin.
  let calleridUpdated = true;
  try {
    await updateSubAccountCallerId(account, didDigits(didE164));
  } catch {
    calleridUpdated = false;
  }

  // Un numéro n'appartient qu'à une personne : retrait de l'ancien détenteur
  // dans la MÊME transaction que l'attribution.
  const { updated, released } = await db.transaction(async (tx) => {
    const freed = await releaseDidFromOthers(tx, didE164, target.id);
    const [row] = await tx
      .update(users)
      .set({ didNumber: didE164, updatedAt: new Date() })
      .where(eq(users.id, target.id))
      .returning();
    return { updated: row, released: freed };
  });

  await logAudit({
    userId: actor.user.id,
    action: "voipms.did_order",
    entity: "user",
    entityId: target.id,
    detail: {
      did: didE164,
      account,
      billingType: body.billingType,
      alreadyOwned,
      lineProvisioned: Boolean(provision),
      calleridUpdated,
      ...(released.length > 0 ? { releasedFrom: released } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    did: didE164,
    account,
    alreadyOwned,
    calleridUpdated,
    released,
    /** Ligne créée au passage : mot de passe SIP en clair, montré UNE fois. */
    provision,
    user: toAdminUser(updated),
  });
}
