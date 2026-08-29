# L'application installée — découverte et décisions

**2026-08-28.** Rendre Nexus installable sur l'écran d'accueil d'un téléphoniste,
capable de le prévenir quand il ne regarde pas, et utilisable au pouce.

Ce document existe pour la même raison que `docs/sms-engine/00-discovery.md` : le
chantier traverse des fichiers gelés, une table nouvelle, de la cryptographie
écrite à la main et quatre décisions produit. Sans trace écrite, chacune sera
re-débattue dans trois mois — en particulier la première, qui est une mauvaise
nouvelle.

---

## D1 — Une PWA fermée ne peut PAS recevoir un appel téléphonique. (définitif)

C'était la demande explicite. Elle est impossible, et il vaut mieux le savoir
maintenant que le découvrir sur un prospect perdu.

- iOS suspend puis gèle une application d'écran d'accueil mise en arrière-plan.
  Chrome ferme les WebSockets à l'entrée en bfcache et détruit le moteur de
  rendu d'un onglet gelé au bout de quelques minutes. L'enregistrement SIP vit
  dans le JavaScript de la page (`TelephonyProvider`, `register_expires` 300 s) :
  il meurt avec elle.
- Un service worker ne peut pas tenir de socket : il est événementiel et tué
  après quelques dizaines de secondes d'inactivité.
- **Il n'existe aucun équivalent web de PushKit / CallKit / Critical Alerts.**
  Une notification poussée sur iOS est une notification ORDINAIRE : elle ne
  sonne pas comme un appel, ne traverse pas un mode Concentration, n'a pas de
  sonnerie personnalisée, et le Résumé programmé peut la retenir des heures.
- La documentation de Twilio dit la même chose de son propre SDK JavaScript et
  renvoie aux SDK natifs.

Le budget « réveil par poussée » : transit 1–5 s + réaction humaine 2–10 s +
démarrage à froid, session, REGISTER, ICE 3–10 s ⇒ **10 à 25 s**, contre 30 s de
sonnerie (`timeout="30"` déjà en place). L'appelant n'attend pas.

**Conclusion : le réveil par poussée dit « tu as manqué un appel, voici qui »,
jamais « décroche ». Faire sonner un vrai téléphone est un problème de ROUTAGE
TÉLÉPHONIQUE, pas un problème de PWA.**

## D2 — Poussée par défaut, sonnerie sur cellulaire en option. (exploitant)

Décision d'Alex, 2026-08-28. Les deux chemins sont construits :

- **Par défaut** : notification poussée seule. Aucun numéro personnel n'est
  demandé, aucun routage voip.ms n'est modifié.
- **En option** : l'administrateur allume la sonnerie simultanée
  (`telephony.simulRing.enabled`), et chaque téléphoniste fournit son cellulaire
  et l'autorise pour lui-même. **Il faut les deux** — l'interrupteur de la
  maison et le « oui » de la personne. Un numéro personnel qui se met à sonner
  parce qu'un défaut a changé serait la pire des surprises.
- Twilio : un `<Dial>` avec deux enfants, `<Client>` et `<Number>`. Option
  éteinte, le TwiML sortant est identique octet pour octet à celui d'avant
  (`tests/unit-simulring.test.ts` compare la chaîne entière).
- voip.ms : pas d'équivalent en ligne — il faut un objet « Ring Group » créé
  d'avance chez eux, dont le DID devient la destination
  (`simulring-voipms.ts`).

## D3 — Ce qui pousse, et ce qui se tait. (exploitant)

« Le push, c'est quand un client appelle le téléphone du téléphoniste. Pour le
fil de SMS avec l'IA, envoie uniquement la notif pour un passage humain. »

La table est dans `src/lib/push/policy.ts`, fermée et testée. En résumé :

| Pousse | Se tait |
| --- | --- |
| `missed_call` (urgent) | `sms_closed` — l'assistant a fermé proprement |
| `sms_inbound` — fil SANS assistant (urgent) | `system` — avertissements d'exploitation |
| `sms_handoff` — l'IA rend la main (urgent) | |
| `incoming_lead` (urgent) | |
| `sms_blocked`, `sms_error`, `sms_stopped` | |
| `mention`, `assignment`, `followup_due`, `appointment` | |

