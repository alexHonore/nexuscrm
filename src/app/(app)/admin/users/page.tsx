import { asc } from "drizzle-orm";
import { toAdminUser } from "@/app/api/admin/_helpers";
import { sipGatewayConfigured } from "@/app/api/admin/users/_phone-status";
import { OwnPasswordCard, UsersClient } from "@/components/admin/users-client";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { loadPermissions, roleForUser } from "@/lib/permissions/server";

export default async function AdminUsersPage() {
  // Gérer les comptes reste verrouillé à l'administrateur (`LOCKED_TO_ADMIN`) :
  // un rôle qui distribue les rôles se nommerait administrateur dans la minute.
  const admin = await requireAdmin();

  const [cfg, all] = await Promise.all([
    loadPermissions(),
    db.query.users.findMany({ orderBy: [asc(users.createdAt)] }),
  ]);
  // Booléen calculé UNE fois : la valeur de l'URL de passerelle ne quitte jamais le serveur.
  const gateway = sipGatewayConfigured();

  // Le sélecteur montre TOUS les rôles configurés, dans l'ordre de l'écran des
  // rôles — droits et relations restent là-bas, ici on ne fait que choisir.
  const roles = [...cfg.roles]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({
      id: r.id,
      nameFr: r.nameFr,
      nameEn: r.nameEn,
      look: r.look,
      superAdmin: r.superAdmin,
    }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      {/* L'en-tête (titre + bouton de création) vit dans UsersClient : le bouton
          est câblé sur l'état de la liste, seul le balisage a bougé. */}
      <UsersClient
        // `roleForUser` donne le rôle EFFECTIF : l'affectation de la matrice,
        // le plancher « admin » de la base, ou le rôle par défaut.
        initialUsers={all.map((u) => toAdminUser(u, gateway, roleForUser(cfg, u)))}
        roles={roles}
        defaultRoleId={cfg.defaultRoleId}
        currentUserId={admin.id}
      />
      <OwnPasswordCard />
    </div>
  );
}
