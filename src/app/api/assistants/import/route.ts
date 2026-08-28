import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { importAssistant, previewImport } from "@/lib/assistants/transfer";
import { paramDocText } from "@/lib/docs/locale";
import { getParamDoc } from "@/lib/docs/params";
import { glossIssues, normalizeIssues, withReceivedValues } from "@/lib/import-diagnostics";
import { requestDocLocale } from "@/lib/locale-server";
import { apiPerm } from "@/lib/permissions/server";

/**
 * POST /api/assistants/import — prévisualise ou importe un fichier.
 *
 * Deux temps volontairement séparés : `preview` ne touche à rien et sert à
 * choisir les liaisons ; `commit` écrit. Sans ce détour, un fichier venu d'une
 * autre base rattacherait des rendez-vous à des identifiants qui, ici,
 * désignent quelqu'un d'autre.
 *
 * Un seul garde pour les deux modes, celui d'ÉCRITURE : la prévisualisation
 * n'est pas une lecture du CRM, c'est le premier temps d'un import. Qui ne peut
 * pas valider n'a aucune raison d'en préparer les liaisons.
 */

/**
 * Une erreur de schéma, rendue exploitable.
 *
 * Le zod brut disait « Invalid input: expected string, received undefined »
 * sur un chemin en tableau, et le client n'en montrait rien : l'import
 * échouait sur « ce fichier n'est pas valide ». On rend maintenant le chemin,
 * ce que le fichier contenait vraiment à cet endroit, et le NOM du champ tel
 * que la référence l'écrit — dans la langue de l'écran. Le numéro de ligne,
 * lui, est calculé côté client : c'est lui qui a le texte du fichier.
 */
async function describeBundleIssues(error: z.ZodError, bundle: unknown) {
  const locale = await requestDocLocale();
  return glossIssues(withReceivedValues(normalizeIssues(error.issues), bundle), (path) => {
    // SEULEMENT sous « assistant. » : la référence documente la configuration,
    // pas l'enveloppe du document. « objectionPacks » existe aux deux niveaux
    // et n'y désigne pas la même chose — glosé sans ce garde-fou, un problème
    // sur la liste racine s'expliquait par la fiche d'un champ de config.
    if (!path.startsWith("assistant.")) return undefined;
    const doc = getParamDoc(path.slice("assistant.".length));
    if (!doc) return undefined;
    const text = paramDocText(doc, locale);
    return { label: text.label, what: text.what };
  });
}

const bodySchema = z.object({
  mode: z.enum(["preview", "commit"]).default("preview"),
  bundle: z.unknown(),
  /** valeur d'origine → identifiant local choisi. */
  resolution: z.record(z.string(), z.string().nullable()).default({}),
  nameOverride: z.string().trim().min(1).max(120).optional(),
  runSuite: z.boolean().default(true),
});

export async function POST(req: Request) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    if (parsed.data.mode === "preview") {
      // Les liaisons déjà choisies passent : les avertissements décrivent ce
      // qui sera VRAIMENT écrit, pas un état où rien n'est résolu.
      const preview = await previewImport(parsed.data.bundle, parsed.data.resolution);
      return NextResponse.json(preview);
    }

    const result = await importAssistant(parsed.data.bundle, {
      actorId: actor.user.id,
      resolution: parsed.data.resolution,
      nameOverride: parsed.data.nameOverride,
      runSuite: parsed.data.runSuite,
    });
    await logAudit({
      userId: actor.user.id,
      action: "assistant.import",
      entity: "assistant",
      entityId: result.assistantId,
      detail: {
        warnings: result.warnings.map((w) => w.code),
        compiled: result.compiled,
        suitePassed: result.suitePassed,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Un fichier mal formé est une erreur de l'appelant, pas du serveur.
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_bundle", issues: await describeBundleIssues(err, parsed.data.bundle) },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "import_failed";
    return NextResponse.json({ error: "import_failed", message }, { status: 500 });
  }
}

/** La suite peut prendre plusieurs minutes : même marge que /suite. */
export const maxDuration = 300;
