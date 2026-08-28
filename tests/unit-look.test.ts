/**
 * Unitaire — le vocabulaire visuel de la configuration.
 *
 * Ce que ces tests protègent : un concept AJOUTÉ au produit (un huitième
 * outil, un objectif de plus) doit recevoir son pictogramme, sinon il
 * réapparaît en texte gris au milieu d'une liste illustrée — pire que si rien
 * n'était illustré, parce que l'œil saute alors la ligne sans image.
 *
 * Et une règle qui ne se relâche pas : la couleur ne porte JAMAIS le sens
 * toute seule. Elle groupe, elle accentue ; c'est le pictogramme et le libellé
 * qui identifient.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_STATUS_LOOK,
  ATTENTION_KIND_LOOK,
  ATTENTION_LOOK,
  CHANNEL_LOOK,
  CONVERSATION_STATE_LOOK,
  CREATE_MODE_TONE,
  DELIVERABILITY_LOOK,
  EDITOR_TAB_LOOK,
  GOAL_LOOK,
  GUARDRAIL_KIND_LOOK,
  LookGlyph,
  LookIcon,
  ORIGIN_LOOK,
  PERMISSION_GROUP_LOOK,
  QUEUE_KIND_LOOK,
  ROLE_LOOK,
  RESULT_LOOK,
  SEVERITY_LOOK,
  TONE,
  TOOL_LOOK,
  VERDICT_LOOK,
  lookTint,
} from "@/components/look";
import { ATTENTION_REASONS, attentionKindOf } from "@/components/conversations/state";
import { assistantStatusEnum } from "@/db/schema-sms";
import { ASSISTANT_TOOLS, GOAL_TYPES } from "@/lib/assistants/schema";
import { PERMISSION_GROUPS } from "@/lib/permissions/catalog";
import { defaultRoles } from "@/lib/permissions/defaults";
import { GUARDRAIL_KINDS, GUARDRAIL_SEVERITIES } from "@/lib/guardrails/types";
import { FINDING_FAMILIES, VERDICTS } from "@/lib/deliverability/types";

/**
 * Les trois lectures indépendantes d'une ligne de la liste des assistants :
 * en service, texte final à jour, dernier essai. Les clés portent leur axe en
 * préfixe parce que ce ne sont PAS des états qui s'excluent.
 */
const ASSISTANT_LIST_STATES = [
  ...assistantStatusEnum.enumValues,
  "compiled_fresh",
  "compiled_stale",
  "compiled_never",
  "suite_passed",
  "suite_failed",
];

const EDITOR_TABS = [
  "identity",
  "goal",
  "approach",
  "knowledge",
  "objections",
  "tools",
  "guardrails",
  "model",
  "prompt",
  "sandbox",
  "test",
  "json",
];

