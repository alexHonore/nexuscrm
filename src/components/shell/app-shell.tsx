import { PERMISSION_KEYS } from "@/lib/permissions/catalog";
import { requireActor } from "@/lib/permissions/server";
import {
  AppShellClient,
  type ShellPerms,
  type ShellRole,
  type ShellUser,
} from "./app-shell-client";

export type { ShellPerms, ShellRole, ShellUser };

/**
 * La coquille, côté serveur.
 *
 * Elle ne dessine rien : elle RÉSOUT les droits du regard courant et les passe
 * à la coquille cliente. Le menu cessait d'être une liste figée le jour où les
 * rôles sont devenus configurables — « es-tu administrateur » ne répond plus à
 * « as-tu le droit d'ouvrir cet écran », et un superviseur doit voir
 * l'analytique sans voir les réglages.
 *
 * Le tableau part ENTIER (34 booléens, la matrice de celui qui regarde et de
 * personne d'autre) plutôt que réduit aux droits que le menu utilise
 * aujourd'hui : ajouter une entrée au menu se fait alors dans le seul fichier
 * du menu, sans qu'on oublie de venir compléter cette liste-ci — un oubli qui
 * ne se verrait pas, l'entrée disparaissant simplement pour tout le monde.
 *
 * Cacher une entrée n'est PAS la protéger : chaque page derrière ces liens
 * refait la vérification (`requirePerm`). Le menu ne fait qu'éviter de
 * promener quelqu'un vers une porte qui lui sera fermée.
 *
 * Les props sont exactement celles de la coquille précédente : le layout du
 * groupe (app) est gelé et continue de passer `user` et `unreadCount`.
 */
export async function AppShell({
  user,
  unreadCount,
  children,
}: {
  user: ShellUser;
  unreadCount: number;
  children: React.ReactNode;
}) {
  // Le layout a déjà exigé une session ; `requireActor` la relit du cache de la
  // requête et n'ajoute donc aucun aller-retour en base.
  const actor = await requireActor();
  const perms: ShellPerms = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, actor.can(key)]),
  );

  return (
    <AppShellClient
      user={user}
      unreadCount={unreadCount}
      perms={perms}
      role={{ look: actor.role.look, nameFr: actor.role.nameFr, nameEn: actor.role.nameEn }}
    >
      {children}
    </AppShellClient>
  );
}
