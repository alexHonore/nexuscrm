import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { encryptSecret } from "@/lib/crypto";
import { createSubAccount, getSubAccounts } from "@/lib/voipms";
import { generateSipPassword, readJson, voipmsErrorResponse } from "../../_helpers";
import { indexBySipAccount, loadAssignments } from "../_assignments";

/**
 * Liste les sous-comptes voip.ms annotés avec l'utilisateur qui les emploie
 * déjà (mêmes règles que les DID : un sous-compte = un téléphoniste).
 * Les sous-comptes libres sont remontés en tête.
 */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  try {
    const [accounts, assignments] = await Promise.all([getSubAccounts(), loadAssignments()]);
    const bySip = indexBySipAccount(assignments);

    const enriched = accounts.map((a) => {
      const holder =
        bySip.get(a.account.trim().toLowerCase()) ?? bySip.get(a.username.trim().toLowerCase()) ?? null;
      return {
        id: a.id,
        account: a.account,
        username: a.username,
        description: a.description,
        assignedUserId: holder?.id ?? null,
        assignedUserName: holder?.name ?? null,
        available: holder === null,
      };
    });

    enriched.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.account.localeCompare(b.account);
    });

    return NextResponse.json({
      accounts: enriched,
      availableCount: enriched.filter((a) => a.available).length,
      assignedCount: enriched.filter((a) => !a.available).length,
    });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}

const createSchema = z.object({
  userId: z.uuid(),
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{2,32}$/),
});

/**
 * Crée un sous-compte SIP voip.ms pour un utilisateur : mot de passe SIP fort
 * généré, montré UNE fois et sauvegardé chiffré sur l'utilisateur.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const target = await db.query.users.findFirst({ where: eq(users.id, body.userId) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const password = generateSipPassword();
  try {
    const res = (await createSubAccount({
      username: body.username,
      password,
      description: target.name,
      calleridNumber: target.didNumber ? target.didNumber.replace(/\D/g, "").slice(-10) : undefined,
    })) as { account?: string };

    // Nom de compte complet ("compte_sousnom") — renvoyé par l'API ou retrouvé via la liste.
    let account = res.account ?? null;
    if (!account) {
      const accounts = await getSubAccounts().catch(() => []);
      account = accounts.find((a) => a.username === body.username)?.account ?? body.username;
    }

    await db
      .update(users)
      .set({ sipUsername: account, sipPasswordEnc: encryptSecret(password), updatedAt: new Date() })
      .where(eq(users.id, target.id));

    await logAudit({
      userId: admin.id,
      action: "voipms.subaccount_create",
      entity: "user",
      entityId: target.id,
      detail: { account },
    });

    return NextResponse.json({ account, password });
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
