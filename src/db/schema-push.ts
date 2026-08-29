import { relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema";

// ── L'application installée : appareils abonnés et joignabilité ──────────────
//
// Pourquoi un fichier de plus plutôt qu'une colonne dans `users` : un
// téléphoniste a un téléphone ET un poste de travail, parfois deux téléphones.
// Un abonnement push n'est pas un attribut de la personne, c'est un attribut de
// l'APPAREIL — et il en meurt régulièrement (désinstallation, réinitialisation
// du navigateur, révocation par le système). Une colonne aurait forcé le choix
// d'un seul appareil et rendu tous les autres silencieux sans que personne ne
// le voie.
//
// `src/db/schema.ts` est gelé (règle 7) et `drizzle.config.ts` aussi : il
// n'énumère que deux fichiers de schéma. Ce module est donc ré-exporté depuis
// `schema-sms.ts` — la seule façon d'obtenir un fichier PROPRE (ce n'est pas du
// SMS, et l'enfouir là aurait menti sur ce que contient ce fichier) sans
// toucher à un fichier gelé. Le jour où `drizzle.config.ts` s'ouvre, il suffit
// d'y ajouter cette ligne et de retirer la ré-exportation.

/**
 * Un abonnement Web Push — un par APPAREIL, pas un par personne.
 *
 * `endpoint` est l'identité de l'appareil du point de vue du service de push
 * (FCM, APNs, Mozilla) et c'est lui qui porte l'unicité : re-souscrire depuis
 * le même téléphone renvoie le même endpoint, et on met alors la ligne à jour
 * au lieu d'en créer une deuxième qui doublerait chaque notification.
 *
 * `p256dh` et `auth` sont les deux clés que le navigateur fabrique pour
 * chiffrer le contenu (RFC 8291). Elles ne sont pas des secrets de l'app — ce
 * sont les clés PUBLIQUES de l'appareil — donc pas de chiffrement au repos
 * ici : elles ne servent à rien sans le VAPID privé, qui vit en variable
 * d'environnement.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** URL du service de push. UNIQUE : c'est l'identité de l'appareil. */
    endpoint: text("endpoint").notNull().unique(),
    /** Clé publique P-256 de l'appareil, base64url (65 octets décodés). */
    p256dh: text("p256dh").notNull(),
    /** Secret d'authentification de l'appareil, base64url (16 octets décodés). */
    auth: text("auth").notNull(),
    /**
     * De quoi reconnaître SON téléphone dans la liste de /profile. L'écran
     * montre « iPhone · Safari », pas une URL de 300 caractères que personne
     * ne peut relier à un objet posé sur la table.
     */
    userAgent: text("user_agent"),
    label: text("label"),
    /**
     * `standalone` = ajouté à l'écran d'accueil, `browser` = onglet ordinaire.
     * Sur iOS, seul le premier reçoit quoi que ce soit : la distinction est ce
     * qui permet de dire « cet appareil n'est pas installé » plutôt que de
     * laisser croire qu'il est abonné.
     */
    display: text("display"),
    /**
     * Échecs consécutifs. Un 404/410 supprime la ligne immédiatement (le
     * service dit que l'appareil n'existe plus) ; ce compteur ne sert qu'aux
     * pannes AMBIGUËS — un service injoignable ne doit pas faire disparaître
     * l'abonnement d'un téléphone parfaitement vivant.
     */
    failureCount: integer("failure_count").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

/**
 * Ce par quoi on peut atteindre une personne, et ce qu'elle accepte de recevoir.
 *
 * Une ligne par utilisateur, créée à la première modification — son ABSENCE
 * signifie « les défauts », jamais « rien ». Un téléphoniste qui n'a jamais
 * ouvert cet écran reçoit donc les notifications utiles sans avoir rien à
 * régler ; c'est le silence qui se demande, pas le bruit.
 *
 * Le numéro de cellulaire est CHIFFRÉ (règle 4) : c'est un numéro personnel
 * confié à l'employeur pour une seule raison, et il n'a pas à être lisible par
 * quiconque met la main sur une copie de la base.
 */
export const userReach = pgTable("user_reach", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-256-GCM — voir src/lib/crypto.ts. E.164 une fois déchiffré. */
  mobilePhoneEnc: text("mobile_phone_enc"),
  /** Les 4 derniers chiffres, en clair, pour AFFICHER « •••• 1234 » sans déchiffrer. */
  mobileLast4: text("mobile_last4"),
  /**
   * Le consentement de la personne à ce que son numéro personnel sonne. Séparé
   * de l'interrupteur de l'administrateur : celui-ci ouvre la fonction pour
   * l'équipe, celui-là est le « oui » de l'individu. Il faut les DEUX.
   */
  ringMobile: boolean("ring_mobile").notNull().default(false),
  /**
   * Ce qui a le droit de faire vibrer le téléphone, par type d'événement.
   * Forme : { missed_call: true, sms_handoff: true, … }. Absent = les défauts
   * de `src/lib/push/policy.ts`.
   */
  pushPrefs: jsonb("push_prefs"),
  /**
   * Les heures de silence du TÉLÉPHONISTE — à ne pas confondre avec celles de
   * `src/lib/sms/quiet-hours.ts`, qui protègent le CLIENT de nos envois. Ici on
   * protège l'employé de son employeur, et les deux fenêtres n'ont aucune
   * raison de coïncider. Format « HH:mm », fuseau America/Toronto.
   */
  quietFrom: text("quiet_from"),
  quietTo: text("quiet_to"),
  /**
   * Ce que les heures de silence ne retiennent PAS. Un appel manqué à 21 h 30
   * est exactement ce pour quoi l'app a été installée ; un rappel de suivi à
   * 6 h 30 ne l'est pas.
   */
  quietBypassUrgent: boolean("quiet_bypass_urgent").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  user: one(users, { fields: [pushSubscriptions.userId], references: [users.id] }),
}));

export const userReachRelations = relations(userReach, ({ one }) => ({
  user: one(users, { fields: [userReach.userId], references: [users.id] }),
}));
