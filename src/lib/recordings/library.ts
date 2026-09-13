import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { calls, clients, users } from "@/db/schema";
import { callStars, recordingCollectionItems, recordingCollections } from "@/db/schema-library";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { type Actor, loadDirectory, visibilityCondition } from "@/lib/permissions/server";

/**
 * La bibliothèque d'écoute, côté serveur — et surtout : ce que CHACUN en voit.
 *
 * Tout ce fichier existe pour une seule phrase de la règle 13 : « une liste
 * filtrée sous un total non filtré annonce le nombre de fiches qu'on cache ».
 * Un dossier partagé est exactement le piège qu'elle décrit — le superviseur y
 * range quarante appels, l'observateur n'a le droit d'en entendre que six, et
 * un compteur honnête est le seul moyen que « 6 » ne ressemble pas à une
 * panne. Les décomptes ci-dessous passent donc par la MÊME condition que les
 * lignes, jamais par un `count(*)` de complaisance.
 *
 * La forme de cette condition est un OU, pas un ET, et c'est repris du journal
 * d'appels : un appel sans fiche ne protège personne (numéro inconnu, entrant
 * jamais rattaché) — le cacher n'aurait retiré aucun secret, seulement du
 * matériel de formation.
 */

export const LIBRARY_PAGE_SIZE = 25;

/** Longueur maximale d'un motif d'écoute — voir `recording_collection_items.note`. */
export const NOTE_MAX = 500;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 300;

export type CollectionKind = "folder" | "tag";

/**
 * Les appels que CE regard a le droit d'atteindre.
 *
 * `undefined` = aucune restriction (portée « toutes les fiches »). Toute
 * requête qui utilise ce retour DOIT joindre `clients` en LEFT JOIN, sans quoi
 * la condition porte sur une table absente.
 */
export async function callReachCondition(actor: Actor): Promise<SQL | undefined> {
  const visible = await visibilityCondition(actor);
  if (!visible) return undefined;
  return or(isNull(calls.clientId), visible);
}

/**
 * Le robinet, fiche par fiche, sans repayer la résolution à chaque ligne.
 *
 * Repris de `/admin/calls` : les compartiments ne dépendent QUE du détenteur
 * de la fiche, donc une page de vingt-cinq appels ne pose jamais plus de
 * questions qu'il n'y a de téléphonistes.
 */
export async function grantsResolver(actor: Actor): Promise<(holderId: string | null) => Grants> {
  const { cfg, roleOf } = await loadDirectory();
  const cache = new Map<string, Grants>();
  return (holderId: string | null) => {
    const key = holderId ?? "";
    const hit = cache.get(key);
    if (hit) return hit;
    const holder = holderId ? (roleOf.get(holderId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId: holderId }, holder));
    cache.set(key, g);
    return g;
  };
}

export type CollectionRow = {
  id: string;
  kind: CollectionKind;
  name: string;
  description: string | null;
  /** Nombre d'appels de ce dossier ATTEIGNABLES par celui qui regarde. */
  count: number;
};

/**
 * Les dossiers et les étiquettes, avec un décompte qui dit la vérité.
 *
 * Un dossier vide pour ce regard reste listé : le faire disparaître aurait
 * laissé croire qu'il n'existe pas, et quelqu'un l'aurait recréé sous le même
 * nom — que l'index unique refuse, pour une raison alors incompréhensible.
 */
