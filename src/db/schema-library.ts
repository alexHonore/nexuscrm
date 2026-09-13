import { relations, sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { calls, users } from "./schema";

// ── La bibliothèque d'écoute : marquer un appel, le ranger, dire pourquoi ────
//
// Un enregistrement d'appel ne vaut que le jour où quelqu'un le retrouve. Le
// journal d'appels les montre tous, du plus récent au plus vieux, vingt-cinq
// par page : c'est parfait pour « qu'est-ce qui s'est passé hier ? » et
// inutilisable pour « l'appel où elle a retourné l'objection du prix ». Ces
// trois tables existent pour ce deuxième usage — la formation de l'équipe,
// déjà déclarée comme finalité dans la politique de confidentialité.
//
// Trois tables et pas une colonne de plus sur `calls` : `src/db/schema.ts` est
// gelé (règle 7), et c'est tant mieux, parce qu'une colonne `starred` aurait
// menti. Une étoile appartient à QUELQU'UN — deux téléphonistes n'ont pas les
// mêmes appels à revoir — alors qu'un dossier de formation appartient à
// l'ÉQUIPE. Ce sont deux objets, pas deux valeurs du même.
//
// Comme `schema-push.ts`, ce module est ré-exporté depuis `schema-sms.ts` :
// `drizzle.config.ts` est gelé et n'énumère que deux fichiers. Le jour où il
// s'ouvre, il suffit d'y ajouter cette ligne et de retirer la ré-exportation.

/**
 * Les deux façons de ranger un enregistrement, et il y en a bien deux.
 *
 * `folder` répond à « où est-il classé ? » — un dossier de formation qu'on
 * ouvre pour en écouter le contenu de bout en bout (« Formation — objections
 * prix »). `tag` répond à « qu'est-ce que c'est ? » — une étiquette qui se
 * lit d'un coup d'œil sur la ligne d'un appel, sans l'ouvrir (« bon ton »,
 * « découverte bâclée »), et qui se croise avec les autres.
 *
 * Mécaniquement c'est le même sac nommé, d'où une seule table : les
 * dédoubler aurait imposé deux CRUD, deux droits et deux écrans pour un
 * geste identique. Ce qui change est ce que l'écran en fait, pas ce que la
 * base en sait.
 */
export const recordingCollectionKindEnum = pgEnum("recording_collection_kind", ["folder", "tag"]);

/**
 * « Cet appel-là, je veux le retrouver. » — une étoile, une personne.
 *
 * Personnelle par construction : la clé unique porte sur le couple, et chaque
 * lecture filtre sur `user_id`. Le patron qui marque un appel ne pollue pas
 * la liste du téléphoniste, et inversement. C'est le pendant privé du
 * dossier partagé : marquer ne demande à personne la permission de ranger.
 *
 * Rien n'empêche d'étoiler un appel SANS enregistrement, et le journal
 * d'appels le propose exprès : un appel reçoit son enregistrement bien après
 * sa fin, quand la synchronisation voip.ms passe. Une contrainte aurait
 * refusé le geste au moment exact où il est le plus naturel, juste après
 * avoir raccroché — la bibliothèque dit « enregistrement indisponible » pour
 * ces lignes-là plutôt que de les cacher.
 */
export const callStars = pgTable(
  "call_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Marquer deux fois est le même geste que marquer une fois : l'unicité
    // rend le bouton idempotent, donc rejouable sans conséquence (double-tap
    // sur mobile, requête réémise après une réponse perdue).
    uniqueIndex("call_stars_user_call_uq").on(t.userId, t.callId),
    index("call_stars_user_created_idx").on(t.userId, t.createdAt),
    // « Qui a marqué cet appel ? » — lu à chaque ligne du journal d'appels.
    index("call_stars_call_idx").on(t.callId),
  ],
);

/**
 * Un dossier ou une étiquette : un sac NOMMÉ, partagé par toute l'équipe.
 *
 * Partagé, et c'est le point : un recueil d'exemples que son auteur serait
 * seul à voir ne formerait personne. Qui peut le remplir est un réglage
 * (`clients.recordingsCurate`), qui peut le lire est le droit d'écouter.
 *
 * `createdById` passe à NULL au départ de son auteur plutôt que d'emporter le
 * dossier avec lui : le travail de classement survit à la personne qui l'a
 * fait, comme les fiches survivent au téléphoniste qui les a saisies.
 */
export const recordingCollections = pgTable(
  "recording_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: recordingCollectionKindEnum("kind").notNull().default("folder"),
    name: text("name").notNull(),
    /** À quoi sert ce dossier — lu par celui qui hérite du classement. */
    description: text("description"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Deux dossiers « Objections prix » sont une erreur de frappe, pas une
    // intention : l'un des deux se remplira et l'autre restera vide sans que
    // personne ne comprenne pourquoi. L'unicité est insensible à la casse et
    // aux espaces de bord, parce que « objections prix » et « Objections
    // Prix » sont le même dossier pour tout le monde sauf pour Postgres.
    // Elle porte sur le COUPLE avec le genre : un dossier et une étiquette
    // peuvent légitimement porter le même nom, ils ne se rangent pas au même
    // endroit de l'écran.
    uniqueIndex("recording_collections_kind_name_uq").on(t.kind, sql`lower(btrim(${t.name}))`),
    index("recording_collections_kind_idx").on(t.kind, t.name),
  ],
);

