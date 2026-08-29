import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";
import { desc, eq } from "drizzle-orm";
import { UserRound } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { ProfileForm } from "@/components/profile/profile-form";
import { LookGlyph, roleLook } from "@/components/look";
import { NotificationSettings, type PushTypeOption } from "@/components/pwa/notification-settings";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db";
import { pushSubscriptions, userReach } from "@/db/schema-push";
import { formatPhone } from "@/lib/phone";
import { requireActor } from "@/lib/permissions/server";
import { loadVapidKeys } from "@/lib/push/keys";
import { NOTIFICATION_TYPES, pushRule } from "@/lib/push/policy";
import { getSetting } from "@/lib/settings";
import { simulRingLine } from "@/lib/telephony/simulring";

const APP_TZ = "America/Toronto";

/** « Mon profil » — accessible à tous les rôles depuis le menu utilisateur. */
export default async function ProfilePage() {
  // L'acteur plutôt que le compte seul : la pastille annonce le rôle CONFIGURÉ
  // (« Superviseur », « Observateur », celui inventé ce matin), pas le plancher
  // administrateur/téléphoniste de la base — deux personnes de la même colonne
  // `users.role` n'ont plus du tout les mêmes droits.
  const actor = await requireActor();
  const user = actor.user;
  const t = await getTranslations("common");
  const tn = await getTranslations("notifications");
  const locale = await getLocale();
  const roleName = locale === "en" ? actor.role.nameEn : actor.role.nameFr;

  // Aucun droit de rôle ici : régler SES propres notifications découle d'être
  // connecté, et toutes ces lectures sont bornées à `user.id`. Il n'y a rien à
  // filtrer par visibilité (règle 13) — on ne lit que soi.
  const [devices, reachRows, telephony] = await Promise.all([
    db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        label: pushSubscriptions.label,
        userAgent: pushSubscriptions.userAgent,
        display: pushSubscriptions.display,
        createdAt: pushSubscriptions.createdAt,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, user.id))
      .orderBy(desc(pushSubscriptions.createdAt)),
    db.select().from(userReach).where(eq(userReach.userId, user.id)).limit(1),
    getSetting("telephony"),
  ]);
  const reach = reachRows[0] ?? null;

  /**
   * Les types qu'on peut cocher sont ceux que la politique pousse VRAIMENT :
   * offrir un interrupteur pour `system` ou `sms_closed`, que `pushRule` refuse
   * de pousser de toute façon, serait promettre un réglage sans effet.
   *
   * Les libellés viennent du namespace `notifications`, qui les possède déjà —
   * sauf ceux que ce fichier n'a jamais eu à nommer (les cinq types SMS
   * n'apparaissent pas dans sa liste). Ils vivent alors dans `common.push.types`
   * plutôt que d'être inventés ici en dur : le jour où `notifications` les
   * nomme, `has()` reprend la main sans qu'on touche à rien.
   *
   * Les urgences d'abord : ce sont elles que les heures de silence laissent
   * passer, et les voir groupées explique le réglage d'à côté mieux qu'une
   * phrase.
   */
  const pushTypes: PushTypeOption[] = NOTIFICATION_TYPES.filter((type) => pushRule(type).push)
    .map((type) => ({
      key: type,
      urgent: pushRule(type).urgent,
      label: tn.has(`types.${type}`) ? tn(`types.${type}`) : t(`push.types.${type}`),
    }))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent));

  // Une préférence ABSENTE vaut oui : c'est le silence qui se demande (voir
  // `shouldPush`). L'écran doit donc afficher « coché » par défaut, sans quoi
  // il annoncerait un silence que le moteur n'applique pas.
  const stored = (reach?.pushPrefs ?? null) as Record<string, boolean> | null;
  const prefs = Object.fromEntries(pushTypes.map((row) => [row.key, stored?.[row.key] !== false]));

  const dfnsLocale = locale === "en" ? enUS : fr;
  const enrolled = devices.map((device) => ({
    id: device.id,
    // Jamais l'endpoint en entier jusqu'au navigateur : c'est un jeton d'envoi.
    // Sa fin suffit à reconnaître l'appareil qu'on a en main — c'est déjà ce
    // que le journal d'audit consigne.
    tail: device.endpoint.slice(-12),
    label: device.label,
    userAgent: device.userAgent,
    display: device.display,
    addedAt: formatInTimeZone(device.createdAt, APP_TZ, "d MMM yyyy", { locale: dfnsLocale }),
  }));

  /**
   * Faire sonner un cellulaire demande TROIS oui (voir `resolveSimulRing`) :
   * celui de la maison, celui de l'administrateur sur cette ligne-ci, et celui
   * de la personne. L'écran ne montre que le troisième — mais il annonce l'état
   * des deux autres, sinon il offrirait un interrupteur qui ne déclenche rien
   * et laisserait chercher pourquoi le téléphone reste muet.
   */
  const simulRing = telephony.simulRing;
  const ring = !simulRing.enabled
    ? "feature_off"
    : !simulRingLine(simulRing, user.id).enabled
      ? "line_off"
      : "on";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-4 md:px-6 md:py-6">
      <PageHeader
        icon={<UserRound />}
        title={user.name}
        titleAccessory={
          <Badge variant="secondary" className="gap-1.5">
            <LookGlyph look={roleLook(actor.role.look)} className="size-3" />
            {roleName}
          </Badge>
        }
        subtitle={
          user.didNumber
            ? `${t("profile.lineNumber")} : ${formatPhone(user.didNumber)}`
            : undefined
        }
      />

      <ProfileForm initialName={user.name} initialEmail={user.email} />

      <NotificationSettings
        vapidPublicKey={loadVapidKeys()?.publicKey ?? null}
        devices={enrolled}
        types={pushTypes}
        prefs={prefs}
        quiet={{
          from: reach?.quietFrom ?? "",
          to: reach?.quietTo ?? "",
          bypassUrgent: reach?.quietBypassUrgent ?? true,
        }}
        mobile={{ last4: reach?.mobileLast4 ?? null, ringMobile: reach?.ringMobile ?? false }}
        ring={ring}
      />
    </div>
  );
}
