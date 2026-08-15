import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/phone";
import {
  getAccountBalance,
  getProvinces,
  getRateCentersCan,
  searchDidsCan,
  type VoipMsAvailableDid,
} from "@/lib/voipms";
import { voipmsErrorResponse } from "../../_helpers";

/** La recherche de numéros d'un centre de tarification est lente chez voip.ms. */
export const maxDuration = 60;

/**
 * Vitrine des numéros EN VENTE chez voip.ms (achat sans passer par le portail).
 * Cascade pilotée par la requête :
 *   - sans paramètre           → provinces + solde du compte (c'est lui qui paie)
 *   - ?province=QC             → centres de tarification de la province
 *   - ?province=QC&ratecenter= → numéros disponibles, prix des deux barèmes
 */

/** « 0.85 » → 0.85 ; absent ou illisible → null (l'UI affiche alors « — »). */
function price(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMarketDid(d: VoipMsAvailableDid) {
  const did = String(d.did);
  return {
    did,
    e164: normalizePhone(did),
    ratecenter: typeof d.ratecenter === "string" ? d.ratecenter : "",
    sms: d.sms !== undefined && String(d.sms) === "1",
    prices: {
      perminute: {
        monthly: price(d.perminute_monthly),
        setup: price(d.perminute_setup),
        minute: price(d.perminute_minute),
      },
      flat: {
        monthly: price(d.flat_monthly),
        setup: price(d.flat_setup),
        minute: price(d.flat_minute),
      },
    },
  };
}

export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const url = new URL(req.url);
  const province = (url.searchParams.get("province") ?? "").trim().toUpperCase();
  const ratecenter = (url.searchParams.get("ratecenter") ?? "").trim();

  try {
    if (!province) {
      // Le solde est décoratif : son échec ne doit jamais bloquer la recherche.
      const [provinces, balance] = await Promise.all([
        getProvinces(),
        getAccountBalance().catch(() => null),
      ]);
      return NextResponse.json({ provinces, balance });
    }

    if (!ratecenter) {
      const ratecenters = await getRateCentersCan(province);
      return NextResponse.json({
        // Une entrée sans nom donnerait une option « undefined » qui échouerait
        // à la recherche : on l'écarte plutôt que de l'afficher.
        ratecenters: ratecenters
          .filter((r) => typeof r.ratecenter === "string" && r.ratecenter.trim() !== "")
          .map((r) => ({ ratecenter: String(r.ratecenter) })),
      });
    }

    const dids = (await searchDidsCan(province, ratecenter)).map(toMarketDid);
    dids.sort((a, b) => a.did.localeCompare(b.did));
    return NextResponse.json({ dids });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
