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

/** Liste les sous-comptes voip.ms (pour le sélecteur de sipUsername). */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  try {
    const accounts = await getSubAccounts();
    return NextResponse.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        account: a.account,
        username: a.username,
        description: a.description,
      })),
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
