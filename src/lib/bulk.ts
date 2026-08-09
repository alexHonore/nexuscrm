/**
 * Taille maximale d'un lot pour les actions en masse (assigner, catégoriser,
 * changer la source, supprimer).
 *
 * Partagé entre le serveur (qui refuse au-delà) et l'UI (qui découpe la
 * sélection en lots) : sans cette valeur commune, sélectionner plus de fiches
 * que la limite échouait avec une erreur générique.
 */
export const BULK_MAX = 200;
