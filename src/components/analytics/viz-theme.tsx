import type { Disposition } from "@/db/schema";

/**
 * Thème des visualisations — variables CSS locales au conteneur `.nx-viz`.
 *
 * Couleurs de séries validées avec le validateur dataviz (bande de luminosité,
 * séparation daltonisme, contraste sur surface) en mode clair ET sombre :
 * - appels connectés : bleu (slot 1) ; non connectés : gris de mise en retrait
 *   (forme « emphase » — 1 teinte + gris) ;
 * - RDV : orange (slot 2) ; minutes/téléphoniste : bleu (série nominale unique).
 * Les couleurs de dispositions viennent de src/lib/dispositions.ts (identité
 * produit) ; les tons trop sombres pour la surface sombre reçoivent un pas
 * plus clair de la même teinte.
 *
 * ── Les quatre SOURCES DE DÉPENSE (`--viz-src-*`) ────────────────────────────
 *
 * Une source de dépense = une teinte, la même partout sur la page de
 * consommation : dans la pile des journées, dans la barre de répartition, dans
 * la légende, dans le tableau. La couleur suit l'ENTITÉ, jamais son rang — un
 * filtre qui retire une source ne repeint pas les autres.
 *
 * **L'ORDRE DE LA PILE EST PORTEUR.** Ces quatre teintes ne passent le
 * validateur que sur la liste des paires VOISINES : orange (SMS) et jaune
 * (notes d'appel) mesurent ΔE 13,7 en vision normale, sous le plancher de 15.
 * Elles sont donc empilées avec DEUX séries entre elles —
 * SMS → téléphonie → assistants → notes — pour qu'il faille une journée sans
 * aucune téléphonie ET sans aucun assistant (c'est-à-dire sans appel, donc sans
 * note d'appel non plus) pour qu'elles se touchent. Conséquence : ces quatre
 * teintes ne s'utilisent QUE dans des formes voisines (pile, barre de
 * répartition), jamais dans un nuage de points ou de petits multiples, où
 * n'importe quelle paire peut se retrouver côte à côte.
 *
 * Le contraste du jaune (2,17:1) et de l'aqua (2,82:1) passe sous 3:1 sur la
 * surface claire : la règle de compensation s'applique, et elle est tenue — la
 * légende porte les MONTANTS et un tableau jour par jour double le graphique.
 *
 * ── Les cinq FAMILLES D'ACTIVITÉ (`--viz-act-*`) ─────────────────────────────
 *
 * Une famille d'activité = un geste qu'on a posé dans le CRM : un appel, un
 * RDV, un texto, une note, une fiche. Le graphique « Activité » les empile sur
 * une frise ; chaque teinte suit l'ENTITÉ et ne bouge jamais, même quand un
 * filtre vide une des cinq bandes.
 *
 * Trois de ces teintes ne sont PAS choisies ici — elles sont reprises, parce
 * qu'elles ont déjà un sens ailleurs et qu'une même chose ne change pas de
 * couleur en changeant de carte :
 * - appels : le bleu de `--viz-answered` / `--viz-user`, sur la même page ;
 * - RDV : l'orange de `--viz-rdv`, sur la même page ;
 * - SMS : le violet de `CHANNEL_LOOK.sms` (`src/components/look.tsx`), ramené
 *   dans la bande de luminosité des visualisations. C'est le même sens — « ceci
 *   sort de l'application » — et non un emprunt.
 *
 * **L'ORDRE DE LA PILE EST PORTEUR**, comme pour les sources de dépense.
 * L'ordre appels → RDV → SMS → notes → fiches est celui qui passe le
 * validateur dataviz sur la liste des paires VOISINES, dans les deux modes :
 * pire paire daltonisme ΔE 16,3 clair / 13,2 sombre (plancher 8), pire paire
 * vision normale ΔE 19,6 clair / 19,3 sombre (plancher 15). Intervertir deux
 * bandes rapprocherait le jaune (notes) de l'orange (RDV) — la paire qui
 * mesure ΔE 13,7 en vision normale, sous le plancher. Ne pas réordonner sans
 * relancer le validateur.
 *
 * Le jaune (2,11:1) et le magenta (2,62:1) passent sous 3:1 sur la surface
 * claire : la règle de compensation s'applique, et elle est tenue — la légende
 * porte les DÉCOMPTES et les parts, et chaque pictogramme double son libellé.
 */
export function VizTheme() {
  const css = `
.nx-viz {
  --viz-src-sms: #eb6834;
  --viz-src-telephony: #2a78d6;
  --viz-src-ai: #1baf7a;
  --viz-src-notes: #eda100;
  --viz-act-calls: #2a78d6;
  --viz-act-bookings: #eb6834;
  --viz-act-sms: #4a3aa7;
  --viz-act-notes: #eda100;
  --viz-act-records: #e87ba4;
  --viz-deemph: #898781;
  --viz-answered: #2a78d6;
  --viz-missed: #898781;
  --viz-rdv: #eb6834;
  --viz-user: #2a78d6;
  --viz-d-booked: #16a34a;
  --viz-d-callback: #f59e0b;
  --viz-d-voicemail: #3b82f6;
  --viz-d-no_answer: #94a3b8;
  --viz-d-not_interested: #ef4444;
  --viz-d-not_qualified: #6b7280;
  --viz-d-dncl: #1e293b;
}
.dark .nx-viz {
  --viz-src-sms: #d95926;
  --viz-src-telephony: #3987e5;
  --viz-src-ai: #199e70;
  --viz-src-notes: #c98500;
  --viz-act-calls: #3987e5;
  --viz-act-bookings: #d95926;
  --viz-act-sms: #9085e9;
  --viz-act-notes: #c98500;
  --viz-act-records: #d55181;
  --viz-deemph: #82807a;
  --viz-answered: #3987e5;
  --viz-missed: #82807a;
  --viz-rdv: #d95926;
  --viz-user: #3987e5;
  --viz-d-dncl: #64748b;
}
`;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/** Couleur CSS (var) d'une disposition, adaptée clair/sombre dans `.nx-viz`. */
export function dispositionColorVar(key: Disposition | string): string {
  // Seules les 7 anciennes valeurs ont une variable ; une valeur arbitraire
  // (ex. « cat:12 » orpheline) produirait un nom CSS invalide — gris direct.
  return /^[a-zA-Z0-9_-]+$/.test(key) ? `var(--viz-d-${key}, #6b7280)` : "#6b7280";
}