describe("couverture du vocabulaire", () => {
  it("chaque objectif du schéma a son pictogramme", () => {
    const missing = GOAL_TYPES.filter((g) => !GOAL_LOOK[g]);
    expect(missing, `objectifs sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque outil de l'agent a le sien", () => {
    const missing = ASSISTANT_TOOLS.filter((t) => !TOOL_LOOK[t]);
    expect(missing, `outils sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque sévérité de garde-fou a le sien", () => {
    const missing = GUARDRAIL_SEVERITIES.filter((s) => !SEVERITY_LOOK[s]);
    expect(missing, `sévérités sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque type de règle de garde-fou a le sien", () => {
    // Un neuvième type ajouté au moteur sans pictogramme réapparaîtrait en
    // texte gris au milieu de huit puces illustrées — l'œil saute la ligne.
    const missing = GUARDRAIL_KINDS.filter((k) => !GUARDRAIL_KIND_LOOK[k]);
    expect(missing, `types sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque onglet de l'éditeur a le sien", () => {
    const missing = EDITOR_TABS.filter((id) => !EDITOR_TAB_LOOK[id]);
    expect(missing, `onglets sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque lecture d'une ligne de la liste a le sien", () => {
    // Les trois statuts viennent de l'énumération Postgres : un quatrième
    // ajouté en base sans pictogramme réapparaîtrait en pastille grise au
    // milieu de cinq pastilles illustrées.
    const missing = ASSISTANT_LIST_STATES.filter((id) => !ASSISTANT_STATUS_LOOK[id]);
    expect(missing, `états sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque motif d'attention d'un fil a son pictogramme", () => {
    // Un vingt-et-unième motif écrit par le moteur sans look retomberait en
    // pastille grise au milieu de vingt puces illustrées.
    const missing = ATTENTION_REASONS.filter((r) => !ATTENTION_LOOK[r]);
    expect(missing, `motifs sans look : ${missing.join(", ")}`).toEqual([]);
  });

  it("les cinq états d'un fil et les deux familles de motifs ont le leur", () => {
    for (const state of ["attention", "human", "ai", "refused", "concluded"]) {
      expect(CONVERSATION_STATE_LOOK[state], state).toBeTruthy();
    }
    for (const kind of ["reply", "engine"] as const) {
      expect(ATTENTION_KIND_LOOK[kind], kind).toBeTruthy();
    }
  });

  it("les trois portes de la création ont leur teinte", () => {
    // Elles vivent dans le vocabulaire pour qu'aucun écran n'écrive un hex.
    for (const mode of ["ai", "simple", "complex"] as const) {
      expect(CREATE_MODE_TONE[mode], mode).toBeTruthy();
    }
  });
});

describe("discipline des couleurs", () => {
  it("les onglets se rangent dans les QUATRE familles, pas en douze couleurs", () => {
    // Douze couleurs dans une barre d'onglets font des confettis : on ne
    // retient rien. Quatre familles disent ce qui règle la parole de
    // l'assistant, ce qui le fait fonctionner, et ce qui le vérifie.
    const families = new Set(Object.values(TONE));
    for (const [id, look] of Object.entries(EDITOR_TAB_LOOK)) {
      expect(families, `${id} sort des familles`).toContain(look.color);
    }
    expect(new Set(Object.values(EDITOR_TAB_LOOK).map((l) => l.color)).size).toBeLessThanOrEqual(4);
  });

  it("le canal SMS a une couleur qui n'appartient à RIEN d'autre", () => {
    // Elle ne dit pas « important » — elle dit « ceci sort de l'application ».
    // La confondre avec une couleur de configuration la viderait de son sens.
    const everythingElse = [
      ...Object.values(TONE),
      ...Object.values(GOAL_LOOK).map((l) => l.color),
      ...Object.values(TOOL_LOOK).map((l) => l.color),
      ...Object.values(SEVERITY_LOOK).map((l) => l.color),
      ...Object.values(EDITOR_TAB_LOOK).map((l) => l.color),
      ...Object.values(ASSISTANT_STATUS_LOOK).map((l) => l.color),
      ...Object.values(CREATE_MODE_TONE),
      ...Object.values(ROLE_LOOK).map((l) => l.color),
      ...Object.values(PERMISSION_GROUP_LOOK).map((l) => l.color),
    ];
    expect(everythingElse).not.toContain(CHANNEL_LOOK.sms.color);
  });

  it("chaque rôle livré porte une pastille qui existe", () => {
    // Les rôles ne sont plus une énumération figée : l'administrateur en crée.
    // Ce qui reste fermé, c'est la liste des PASTILLES — un rôle choisit parmi
    // elles, il n'en invente pas. Un rôle livré qui pointerait vers une
    // pastille disparue s'afficherait sans rien.
    const missing = defaultRoles().filter((r) => !(r.look in ROLE_LOOK)).map((r) => r.id);
    expect(missing, `rôles sans pastille : ${missing.join(", ")}`).toEqual([]);
  });

  it("les quatre pastilles d'autorité se distinguent par la forme ET la teinte", () => {
    // Elles disent un NIVEAU (qui a les clés, qui ne fait que regarder) : deux
    // niveaux qui se ressemblent ne servent à rien.
    const icons = Object.values(ROLE_LOOK).map((l) => l.Icon);
    const colors = Object.values(ROLE_LOOK).map((l) => l.color);
    expect(new Set(icons).size, "deux rôles partagent un pictogramme").toBe(icons.length);
    expect(new Set(colors).size, "deux rôles partagent une teinte").toBe(colors.length);
  });

  it("chaque famille de droits a son pictogramme", () => {
    const missing = PERMISSION_GROUPS.filter((g) => !(g in PERMISSION_GROUP_LOOK));
    expect(missing, `familles sans pictogramme : ${missing.join(", ")}`).toEqual([]);
    // Jamais le violet réservé du canal SMS : il ne dit pas « messages ».
    for (const [key, look] of Object.entries(PERMISSION_GROUP_LOOK)) {
      expect(look.color, `${key} emprunte le violet du canal SMS`).not.toBe(CHANNEL_LOOK.sms.color);
    }
  });

  it("les trois sévérités sont un feu de circulation, jamais deux fois la même teinte", () => {
    const colors = GUARDRAIL_SEVERITIES.map((s) => SEVERITY_LOOK[s].color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("les huit types de règle se distinguent par le pictogramme, pas par la teinte", () => {
    // Trois types partagent le bleu et deux le cyan : c'est VOULU — la couleur
    // range les règles par ce qu'elles examinent (les mots, ce qui se compte).
    // Elle ne peut donc pas identifier, et le pictogramme doit être unique,
    // sinon deux types deviennent la même puce.
    const icons = GUARDRAIL_KINDS.map((k) => GUARDRAIL_KIND_LOOK[k].Icon);
    expect(new Set(icons).size, "deux types partagent un pictogramme").toBe(icons.length);
    expect(new Set(GUARDRAIL_KINDS.map((k) => GUARDRAIL_KIND_LOOK[k].color)).size)
      .toBeLessThan(GUARDRAIL_KINDS.length);
  });

  it("réussite/échec et généré/repris-à-la-main portent des formes opposées", () => {
    // Le rouge et le vert sont exactement la paire qu'un œil deutéranope ne
    // sépare pas : la coche et la croix doivent porter le sens toutes seules.
    expect(RESULT_LOOK.pass.Icon).not.toBe(RESULT_LOOK.fail.Icon);
    expect(RESULT_LOOK.pass.color).not.toBe(RESULT_LOOK.fail.color);
    expect(ORIGIN_LOOK.generated.Icon).not.toBe(ORIGIN_LOOK.handwritten.Icon);
    expect(ORIGIN_LOOK.generated.color).not.toBe(ORIGIN_LOOK.handwritten.color);
  });

  it("les motifs d'un fil se rangent par ce qu'il y a À FAIRE, pas en vingt couleurs", () => {
    // Ambre « répondre », rouge « réparer », vert/gris « terminé » : la
    // couleur dit le métier, le pictogramme identifie le motif — il est donc
    // unique, sinon deux motifs deviennent la même puce.
    const icons = ATTENTION_REASONS.map((r) => ATTENTION_LOOK[r].Icon);
    expect(new Set(icons).size, "deux motifs partagent un pictogramme").toBe(icons.length);
    expect(new Set(ATTENTION_REASONS.map((r) => ATTENTION_LOOK[r].color)).size)
      .toBeLessThanOrEqual(4);
    // Et la teinte d'un motif « à répondre » est celle de la famille
    // (l'en-tête de section dit la même chose que ses lignes).
    for (const reason of ATTENTION_REASONS) {
      const kind = attentionKindOf(reason);
      if (kind === "reply" || kind === "engine") {
        expect(ATTENTION_LOOK[reason].color, reason).toBe(ATTENTION_KIND_LOOK[kind].color);
      }
    }
  });

  it("la teinte douce dérive du concept, elle n'invente pas de hex", () => {
    // `lookTint` est la seule issue autorisée pour un fond teinté : si elle
    // cessait de dériver de `look.color`, les écrans reviendraient à écrire
    // leur propre hex — ce que ce fichier existe pour empêcher.
    const tint = lookTint(SEVERITY_LOOK.block);
    expect(tint.color).toBe(SEVERITY_LOOK.block.color);
    expect(tint.backgroundColor).toContain(SEVERITY_LOOK.block.color);
    expect(tint.borderColor).toContain(SEVERITY_LOOK.block.color);
  });

  it("aucune lecture de la liste ne se distingue par la SEULE couleur", () => {
    // Trois de ces huit lectures sont vertes et deux sont grises. C'est le
    // défaut qui existait avant : « prompt à jour » et « suite verte »
    // portaient la même coche verte, donc un œil qui ne sépare pas les
    // teintes — ou une capture en noir et blanc — lisait deux fois la même
    // chose. Un pictogramme par lecture, sans exception.
    const icons = ASSISTANT_LIST_STATES.map((id) => ASSISTANT_STATUS_LOOK[id].Icon);
    expect(new Set(icons).size, "deux lectures partagent un pictogramme").toBe(icons.length);
  });

  it("l'état de la liste reprend le feu de circulation, sans inventer de teinte", () => {
    // Vert « rien à faire », ambre « une action attend », rouge « ne pas
    // mettre en service », gris « pas encore en jeu ». Une cinquième teinte
    // ici voudrait dire qu'une lecture s'est mise à parler d'autre chose.
    const known = new Set<string>([
      TONE.raw,
      TONE.scrutiny,
      RESULT_LOOK.pass.color,
      RESULT_LOOK.fail.color,
    ]);
    for (const id of ASSISTANT_LIST_STATES) {
      expect(known, `${id} invente une teinte`).toContain(ASSISTANT_STATUS_LOOK[id].color);
    }
    expect(new Set(ASSISTANT_LIST_STATES.map((id) => ASSISTANT_STATUS_LOOK[id].color)).size)
      .toBeLessThanOrEqual(4);
  });
});

describe("un pictogramme ne remplace pas un libellé", () => {
  it("la pastille et le glyphe sont invisibles pour un lecteur d'écran", () => {
    // Ils DOUBLENT un texte voisin. Rendus « lisibles », ils feraient annoncer
    // deux fois la même chose ; laissés seuls sans texte, ils seraient une
    // devinette. La règle tient dans le composant, pas dans chaque appel.
    for (const [name, element] of [
      ["LookIcon", createElement(LookIcon, { look: GOAL_LOOK.video_meeting })],
      ["LookGlyph", createElement(LookGlyph, { look: GOAL_LOOK.video_meeting })],
    ] as const) {
      const html = renderToStaticMarkup(element);
      expect(html, name).toContain('aria-hidden="true"');
      expect(html, name).toContain("<svg");
    }
  });

  it("chaque pictogramme est un vrai composant, pas une chaîne oubliée", () => {
    for (const [key, look] of Object.entries({
      ...GOAL_LOOK,
      ...TOOL_LOOK,
      ...SEVERITY_LOOK,
      ...EDITOR_TAB_LOOK,
      ...ASSISTANT_STATUS_LOOK,
      ...GUARDRAIL_KIND_LOOK,
      ...RESULT_LOOK,
      ...ORIGIN_LOOK,
      ...ATTENTION_LOOK,
      ...CONVERSATION_STATE_LOOK,
      ...ATTENTION_KIND_LOOK,
      ...QUEUE_KIND_LOOK,
      ...VERDICT_LOOK,
      ...DELIVERABILITY_LOOK,
      ...ROLE_LOOK,
      ...PERMISSION_GROUP_LOOK,
      sms: CHANNEL_LOOK.sms,
    })) {
      expect(typeof look.Icon, `${key}.Icon`).not.toBe("string");
      expect(look.color, `${key}.color`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // Rendu pour de vrai : un nom d'icône disparu de lucide passerait le
      // typage et n'afficherait rien du tout.
      expect(renderToStaticMarkup(createElement(look.Icon)), key).toContain("<svg");
    }
  });
});

/** Tous les `.tsx` sous `src/components`, chemin relatif au dépôt. */
function componentFiles(dir = "src/components"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? componentFiles(join(dir, e.name))
      : e.name.endsWith(".tsx")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("le vocabulaire est le SEUL endroit où une couleur s'écrit", () => {
  it("aucun écran qui parle le vocabulaire n'écrit son propre hex", () => {
    // La discipline ne tient que si elle est vérifiée : un `#10B981` recopié
    // dans un écran survit à un changement de palette, et personne ne le
    // retrouve. Un écran qui a besoin d'une couleur ajoute son concept à
    // `look.tsx` — c'est le seul chemin.
    const consumers = componentFiles()
      .filter((f) => f !== join("src", "components", "look.tsx"))
      .map((f) => ({ file: f, source: readFileSync(f, "utf8") }))
      .filter(({ source }) => source.includes("@/components/look"));
    // Un balayage vide passerait sans rien vérifier.
    expect(consumers.length, "aucun écran ne parle le vocabulaire ?").toBeGreaterThan(5);
    const offenders = consumers
      .flatMap(({ file, source }) =>
        [...source.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => `${file} : ${m[0]}`),
      );
    expect(offenders, `hex écrits hors du vocabulaire :\n${offenders.join("\n")}`).toEqual([]);
  });
});

/**
 * Le tableau de bord de délivrabilité — deux axes indépendants.
 *
 * Ce qui casserait sans ces cas : la GRAVITÉ et la FAMILLE se mettraient à
 * partager une couleur, et la page virerait au rouge pour une apostrophe
 * courbe. Un écran de surveillance ne sert que s'il est encore ouvert le jour
 * où un vrai filtrage commence — le rendre alarmant en permanence est la façon
 * la plus sûre de le faire fermer.
 */
describe("vocabulaire de la délivrabilité", () => {
  it("les quatre verdicts et les cinq familles ont leur pictogramme", () => {
    for (const verdict of VERDICTS) {
      expect(VERDICT_LOOK[verdict], verdict).toBeTruthy();
    }
    for (const family of FINDING_FAMILIES) {
      expect(DELIVERABILITY_LOOK[family], family).toBeTruthy();
    }
  });

  it("« tout va bien » et « on ne sait pas » ne se ressemblent JAMAIS", () => {
    // C'est la règle qui justifie le quatrième verdict : un indicateur calculé
    // sur onze messages n'est pas vert, il est inconnu. Les confondre fait
    // croire qu'on surveille une chose qu'on ne surveille pas.
    expect(VERDICT_LOOK.unknown.color).not.toBe(VERDICT_LOOK.ok.color);
    expect(VERDICT_LOOK.unknown.Icon).not.toBe(VERDICT_LOOK.ok.Icon);
    const icons = Object.values(VERDICT_LOOK).map((l) => l.Icon);
    expect(new Set(icons).size, "deux verdicts partagent un pictogramme").toBe(icons.length);
    const colors = Object.values(VERDICT_LOOK).map((l) => l.color);
    expect(new Set(colors).size, "deux verdicts partagent une teinte").toBe(colors.length);
  });

  it("les cinq familles se distinguent par le pictogramme, pas par une palette neuve", () => {
    const icons = Object.values(DELIVERABILITY_LOOK).map((l) => l.Icon);
    expect(new Set(icons).size, "deux familles partagent un pictogramme").toBe(icons.length);

    // Aucune teinte inventée : un écran de surveillance emprunte le
    // vocabulaire existant, il n'ouvre pas une sixième palette.
    const allowed = new Set<string>([
      ...Object.values(TONE),
      SEVERITY_LOOK.block.color,
      RESULT_LOOK.pass.color,
      QUEUE_KIND_LOOK.send.color,
    ]);
    for (const [key, look] of Object.entries({ ...VERDICT_LOOK, ...DELIVERABILITY_LOOK })) {
      expect(allowed, `${key} invente une teinte`).toContain(look.color);
    }
  });

  it("aucune des deux cartes n'emprunte la couleur réservée au canal SMS", () => {
    // Le violet du SMS dit « ceci SORT de l'application ». Le réutiliser pour
    // un verdict ou une famille lui ferait perdre le seul sens qu'il porte.
    for (const [key, look] of Object.entries({ ...VERDICT_LOOK, ...DELIVERABILITY_LOOK })) {
      expect(look.color, `${key} emprunte la couleur du canal SMS`).not.toBe(CHANNEL_LOOK.sms.color);
    }
  });
});
