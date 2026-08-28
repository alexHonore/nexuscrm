import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { apiAdmin } from "@/lib/auth/guards";
import { collectTwilioProbes } from "@/lib/deliverability-server/twilio";
import { assessTwilio } from "@/lib/deliverability/assess";
import type { Finding, Probe, TwilioProbes } from "@/lib/deliverability/types";
import { docLocale } from "@/lib/docs/types";
import { jsonLogger } from "@/lib/sms-server";

/**
 * GET /api/admin/deliverability/twilio
 *   → `{ probes, findings }` : ce que le fournisseur dit de lui-même
 *     (compte, service de messagerie, bassin d'expéditeurs, campagne A2P,
 *     alertes) et les constats qui en découlent.
 *
 * Réservé à l'admin. Séparé de la page parce que ces cinq lectures passent par
 * le réseau : les faire au rendu retarderait un écran dont tout le reste vient
 * de la base.
 *
 * RÈGLE DE CETTE ROUTE : après la garde, un admin obtient TOUJOURS 200.
 *
 * Une clé absente, une console injoignable, un jeton sans la bonne portée sont
 * des ÉTATS de sonde — le vocabulaire `Probe` en distingue quatre exprès. Les
 * transformer en 500 ferait afficher « erreur » à l'îlot client là où la
 * réponse honnête est « Twilio n'a pas répondu », et l'admin passerait son
 * temps à recharger une page qui n'a rien de cassé. `tests/int-rbac.test.ts`
 * appelle d'ailleurs cette route avec `fetch` piégé pour lever : ni 401, ni
 * 403, ni exception.
 */

/** Toutes les sondes muettes : la réponse de repli quand la collecte elle-même a lâché. */
function degradedProbes(): TwilioProbes {
  const down: Probe<never> = { state: "unavailable", reason: "http" };
  return {
    account: down,
    service: down,
    senderPool: down,
    a2p: down,
    alerts: down,
    crmNumbers: [],
  };
}

export async function GET() {
  const guard = await apiAdmin();
  if (guard instanceof NextResponse) return guard;

  let probes: TwilioProbes;
  try {
    probes = await collectTwilioProbes();
  } catch (err) {
    // `collectTwilioProbes` rattrape déjà chaque appel HTTP ; arriver ici veut
    // dire que c'est la base ou l'environnement qui a lâché, pas Twilio.
    jsonLogger.warn("deliverability.twilio.collect_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    probes = degradedProbes();
  }

  let findings: Finding[] = [];
  try {
    // La langue de l'INTERFACE, pas celle d'un assistant : ces phrases sont
    // lues par le courtier dans l'application (règle 2 de AGENTS.md).
    findings = assessTwilio(probes, docLocale(await getLocale()));
  } catch (err) {
    // Le verdict est un plus ; les sondes brutes valent d'être rendues seules
    // plutôt que de faire disparaître la carte entière.
    jsonLogger.warn("deliverability.twilio.assess_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ probes, findings });
}