export async function loadCollections(actor: Actor): Promise<CollectionRow[]> {
  const reach = await callReachCondition(actor);

  const [rows, counts] = await Promise.all([
    db
      .select({
        id: recordingCollections.id,
        kind: recordingCollections.kind,
        name: recordingCollections.name,
        description: recordingCollections.description,
      })
      .from(recordingCollections)
      .orderBy(asc(recordingCollections.kind), asc(recordingCollections.name)),
    db
      .select({ collectionId: recordingCollectionItems.collectionId, n: count() })
      .from(recordingCollectionItems)
      .innerJoin(calls, eq(calls.id, recordingCollectionItems.callId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(reach)
      .groupBy(recordingCollectionItems.collectionId),
  ]);

  const byId = new Map(counts.map((c) => [c.collectionId, c.n]));
  return rows.map((r) => ({ ...r, count: byId.get(r.id) ?? 0 }));
}

/** Combien d'appels CET utilisateur a marqués, et qu'il peut encore atteindre. */
export async function starredCount(actor: Actor): Promise<number> {
  const reach = await callReachCondition(actor);
  const [row] = await db
    .select({ n: count() })
    .from(callStars)
    .innerJoin(calls, eq(calls.id, callStars.callId))
    .leftJoin(clients, eq(clients.id, calls.clientId))
    .where(reach ? and(eq(callStars.userId, actor.user.id), reach) : eq(callStars.userId, actor.user.id));
  return row?.n ?? 0;
}

export type LibraryScope = { kind: "starred" } | { kind: "collection"; id: string };

export type LibraryCallRow = {
  id: string;
  startedAt: Date;
  direction: "outbound" | "inbound";
  missed: boolean;
  durationSec: number;
  disposition: string | null;
  note: string | null;
  recordingUrl: string | null;
  userName: string | null;
  clientId: string | null;
  clientName: string | null;
  holderId: string | null;
  rawNumber: string | null;
  /** Le motif écrit au moment du classement — vide hors d'un dossier. */
  filingNote: string | null;
};

/**
 * Une page de la bibliothèque. L'ordre est celui du classement (le plus
 * récemment rangé d'abord) dans un dossier, celui du marquage dans « Mes
 * marqués » — dans les deux cas le geste humain, pas la date de l'appel :
 * ce qu'on vient de ranger est ce qu'on veut relire.
 */
export async function loadLibraryPage(
  actor: Actor,
  scope: LibraryScope,
  page: number,
): Promise<{ rows: LibraryCallRow[]; total: number }> {
  const reach = await callReachCondition(actor);

  const columns = {
    id: calls.id,
    startedAt: calls.startedAt,
    direction: calls.direction,
    answeredAt: calls.answeredAt,
    fromNumber: calls.fromNumber,
    toNumber: calls.toNumber,
    durationSec: calls.durationSec,
    disposition: calls.disposition,
    note: calls.note,
    recordingUrl: calls.recordingUrl,
    userName: users.name,
    clientId: clients.id,
    clientName: clients.fullName,
    holderId: clients.assignedToId,
  };

  const offset = (page - 1) * LIBRARY_PAGE_SIZE;

  if (scope.kind === "starred") {
    const where = reach
      ? and(eq(callStars.userId, actor.user.id), reach)
      : eq(callStars.userId, actor.user.id);
    const [rows, [totalRow]] = await Promise.all([
      db
        .select({ ...columns, filingNote: sql<string | null>`null::text` })
        .from(callStars)
        .innerJoin(calls, eq(calls.id, callStars.callId))
        .innerJoin(users, eq(users.id, calls.userId))
        .leftJoin(clients, eq(clients.id, calls.clientId))
        .where(where)
        .orderBy(desc(callStars.createdAt))
        .limit(LIBRARY_PAGE_SIZE)
        .offset(offset),
      db
        .select({ n: count() })
        .from(callStars)
        .innerJoin(calls, eq(calls.id, callStars.callId))
        .leftJoin(clients, eq(clients.id, calls.clientId))
        .where(where),
    ]);
    return { rows: rows.map(toLibraryRow), total: totalRow?.n ?? 0 };
  }

  const where = reach
    ? and(eq(recordingCollectionItems.collectionId, scope.id), reach)
    : eq(recordingCollectionItems.collectionId, scope.id);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ ...columns, filingNote: recordingCollectionItems.note })
      .from(recordingCollectionItems)
      .innerJoin(calls, eq(calls.id, recordingCollectionItems.callId))
      .innerJoin(users, eq(users.id, calls.userId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where)
      .orderBy(desc(recordingCollectionItems.addedAt))
      .limit(LIBRARY_PAGE_SIZE)
      .offset(offset),
    db
      .select({ n: count() })
      .from(recordingCollectionItems)
      .innerJoin(calls, eq(calls.id, recordingCollectionItems.callId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where),
  ]);
  return { rows: rows.map(toLibraryRow), total: totalRow?.n ?? 0 };
}

type RawRow = {
  id: string;
  startedAt: Date;
  direction: "outbound" | "inbound";
  answeredAt: Date | null;
  fromNumber: string | null;
  toNumber: string | null;
  durationSec: number;
  disposition: string | null;
  note: string | null;
  recordingUrl: string | null;
  userName: string | null;
  clientId: string | null;
  clientName: string | null;
  holderId: string | null;
  filingNote: string | null;
};

