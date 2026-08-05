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
 */
export function VizTheme() {
  const css = `
.nx-viz {
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
  return `var(--viz-d-${key}, #6b7280)`;
}
