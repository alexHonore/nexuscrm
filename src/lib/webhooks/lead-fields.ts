/**
 * Les noms de champ que le webhook de leads accepte — module PUR.
 *
 * Une seule liste, lue par DEUX consommateurs : la route qui extrait les
 * champs (`/api/webhooks/leads`) et la référence publique qui les documente
 * (`/developers`). Recopier la liste dans la doc, c'était garantir qu'elle
 * mentirait au premier alias ajouté — et un intégrateur qui envoie
 * `numéro_de_téléphone` sur la foi d'une doc périmée ne reçoit pas d'erreur :
 * son lead entre sans téléphone.
 *
 * Les alias existent parce que les sources ne se parlent pas : Facebook Lead
 * Ads renvoie les libellés de question ACCENTUÉS et en toutes lettres
 * (« votre_projet_est_prévu_pour_quand_? »), n8n emballe dans `.data`, et un
 * formulaire de site web envoie `phone`. Refuser tout ça aurait fait porter la
 * traduction à chaque intégration.
 *
 * L'ORDRE compte : le premier alias trouvé gagne, et c'est le nom canonique
 * qui vient en tête.
 */
export const LEAD_FIELD_ALIASES = {
  name: ["name", "nom_complet", "full_name", "fullname", "nom"],
  phone: [
    "phone",
    "numéro_de_téléphone",
    "numero_de_telephone",
    "telephone",
    "téléphone",
    "phone_number",
  ],
  email: ["email", "e-mail", "courriel"],
  projectType: [
    "type",
    "quel_est_votre_besoin_?",
    "quel_est_votre_besoin?",
    "besoin",
    "project_type",
  ],
  timing: [
    "timing",
    "votre_projet_est_prévu_pour_quand_?",
    "votre_projet_est_prevu_pour_quand_?",
    "votre_projet_est_prévu_pour_quand?",
    "délai",
    "delai",
  ],
  source: ["source"],
  notes: ["notes", "note", "message"],
  city: ["city", "ville"],
} as const satisfies Record<string, readonly string[]>;

export type LeadField = keyof typeof LEAD_FIELD_ALIASES;

/**
 * Le SEUL champ sans lequel un lead n'existe pas.
 *
 * Un lead sans téléphone n'est pas un lead incomplet : c'est une fiche que
 * personne ne pourra jamais rappeler, et le CRM déduplique justement par
 * numéro. La route répond 422 plutôt que de créer un doublon muet.
 */
export const LEAD_REQUIRED_FIELD: LeadField = "phone";

/** Taille maximale du corps accepté, en octets. Au-delà : 413. */
export const LEAD_MAX_BODY_BYTES = 100_000;