function toLibraryRow(row: RawRow): LibraryCallRow {
  return {
    id: row.id,
    startedAt: row.startedAt,
    direction: row.direction,
    missed: row.direction === "inbound" && row.answeredAt === null,
    durationSec: row.durationSec,
    disposition: row.disposition,
    note: row.note,
    recordingUrl: row.recordingUrl,
    userName: row.userName,
    clientId: row.clientId,
    clientName: row.clientName,
    holderId: row.holderId,
    rawNumber: row.direction === "outbound" ? row.toNumber : row.fromNumber,
    filingNote: row.filingNote,
  };
}

export type CallFiling = { id: string; kind: CollectionKind; name: string; note: string | null };

export type CallMarkers = {
  starred: boolean;
  collections: CallFiling[];
};

/**
 * Où en est chaque appel d'une page : marqué ? rangé où ?
 *
 * Une seule requête pour les vingt-cinq lignes, jamais une par ligne. Les
 * étoiles lues sont celles de CELUI qui regarde : afficher l'étoile d'un
 * collègue transformerait un signet privé en jugement public.
 *
 * PRÉ-REQUIS : `callIds` vient d'une requête DÉJÀ filtrée par la portée (les
 * lignes servies à l'écran). Cette fonction ne refiltre pas — l'appeler avec
 * des identifiants bruts dirait à qui n'a rien à y voir dans quels dossiers
 * un appel est rangé.
 */
export async function markersFor(actor: Actor, callIds: string[]): Promise<Map<string, CallMarkers>> {
  const out = new Map<string, CallMarkers>();
  if (callIds.length === 0) return out;
  for (const id of callIds) out.set(id, { starred: false, collections: [] });

  const [stars, filed] = await Promise.all([
    db
      .select({ callId: callStars.callId })
      .from(callStars)
      .where(and(eq(callStars.userId, actor.user.id), inArray(callStars.callId, callIds))),
    db
      .select({
        callId: recordingCollectionItems.callId,
        id: recordingCollections.id,
        kind: recordingCollections.kind,
        name: recordingCollections.name,
        note: recordingCollectionItems.note,
      })
      .from(recordingCollectionItems)
      .innerJoin(
        recordingCollections,
        eq(recordingCollections.id, recordingCollectionItems.collectionId),
      )
      .where(inArray(recordingCollectionItems.callId, callIds))
      .orderBy(asc(recordingCollections.kind), asc(recordingCollections.name)),
  ]);

  for (const s of stars) {
    const entry = out.get(s.callId);
    if (entry) entry.starred = true;
  }
  for (const f of filed) {
    const entry = out.get(f.callId);
    if (entry) entry.collections.push({ id: f.id, kind: f.kind, name: f.name, note: f.note });
  }
  return out;
}

/**
 * Cet appel-là est-il atteignable par ce regard ?
 *
 * La porte de TOUTE écriture de la bibliothèque. Elle répond `null` aussi bien
 * pour un appel qui n'existe pas que pour un appel dont la fiche est fermée :
 * distinguer les deux confirmerait l'existence de la fiche (règle 1). Le
 * robinet exigé est `history` — le même que celui qui ouvre le fil d'appels
 * d'une fiche et l'audio, parce que ranger un appel, c'est en révéler la date,
 * la durée et le résultat.
 */
export async function reachableCall(
  actor: Actor,
  callId: string,
): Promise<{ id: string; clientId: string | null; recordingUrl: string | null } | null> {
  const grantsOf = await grantsResolver(actor);
  const [row] = await db
    .select({
      id: calls.id,
      clientId: calls.clientId,
      recordingUrl: calls.recordingUrl,
      holderId: clients.assignedToId,
    })
    .from(calls)
    .leftJoin(clients, eq(clients.id, calls.clientId))
    .where(eq(calls.id, callId))
    .limit(1);
  if (!row) return null;
  if (row.clientId) {
    const grants = grantsOf(row.holderId);
    if (!grants.visible || !grants.history) return null;
  }
  return { id: row.id, clientId: row.clientId, recordingUrl: row.recordingUrl };
}
