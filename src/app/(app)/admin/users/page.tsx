import { asc } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { toAdminUser } from "@/app/api/admin/_helpers";
import { sipGatewayConfigured } from "@/app/api/admin/users/_phone-status";
import { OwnPasswordCard, UsersClient } from "@/components/admin/users-client";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";

export default async function AdminUsersPage() {
  const admin = await requireAdmin();
  const t = await getTranslations("admin");

  const all = await db.query.users.findMany({ orderBy: [asc(users.createdAt)] });
  // Booléen calculé UNE fois : la valeur de l'URL de passerelle ne quitte jamais le serveur.
  const gateway = sipGatewayConfigured();

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <h1 className="font-heading text-xl font-semibold tracking-tight">{t("users.title")}</h1>
      <UsersClient
        initialUsers={all.map((u) => toAdminUser(u, gateway))}
        currentUserId={admin.id}
      />
      <OwnPasswordCard />
    </div>
  );
}