« Urgent » = traverse les heures de silence du téléphoniste, si celui-ci l'a
laissé cocher. Le silence se demande ; il n'est jamais le défaut.

## D4 — Les heures de silence du TÉLÉPHONISTE ≠ celles du CLIENT.

`src/lib/sms/quiet-hours.ts` existait déjà et protège le CLIENT de nos envois
(politesse, conformité : semaine 9–20, samedi 10–20, dimanche 11–19). Le
réutiliser pour la poussée aurait rendu l'application inutile aux deux bouts de
la journée — un courtier travaille précisément quand ses clients sont chez eux.
Les heures de silence de la poussée sont donc un champ à part
(`user_reach.quiet_from` / `quiet_to`), par personne, avec une échappatoire pour
l'urgent.

## D5 — Où vivent les abonnements. (contournement d'un fichier gelé)

`src/db/schema.ts` est gelé (règle 7) **et** `drizzle.config.ts` aussi — ce
dernier n'énumère que deux fichiers de schéma, donc un troisième ne serait
jamais vu par `drizzle-kit`.

Retenu : **`src/db/schema-push.ts`**, un fichier propre, **ré-exporté par une
ligne de `schema-sms.ts`** (`export * from "./schema-push"`). `drizzle-kit` lit
les tables exportées de `schema-sms.ts`, donc il les voit ; vérifié par
`drizzle-kit export`. Enfouir ces tables DANS `schema-sms.ts` aurait menti sur ce
que contient ce fichier.

> **À signaler à l'exploitant (règle 7)** : le jour où `drizzle.config.ts`
> s'ouvre, ajouter `./src/db/schema-push.ts` à sa liste et retirer la
> ré-exportation. Rien d'autre à changer.

Deux tables : `push_subscriptions` (une par APPAREIL — un téléphoniste a un
téléphone et un poste) et `user_reach` (cellulaire chiffré, préférences, heures
de silence). Ajoutées à la liste de troncature de `tests/helpers/db.ts`, sans
quoi la première suite d'intégration à compter des lignes échouerait ailleurs.

**Déploiement : `pnpm db:push` en production passe par le pooler SESSION
(:5432), jamais le pooler transaction.**

## D6 — Web Push écrit à la main, sans dépendance.

`package.json` est gelé et `web-push` n'y est pas. Écrit sur ce qui est
installé :

- **VAPID** (RFC 8292) : JWT ES256 signé avec `jose`, déjà présent.
- **Chiffrement** (RFC 8291, `aes128gcm`) : ECDH P-256 + HKDF + AES-128-GCM de
  `node:crypto`.
- **Le vecteur de test §5 de la RFC est épinglé octet par octet** dans
  `tests/unit-push-crypto.test.ts`, plus un déchiffreur indépendant écrit du
  point de vue du navigateur. Deux implémentations qui se trompent pareil, ce
  serait deux fois la même faute.

Piège trouvé et neutralisé : `createECDH().getPrivateKey()` rend **moins de 32
octets environ 3 fois sur 1000** (Node retire les zéros de tête). La clé passe
tous les essais, puis un jour le service de push répond 403 — sans erreur
ailleurs. `padTo32()` complète à gauche, et le chargeur refuse une clé qui ne
fait pas exactement 32 octets.

> **À signaler à l'exploitant** : générer la paire UNE fois
> (`pnpm tsx scripts/generate-vapid.ts`), la déposer dans Vercel pour tous les
> environnements, et ne plus jamais y toucher. La clé publique est scellée dans
> chaque abonnement au moment où le navigateur s'inscrit : la changer rend
> **tous** les appareils déjà inscrits injoignables, sans moyen de les
> re-inscrire depuis le serveur.

## D7 — Un seul point de passage pour les notifications.

Onze `db.insert(notifications)` dans neuf fichiers, à travers quatre aides
locales sans lien entre elles. Y brancher la poussée une par une, c'était onze
occasions d'en oublier une — et l'oubli ne se voit pas : la notification ne
sonne simplement jamais. Tout passe désormais par `createNotifications()`
(`src/lib/notify.ts`), et `tests/unit-notify-chokepoint.test.ts` refuse une
insertion directe.

