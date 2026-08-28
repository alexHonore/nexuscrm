/**
 * Unitaire — aucune clé brute ne peut atteindre l'écran de délivrabilité.
 *
 * Le rendu de test ne charge QUE le paquet français : une clé qui n'existe
 * qu'en français y passe sans un bruit, et c'est un administrateur anglophone
 * qui découvre `deliverability.numbers.title` au milieu d'un tableau. Ici, les
 * clés sont vérifiées STATIQUEMENT et dans LES DEUX langues.
 *
 * Les clés construites (`deliverability.metric.${id}.label`) sont le vrai
 * danger : elles ne se voient qu'à l'exécution, et seulement pour la valeur
 * qu'on a eu la chance de rencontrer. On les développe ici sur tout le
 * vocabulaire — vingt-neuf indicateurs, quatre verdicts, cinq familles —
 * plutôt que sur celui qui traînait dans la fixture.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import adminEn from "../messages/en/admin.json";
import adminFr from "../messages/fr/admin.json";
import commonEn from "../messages/en/common.json";
import commonFr from "../messages/fr/common.json";
import { RANGE_DAYS } from "@/lib/deliverability/range";
import {
  FINDING_FAMILIES,
  METRIC_IDS,
  PROVENANCES,
  VERDICTS,
} from "@/lib/deliverability/types";

const FILES = [
  "src/app/(app)/admin/deliverability/page.tsx",
  "src/components/admin/deliverability-metrics.tsx",
  "src/components/admin/deliverability-findings.tsx",
  "src/components/admin/deliverability-templates.tsx",
  "src/components/admin/deliverability-twilio-card.tsx",
];

function lookup(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[part];
  }, bundle);
}

/** Les clés littérales `t("deliverability.…")`, gabarits exclus. */
function literalKeys(source: string): string[] {
  return [...source.matchAll(/\bt(?:\.\w+)?\(\s*"(deliverability\.[^"$]+)"/g)].map((m) => m[1]);
}

/**
 * Les clés CONSTRUITES, développées sur tout le vocabulaire.
 *
 * Chaque entrée correspond à un gabarit réellement écrit dans un des fichiers
 * ci-dessus ; le dernier cas du fichier vérifie qu'aucun gabarit n'a été
 * oublié ici.
 */
const CONSTRUCTED: string[] = [
  ...METRIC_IDS.flatMap((id) => [
    `deliverability.metric.${id}.label`,
    `deliverability.metric.${id}.hint`,
  ]),
  ...VERDICTS.map((v) => `deliverability.verdict.${v}`),
  ...VERDICTS.map((v) => `deliverability.verdictHint.${v}`),
  ...FINDING_FAMILIES.map((f) => `deliverability.family.${f}`),
  ...PROVENANCES.map((p) => `deliverability.provenance.${p}`),
  ...RANGE_DAYS.map((d) => `deliverability.period.d${d}`),
  ...["overview", "numbers", "content", "templates", "twilio"].map(
    (s) => `deliverability.tabs.${s}`,
  ),
  // Raisons de non-envoi réellement écrites par le moteur. Une raison inconnue
  // s'affiche telle quelle — pas de clé, pas de plantage.
  ...[
    "kill_switch",
    "suppressed",
    "invalid_to",
    "sandbox_not_allowlisted",
    "not_sent",
    "twilio_message_not_found",
    "provider_rejected",
    "transport_error",
    "dry_run",
  ].map((r) => `deliverability.skipped.r.${r}`),
  // Colonnes du tableau par numéro — la clé est construite depuis
  // `NUMBER_COLUMNS` dans `deliverability-metrics.tsx`.
  ...["delivered", "filtered", "noDlr", "ucs2", "cap"].map(
    (c) => `deliverability.numbers.${c}`,
  ),
];

describe("clés de l'écran de délivrabilité", () => {
  const used = [...new Set(FILES.flatMap((f) => literalKeys(readFileSync(f, "utf8"))))];

  it("le balayage trouve bien des clés", () => {
    // Un extracteur cassé passerait en silence et ne vérifierait plus rien.
    expect(used.length, "aucune clé trouvée : l'extracteur ne lit plus les écrans").toBeGreaterThan(20);
  });

  it("chaque clé littérale existe en français ET en anglais", () => {
    const missing: string[] = [];
    for (const key of used) {
      if (typeof lookup(adminFr, key) !== "string") missing.push(`fr → ${key}`);
      if (typeof lookup(adminEn, key) !== "string") missing.push(`en → ${key}`);
    }
    expect(missing, `Clés absentes du paquet admin :\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("chaque clé CONSTRUITE existe pour toutes ses valeurs, dans les deux langues", () => {
    const missing: string[] = [];
    for (const key of CONSTRUCTED) {
      if (typeof lookup(adminFr, key) !== "string") missing.push(`fr → ${key}`);
      if (typeof lookup(adminEn, key) !== "string") missing.push(`en → ${key}`);
    }
    expect(
      missing,
      `Une clé construite manque : elle ne se verrait qu'en production, et seulement ` +
        `pour la valeur concernée :\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("l'entrée de navigation existe dans les deux langues", () => {
    expect(typeof lookup(commonFr, "nav.deliverability")).toBe("string");
    expect(typeof lookup(commonEn, "nav.deliverability")).toBe("string");
  });

  it("aucun gabarit de clé n'échappe à la liste des clés construites", () => {
    // Un `t(\`deliverability.…${x}\`)` ajouté sans entrée ci-dessus rendrait la
    // vérification partielle sans que rien ne le signale.
    const templates = FILES.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/\bt(?:\.\w+)?\(\s*`(deliverability\.[^`]*\$\{[^`]*)`/g)].map(
        (m) => `${file} : ${m[1]}`,
      );
    });
    const known = new Set([
      "deliverability.metric.",
      "deliverability.verdict.",
      "deliverability.verdictHint.",
      "deliverability.family.",
      "deliverability.provenance.",
      "deliverability.period.d",
      "deliverability.tabs.",
      "deliverability.skipped.r.",
      "deliverability.numbers.",
    ]);
    const unknown = templates.filter(
      (t) => ![...known].some((prefix) => t.includes(prefix)),
    );
    expect(
      unknown,
      `Gabarits non couverts par CONSTRUCTED :\n  ${unknown.join("\n  ")}`,
    ).toEqual([]);
  });
});
