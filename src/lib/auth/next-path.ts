/**
 * La destination qu'on avait demandée avant d'être renvoyé vers /login.
 *
 * Elle traverse une redirection du proxy, une page publique et un formulaire :
 * autrement dit, elle est ENTIÈREMENT sous le contrôle de qui envoie le lien.
 * Une telle valeur ne peut pas être passée telle quelle à `redirect()` — ce
 * serait offrir une redirection ouverte depuis notre propre page de connexion,
 * la meilleure adresse possible pour un hameçonnage (« nexus vous demande de
 * vous reconnecter », et l'on repart chez quelqu'un d'autre).
 *
 * D'où une liste blanche de FORME plutôt qu'une liste noire de motifs : un
 * seul « / » initial, aucun deuxième, aucun caractère de contrôle. Cela laisse
 * passer /clients/<uuid>?tab=sms et refuse //evil.example, /\evil.example,
 * https://evil.example et javascript:… sans avoir à les énumérer.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Un chemin qui n'est pas une adresse relative à nous : refusé sans discuter.
  if (!raw.startsWith("/")) return null;
  // « //hôte » et « /\hôte » sont des adresses ABSOLUES pour le navigateur,
  // bien qu'elles commencent par une barre oblique.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Retours chariot et caractères de contrôle : de quoi couper un en-tête.
  // Écrits en échappements plutôt qu'en littéraux : un octet de contrôle collé
  // dans une classe de caractères est invisible à la relecture et se lit comme
  // un intervalle innocent — celui-ci refusait tout chemin contenant un tiret.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  // Repartir vers /login refermerait la boucle sur elle-même.
  if (raw === "/login" || raw.startsWith("/login?")) return null;
  return raw;
}

/** Là où l'on va après une connexion réussie — la demande, ou le tableau de bord. */
export function afterLoginPath(raw: string | null | undefined): string {
  return safeNextPath(raw) ?? "/dashboard";
}
