/**
 * Réparation des notes d'appel PROUVÉES illisibles — celles où le corps du
 * commentaire est la réponse brute du modèle et non une note.
 *
 * Pourquoi un script et pas un balayage : la rangée `call_transcripts` est
 * marquée `done`, et c'est elle qui dit au balayage « cet appel est réglé ».
 * Le balayage ne repasse d'ailleurs que sur 72 h, alors que les plus anciennes
 * de ces notes datent de trois semaines. Rien ne les reprendra tout seul.
 *
 * Ce que fait le script, par appel : il efface le commentaire pourri, il
 * efface la rangée, et il remet l'appel en file. Le job le retraitera avec le
 * lecteur corrigé — et cette fois, soit la fiche reçoit une VRAIE note, soit
 * la rangée est classée `failed` et la fiche ne reçoit rien.
 *
 *   pnpm tsx scripts/repair-transcript-notes.ts           # montre, n'écrit rien
 *   pnpm tsx scripts/repair-transcript-notes.ts --apply   # répare
 *
 * Chaque appel repris est REPAYÉ au modèle (de l'ordre d'un à quatre cents
 * pièce) : c'est le prix d'une note lisible sur une fiche qu'un téléphoniste
 * rouvre avant de rappeler.
 */
import { inArray, like } from "drizzle-orm";
import { db } from "@/db";
import { comments } from "@/db/schema";
import { callTranscripts } from "@/db/schema-sms";
import { enqueueJob } from "@/lib/jobs/queue";
import { transcriptDedupeKey } from "@/lib/transcripts/sweep";

async function main() {
  const apply = process.argv.includes("--apply");

  // Le critère est une PREUVE, pas une heuristique : une note qui commence par
  // une accolade est une réponse de modèle recrachée telle quelle. Une vraie
  // note en prose ne commence jamais ainsi.
  const rotten = await db
    .select({
      id: callTranscripts.id,
      callId: callTranscripts.callId,
      clientId: callTranscripts.clientId,
      commentId: callTranscripts.commentId,
      createdAt: callTranscripts.createdAt,
    })
    .from(callTranscripts)
    .where(like(callTranscripts.summary, "{%"));

  if (rotten.length === 0) {
    console.log("Aucune note à réparer.");
    return;
  }

  console.log(`${rotten.length} note(s) illisible(s) :`);
  for (const row of rotten) {
    console.log(
      `  · appel ${row.callId} — fiche ${row.clientId ?? "(aucune)"} — ${row.createdAt.toISOString()}`,
    );
  }

  if (!apply) {
    console.log("\nAucune écriture. Relancer avec --apply pour réparer.");
    return;
  }

  const commentIds = rotten.map((r) => r.commentId).filter((id): id is string => id !== null);
  await db.transaction(async (tx) => {
    // Le commentaire d'abord : la rangée le référence, et une rangée effacée
    // sans son commentaire laisserait le débris sur la fiche pour toujours.
    if (commentIds.length > 0) {
      await tx.delete(comments).where(inArray(comments.id, commentIds));
    }
    await tx.delete(callTranscripts).where(
      inArray(
        callTranscripts.id,
        rotten.map((r) => r.id),
      ),
    );
  });
  console.log(`\n${commentIds.length} commentaire(s) effacé(s), ${rotten.length} rangée(s) effacée(s).`);

  let queued = 0;
  for (const row of rotten) {
    const { deduped } = await enqueueJob({
      type: "call_transcript",
      runAt: new Date(),
      payload: { callId: row.callId },
      dedupeKey: transcriptDedupeKey(row.callId),
    });
    if (!deduped) queued += 1;
  }
  console.log(`${queued} appel(s) remis en file. Le couloir /api/cron/transcripts les reprendra.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
