import { z } from "zod";
import { QUALIFICATION_FIELDS } from "@/lib/assistants/schema";
import { detectOptOut } from "@/lib/sms/optout";
import { contactValue } from "./contact-data";

/**
 * Classification d'un tour entrant (§12.4) — appel séparé au modèle
 * CLASSIFIEUR, avant le générateur.
 *
 * Trois décisions, dans cet ordre de gravité :
 *  1. désabonnement  → on s'arrête et on supprime le numéro ;
 *  2. refus FERME    → clôture polie, la chaîne d'objectifs n'est PAS touchée ;
 *  3. refus MOU      → un cran plus bas dans la chaîne.
 *
 * La différence entre ferme et mou est la décision la plus lourde du moteur :
 * se tromper en la sous-estimant, c'est relancer quelqu'un qui a dit non. Le
 * mot-clé exact (STOP, ARRÊT…) est donc tranché en CODE avant tout appel
 * modèle — déterministe, jamais une question d'interprétation — et le modèle
 * n'arbitre que le langage naturel.
 *
 * Module pur : `generate` est injecté.
 */

export const classificationSchema = z.object({
  /** Désabonnement explicite ou équivalent en langage naturel. */
  optOut: z.boolean().default(false),
  /**
   * none = poursuit normalement · soft = « pas maintenant », reporte ·
   * hard = « non », « pas intéressé », « arrêtez » — refus clair de poursuivre.
   */
  refusal: z.enum(["none", "soft", "hard"]).default("none"),
  /** Champs de qualification extraits du message. */
  // partialRecord : les clés sont contraintes à QUALIFICATION_FIELDS mais
  // aucune n'est obligatoire — un message ne révèle presque jamais tout.
  // Les VALEURS sont du texte du contact qui finira dans le prompt système :
  // une ligne, bornée — tronquée plutôt que refusée, sinon une valeur trop
  // longue rendrait toute la classification illisible et effacerait un refus.
  qualification: z
    .partialRecord(z.enum(QUALIFICATION_FIELDS), z.string().transform((v) => contactValue(v)))
    .default({}),
  /** La personne demande explicitement à parler à un humain. */
  wantsHuman: z.boolean().default(false),
  /** Message incompréhensible (compté pour l'escalade après trois de suite). */
  unintelligible: z.boolean().default(false),
});
export type Classification = z.infer<typeof classificationSchema>;

export type ClassifyGenerate = (prompt: { system: string; user: string }) => Promise<string>;

const SYSTEM = `Tu classes UN message reçu par SMS dans une conversation de suivi immobilier au Québec.
Tu réponds UNIQUEMENT par un objet JSON, sans texte autour, exactement de cette forme :
{"optOut": false, "refusal": "none", "qualification": {}, "wantsHuman": false, "unintelligible": false}

« refusal » :
- "hard" : refus clair de poursuivre — « non merci », « pas intéressé », « arrêtez », « enlevez-moi de vos listes », hostilité.
- "soft" : reporte sans refuser — « pas cette semaine », « je suis occupé », « rappelez-moi plus tard », « peut-être en juin ».
- "none" : tout le reste, y compris une question ou une réponse partielle.
En cas de doute entre "hard" et "soft", choisis "hard" : mieux vaut arrêter trop tôt que harceler.

« optOut » : true SEULEMENT pour une demande explicite de ne plus recevoir de messages — « arrêtez de m'écrire », « désabonnez-moi », « ne me recontactez plus ». Un refus, même définitif et poli (« j'ai acheté ailleurs », « c'est réglé, merci », « plus intéressé »), n'est PAS un désabonnement : c'est refusal "hard" avec optOut false — la personne décline l'offre, elle n'interdit pas qu'on lui réponde.
« wantsHuman » : true si la personne demande à parler à quelqu'un, au courtier, ou à être appelée par un humain.
« unintelligible » : true si le message n'a aucun sens exploitable.

« qualification » : uniquement ce que le message affirme RÉELLEMENT. N'invente rien, n'infère rien.
Clés permises : project_type (acheter/vendre/les_deux), timing, budget, sector, financing, current_situation, email, preferred_time.`;

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Classe le tour entrant. Le mot-clé de désabonnement est tranché en code
 * AVANT le modèle : un « STOP » ne doit jamais dépendre d'une interprétation
 * ni d'un fournisseur joignable.
 *
 * Si le modèle échoue ou bafouille, on retombe sur une classification neutre
 * (`refusal: "none"`) SAUF pour le désabonnement déjà détecté : une panne ne
 * doit pas inventer un refus, mais elle ne doit pas non plus en effacer un.
 */
export async function classifyInbound(
  inbound: string,
  generate: ClassifyGenerate,
): Promise<{ classification: Classification; modelUsed: boolean; error?: string }> {
  const keyword = detectOptOut(inbound);

  let raw: string;
  try {
    raw = await generate({ system: SYSTEM, user: inbound });
  } catch (err) {
    return {
      classification: classificationSchema.parse({
        optOut: keyword.optOut,
        refusal: keyword.optOut ? "hard" : "none",
      }),
      modelUsed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = classificationSchema.safeParse(extractJson(raw));
  if (!parsed.success) {
    return {
      classification: classificationSchema.parse({
        optOut: keyword.optOut,
        refusal: keyword.optOut ? "hard" : "none",
      }),
      modelUsed: false,
      error: "classifier_unparseable",
    };
  }

  // Le mot-clé exact l'emporte toujours : le modèle peut ajouter un
  // désabonnement, jamais en retirer un.
  const classification: Classification = {
    ...parsed.data,
    optOut: parsed.data.optOut || keyword.optOut,
    refusal: keyword.optOut ? "hard" : parsed.data.refusal,
  };
  return { classification, modelUsed: true };
}
