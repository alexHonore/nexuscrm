/**
 * Génération d'une paire VAPID — usage : pnpm tsx scripts/generate-vapid.ts [sujet]
 *
 * À lancer UNE fois, puis à coller dans Vercel (et dans `.env.local` pour le
 * développement). Changer cette paire invalide TOUS les abonnements déjà
 * enregistrés : le navigateur a mémorisé la clé publique au moment de
 * l'abonnement, et les appareils devront se réabonner un par un. Ce n'est donc
 * pas une commande qu'on relance « pour voir ».
 *
 * Elle passe par `generateVapidKeys` (et jamais par un openssl maison) parce que
 * c'est là que vit le complément à 32 octets : une clé privée sortie brute de
 * `createECDH` perd ses zéros de tête environ une fois sur trois cents, et le
 * 403 qu'elle provoque n'apparaît que des semaines plus tard, chez un seul
 * service de push. Le contrôle final ci-dessous relit ce qui vient d'être écrit
 * avec le MÊME lecteur que l'application : ce qui s'affiche est ce qui chargera.
 */
import { generateVapidKeys, readVapidKeys } from "@/lib/push/keys";

const subject = process.argv[2]?.trim() || "mailto:courtier@exemple.com";

const { publicKey, privateKey } = generateVapidKeys();
const check = readVapidKeys({
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: privateKey,
  VAPID_SUBJECT: subject,
});

console.log("");
console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateKey);
console.log("VAPID_SUBJECT=" + subject);
console.log("");

if (!check.ok) {
  // Seul « subject » peut échouer ici sans que la paire soit en cause : le
  // sujet est une saisie humaine, la paire vient d'être fabriquée.
  console.error(`⚠️  Configuration refusée par readVapidKeys : ${check.problem}`);
  if (check.problem === "subject") {
    console.error("   Le sujet doit être « mailto:adresse@domaine » ou « https://… ».");
    console.error("   Exemple : pnpm tsx scripts/generate-vapid.ts mailto:info@groupenexus.ca");
  }
  process.exit(1);
}

console.log("Les trois lignes ci-dessus sont prêtes à coller (Vercel → Settings → Environment Variables).");
console.log("La clé PRIVÉE ne sort jamais du serveur ; la publique est celle que le navigateur reçoit.");