La poussée part **après la réponse** (`runAfterResponse`) : un envoi vers APNs se
compte en secondes et le webhook Twilio qui l'a déclenchée est impatient. Pour
`cdr-sync.ts`, qui écrit DANS une transaction, les lignes rejoignent la
transaction mais la poussée reste dehors : annoncer des appels manqués qu'un
`rollback` efface ensuite serait irrattrapable — une notification livrée ne se
rappelle pas.

## D8 — Ce que la poussée n'a pas le droit de dire.

Une notification est du texte qui SURVIT : « Marie Tremblay (418 555-1234) vous a
rappelé » reste écrit le jour où la fiche passe au courtier. L'écran
`/notifications` le sait déjà et tait ces lignes ; un écran verrouillé n'a aucun
filtre. `fanoutPush` **re-vérifie donc la visibilité pour le DESTINATAIRE au
moment de l'envoi** (règle 1), refuse les comptes désactivés, et purge un
abonnement dès qu'un service répond 404/410.

## D9 — Le lien profond survit à une session expirée.

Le proxy effaçait la barre d'adresse (`url.search = ""`) et `loginAction`
repartait invariablement vers `/dashboard`. Toute la valeur d'une notification
tient dans « CE client-là » : le système d'exploitation expulse l'application
pendant la nuit, la notification du matin arrive sur une session morte, et la
destination était perdue. Un `?next=` la traverse maintenant, validé par
`safeNextPath()` — une liste blanche de FORME, parce qu'une redirection ouverte
depuis notre page de connexion serait la meilleure adresse possible pour un
hameçonnage.

## Ce qui a été trouvé chemin faisant

- **`viewport-fit=cover` n'était pas déclaré**, donc toutes les valeurs
  `env(safe-area-inset-*)` valaient zéro : `.pb-safe`, `.h-bottom-nav` et le
  socle du webphone étaient du code mort que la barre d'adresse du navigateur
  cachait. Installée, l'application posait ses boutons sous la barre de geste.
- **Le proxy renvoyait `/manifest.webmanifest` et `/sw.js` vers `/login`.** Le
  navigateur demande le manifeste SANS cookie : il recevait la page de connexion
  et n'offrait plus jamais l'installation. Un script de service worker redirigé
  fait échouer `register()` par spécification. Aucune des deux pannes ne produit
  d'erreur visible.
- **`maximumScale: 1`** bloquait le zoom — échec WCAG 1.4.4, et en plein écran
  il n'y a plus de barre de navigateur où se rabattre. Retiré.
- **`notifyHumans` retombait sur `users.role = "admin"`**, le PLANCHER de
  l'énumération gelée. Depuis les rôles configurables (2026-08-28), un
  « Superviseur » est stocké `caller` : il ne recevait jamais le repli. Corrigé
  pour interroger le rôle EFFECTIF.
- **Aucune frontière d'erreur** n'existait dans `src/app` — ni `error.tsx`, ni
  `not-found.tsx`. Une application installée sur le réseau cellulaire n'avait
  que la page d'erreur brute de Next, dans une fenêtre sans barre de navigateur
  et sans retour possible.
- **Rien ne réagissait au retour de veille** : pas un `pagehide`, pas un
  `online`, pas un `resume` dans tout `src/`. Une application réveillée par une
  notification reprenait sur un état périmé.
- **Aucun test ne comparait `messages/fr` et `messages/en`.** Ajouté — ces
  chaînes s'affichent maintenant sur un écran verrouillé, où l'on ne corrige
  rien après coup.

## Ce qui reste à faire par un humain

1. `pnpm tsx scripts/generate-vapid.ts` → poser `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` dans Vercel (tous environnements).
2. `pnpm db:push` en production, par le pooler SESSION (:5432).
3. Sur chaque téléphone : **Partager ⎋ → Sur l'écran d'accueil ➕**, puis ouvrir
   l'icône et accepter les notifications. Sur iOS ce sont deux gestes manuels,
   invérifiables depuis le serveur, et **sans le premier il n'y a pas de
   notifications du tout** — l'API Push n'existe pas hors d'une application
   installée.
4. Vérifier avec le bouton d'essai de `/profile` — la chaîne compte huit maillons
   et chacun échoue en silence.
5. **Il n'y a pas de CI** (`.github/` n'existe pas) et les poussées vers
   `origin/main` déploient en production. Les tests de convention de ce dépôt ne
   s'exécutent que sur un portable, à la main.
