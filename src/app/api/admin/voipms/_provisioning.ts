import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import {
  createSubAccount,
  getSubAccounts,
  setSubAccountPassword,
  VoipMsError,
  type VoipMsSubAccount,
} from "@/lib/voipms";
import { generateSipPassword } from "../_helpers";

/**
 * Provisionnement d'une ligne SIP voip.ms — logique PARTAGÉE entre la création
 * manuelle d'un sous-compte et la configuration automatique déclenchée à la
 * création d'un utilisateur.
 *
 * Deux invariants tiennent tout ce fichier :
 *
 * 1. **Idempotence** — rejouer l'opération ne casse rien. Si le sous-compte
 *    existe déjà chez voip.ms, on l'adopte au lieu d'échouer.
 * 2. **Auto-réparation** — l'API voip.ms est lente et irrégulière (8 s… parfois
 *    plus de 90 s). Une création peut RÉUSSIR chez eux alors que la réponse se
 *    perd. On relit donc la liste des sous-comptes : voip.ms y renvoie le mot
 *    de passe SIP en clair, ce qui permet de récupérer la ligne réelle.
 */

/** Validation partagée avec le schéma de la route (voip.ms n'accepte que ça). */
export const SIP_USERNAME_RE = /^[A-Za-z0-9_]{2,32}$/;

/**
 * Base courte : voip.ms préfixe le sous-compte avec le numéro du compte
 * principal et n'accepte qu'un nom bref. On garde de la marge pour le suffixe
 * de désambiguïsation (« alexhonore2 ») tout en restant lisible.
 */
const MAX_BASE_LENGTH = 12;

// ── Dérivation d'un nom d'utilisateur SIP ────────────────────────────────────

/** « Alex-Honoré » → « alexhonore » (ASCII plié, minuscules, [a-z0-9_]). */
export function slugifySip(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

/** Suffixe d'un compte complet : « 551013_alex » → « alex ». */
function accountSuffix(value: string): string {
  const i = value.lastIndexOf("_");
  return i === -1 ? value : value.slice(i + 1);
}

/**
 * Toutes les formes sous lesquelles un sous-compte existant peut entrer en
 * collision : nom complet, nom court, et leurs suffixes (voip.ms préfixe les
 * sous-comptes avec le numéro du compte principal).
 */
export function takenSipNames(accounts: VoipMsSubAccount[]): Set<string> {
  const taken = new Set<string>();
  for (const a of accounts) {
    for (const raw of [a.account, a.username]) {
      const value = raw?.trim().toLowerCase();
      if (!value) continue;
      taken.add(value);
      taken.add(accountSuffix(value));
    }
  }
  return taken;
}

/**
 * Nom d'utilisateur SIP sûr et UNIQUE dérivé de la personne : prénom plié en
 * ASCII, sinon nom complet, sinon partie locale du courriel. Les collisions se
 * résolvent en suffixant 2, 3, …
 */
export function deriveSipUsername(
  person: { name: string; email: string },
  accounts: VoipMsSubAccount[],
): string {
  const taken = takenSipNames(accounts);
  const candidates = [
    slugifySip(person.name.trim().split(/\s+/)[0] ?? ""),
    slugifySip(person.name),
    slugifySip((person.email.split("@")[0] ?? "").replace(/[.+]/g, "")),
  ];
  const base = (candidates.find((c) => c.length >= 2) ?? "agent").slice(0, MAX_BASE_LENGTH);

  let candidate = base;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = `${base}${i}`;
    // Garde-fou : jamais de boucle infinie, jamais plus de 32 caractères.
    if (i > 999) return `${base.slice(0, 24)}${Date.now().toString(36).slice(-5)}`;
  }
  return SIP_USERNAME_RE.test(candidate) ? candidate : "agent";
}

// ── Recherche tolérante d'un sous-compte ─────────────────────────────────────

/**
 * Retrouve un sous-compte à partir d'un nom qui peut être complet
 * (« 551013_alex ») ou court (« alex ») — voip.ms n'est pas cohérent entre le
 * paramètre de création et ce que renvoie la liste.
 */
export function findSubAccount(
  accounts: VoipMsSubAccount[],
  name: string | null | undefined,
): VoipMsSubAccount | undefined {
  const needle = name?.trim().toLowerCase();
  if (!needle) return undefined;
  const short = accountSuffix(needle);
  return accounts.find((a) => {
    const forms = [a.account, a.username]
      .filter((v): v is string => Boolean(v))
      .flatMap((v) => {
        const low = v.trim().toLowerCase();
        return [low, accountSuffix(low)];
      });
    return forms.includes(needle) || forms.includes(short);
  });
}

// ── Provisionnement ──────────────────────────────────────────────────────────

export type ProvisionInput = {
  id: string;
  name: string;
  email: string;
  sipUsername: string | null;
  didNumber: string | null;
};