/**
 * Ce qu'un enregistrement fait dans ce dossier — et SURTOUT pourquoi.
 *
 * `note` est la seule raison d'être de cette table plutôt que d'un simple
 * tableau d'identifiants : « bon rebond sur "je vais y penser", à la 4e
 * minute » est ce qui transforme un enregistrement archivé en leçon. Sans
 * elle, un dossier de formation est une pile de trente appels que personne
 * n'écoute parce que personne ne sait par lequel commencer.
 *
 * La note appartient au CLASSEMENT, pas à l'appel : le même appel rangé dans
 * « bons rebonds » et dans « à revoir avec Marc » n'y est pas pour la même
 * raison, et forcer une note unique aurait obligé à choisir laquelle perdre.
 */
export const recordingCollectionItems = pgTable(
  "recording_collection_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => recordingCollections.id, { onDelete: "cascade" }),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    /** Pourquoi cet appel est ici. Ce que l'écoute doit faire remarquer. */
    note: text("note"),
    addedById: uuid("added_by_id").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un appel est dans un dossier ou il n'y est pas — l'y remettre met la
    // note à jour au lieu d'empiler un doublon (`onConflictDoUpdate`).
    uniqueIndex("recording_collection_items_uq").on(t.collectionId, t.callId),
    index("recording_collection_items_collection_idx").on(t.collectionId, t.addedAt),
    // « Dans quels dossiers est cet appel ? » — lu à chaque ligne du journal.
    index("recording_collection_items_call_idx").on(t.callId),
  ],
);

/**
 * Le type `bytea` de Postgres. Drizzle 0.45 n'en livre pas ; postgres.js rend
 * et accepte déjà des `Buffer`, il suffit de nommer la colonne.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * L'audio d'un appel de la bibliothèque, gardé CHEZ NOUS.
 *
 * voip.ms ne garde pas ses enregistrements indéfiniment, et chaque écoute lui
 * redemandait le fichier (jusqu'à une minute et demie d'attente). Un appel
 * marqué ou rangé est justement un appel qu'on réécoutera — et qu'on voudra
 * encore dans six mois pour former quelqu'un.
 *
 * Dans la base plutôt que dans un compartiment de fichiers : décision de
 * l'exploitant (2026-09-13), pour n'ajouter ni secret ni service. Le prix de
 * ce choix est la place — le forfait gratuit de Supabase compte 500 Mo pour
 * TOUTE la base, et une base pleine passe en lecture seule, CRM compris. D'où
 * le plafond (réglage `recordings.audioCapMb`) : au-delà, on cesse de
 * conserver ; on ne remplit jamais.
 *
 * La ligne SURVIT au retrait de l'audio (`audio` à NULL, `removed_at` posé) :
 * elle se souvient que quelqu'un a choisi de rendre cette place, et le
 * ramassage automatique ne doit pas retélécharger derrière son dos.
 *
 * `bytes` double la longueur de `audio` pour que la jauge ne lise jamais un
 * seul octet d'audio : un `sum(bytes)` reste une lecture de quelques lignes.
 */
export const recordingAudio = pgTable("recording_audio", {
  callId: uuid("call_id")
    .primaryKey()
    .references(() => calls.id, { onDelete: "cascade" }),
  audio: bytea("audio"),
  bytes: integer("bytes").notNull().default(0),
  contentType: text("content_type").notNull().default("audio/mpeg"),
  /**
   * La référence d'où vient la copie. Si `calls.recording_url` change (une
   * synchro qui rattache un autre enregistrement), la copie est périmée : on
   * ne la sert plus, et le prochain passage la remplace.
   */
  sourceRef: text("source_ref").notNull(),
  keptAt: timestamp("kept_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedById: uuid("removed_by_id").references(() => users.id, { onDelete: "set null" }),
});

// ── Relations ────────────────────────────────────────────────────────────────

export const callStarsRelations = relations(callStars, ({ one }) => ({
  call: one(calls, { fields: [callStars.callId], references: [calls.id] }),
  user: one(users, { fields: [callStars.userId], references: [users.id] }),
}));

export const recordingCollectionsRelations = relations(recordingCollections, ({ one, many }) => ({
  createdBy: one(users, { fields: [recordingCollections.createdById], references: [users.id] }),
  items: many(recordingCollectionItems),
}));

export const recordingCollectionItemsRelations = relations(recordingCollectionItems, ({ one }) => ({
  collection: one(recordingCollections, {
    fields: [recordingCollectionItems.collectionId],
    references: [recordingCollections.id],
  }),
  call: one(calls, { fields: [recordingCollectionItems.callId], references: [calls.id] }),
  addedBy: one(users, { fields: [recordingCollectionItems.addedById], references: [users.id] }),
}));