export type ProvisionResult = {
  /** Nom de compte complet enregistré sur l'utilisateur (« 551013_alex »). */
  account: string;
  /** Mot de passe SIP en clair — à montrer UNE fois à l'admin. */
  password: string;
  /** false = le sous-compte existait déjà chez voip.ms et a été repris. */
  created: boolean;
  /** true = le nom d'utilisateur a été dérivé automatiquement. */
  derived: boolean;
};

/** Reprend un sous-compte existant : son mot de passe si voip.ms le donne, sinon on en pose un. */
async function adoptSubAccount(
  existing: VoipMsSubAccount,
  fallbackPassword: string,
  calleridNumber?: string,
): Promise<string> {
  if (existing.password) return existing.password;
  await setSubAccountPassword(existing.id, fallbackPassword, calleridNumber);
  return fallbackPassword;
}

/** Enregistre les identifiants SIP (mot de passe CHIFFRÉ) sur l'utilisateur. */
async function storeSipCredentials(userId: string, account: string, password: string) {
  await db
    .update(users)
    .set({ sipUsername: account, sipPasswordEnc: encryptSecret(password), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Resynchronise le mot de passe SIP stocké avec celui que voip.ms rapporte
 * RÉELLEMENT — le cas « le softphone n'arrive pas à s'enregistrer alors que
 * tout a l'air rempli ». Ne crée jamais de sous-compte : si celui de
 * l'utilisateur n'existe plus chez voip.ms, on le signale.
 */
export async function resyncSipPassword(user: ProvisionInput): Promise<{ account: string }> {
  const calleridNumber = user.didNumber ? user.didNumber.replace(/\D/g, "").slice(-10) : undefined;
  const existing = findSubAccount(await getSubAccounts(), user.sipUsername);
  if (!existing) throw new VoipMsError("subaccount_not_found");

  const password = await adoptSubAccount(existing, generateSipPassword(), calleridNumber);
  await storeSipCredentials(user.id, existing.account, password);
  return { account: existing.account };
}

/**
 * Crée (ou reprend) le sous-compte SIP de l'utilisateur et enregistre les
 * identifiants chiffrés. Sûr à rejouer autant de fois que nécessaire.
 *
 * @param username Nom voulu par l'admin. Absent ⇒ dérivé du nom/courriel, ce
 *   qui implique de lire d'abord la liste des sous-comptes.
 */
export async function provisionSipLine(
  user: ProvisionInput,
  username?: string,
): Promise<ProvisionResult> {
  const calleridNumber = user.didNumber ? user.didNumber.replace(/\D/g, "").slice(-10) : undefined;
  const fallbackPassword = generateSipPassword();

  let wanted = username?.trim();
  const derived = !wanted;
  let existing: VoipMsSubAccount | undefined;

  if (!wanted) {
    // Chemin automatique : la liste sert à la fois à reprendre une ligne déjà
    // provisionnée (rejeu) et à garantir l'unicité du nom dérivé.
    const accounts = await getSubAccounts();
    existing = findSubAccount(accounts, user.sipUsername);
    wanted = existing ? existing.username || existing.account : deriveSipUsername(user, accounts);
  }
  // Le format n'est contraignant que pour une CRÉATION : un compte déjà existant
  // chez voip.ms est repris tel quel, même si son nom sort de nos règles.
  if (!existing && !SIP_USERNAME_RE.test(wanted)) {
    throw new VoipMsError("invalid_username", `Nom d'utilisateur SIP invalide : ${wanted}`);
  }

  let password: string;
  let account: string | null = null;
  let created = false;

  if (existing) {
    password = await adoptSubAccount(existing, fallbackPassword, calleridNumber);
    account = existing.account;
  } else {
    try {
      const res = (await createSubAccount({
        username: wanted,
        password: fallbackPassword,
        description: user.name,
        calleridNumber,
      })) as { account?: string };
      password = fallbackPassword;
      account = res.account ?? null;
      created = true;
    } catch (err) {
      // La création a pu réussir chez voip.ms malgré l'erreur (ou le compte
      // existait déjà) : on relit la liste avant d'abandonner.
      const found = findSubAccount(await getSubAccounts().catch(() => []), wanted);
      if (!found) throw err;
      password = await adoptSubAccount(found, fallbackPassword, calleridNumber);
      account = found.account;
    }
  }

  // Nom de compte complet — renvoyé par l'API, sinon retrouvé via la liste.
  if (!account) {
    account = findSubAccount(await getSubAccounts().catch(() => []), wanted)?.account ?? wanted;
  }

  await storeSipCredentials(user.id, account, password);

  return { account, password, created, derived };
}

// ── Garde-temps ──────────────────────────────────────────────────────────────

/**
 * Borne un appel voip.ms dans le temps : mieux vaut un message clair
 * (« voip.ms ne répond pas ») qu'un spinner infini côté admin.
 *
 * L'appel sous-jacent continue côté voip.ms — c'est voulu : s'il aboutit, la
 * prochaine tentative le récupérera grâce à l'auto-réparation ci-dessus.
 */
export function withVoipTimeout<T>(promise: Promise<T>, ms = 45_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new VoipMsError("timeout", `voip.ms n'a pas répondu en ${Math.round(ms / 1000)} s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
