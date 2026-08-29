"use client";

import { BellRing, Inbox, MonitorSmartphone, MoonStar, PhoneForwarded, Trash2, Vibrate } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  forgetDeviceAction,
  updateMobileAction,
  updatePushPrefsAction,
  updateQuietHoursAction,
} from "@/app/(app)/profile/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * « Notifications » — la moitié visible de la poussée, sur l'écran de son
 * propriétaire.
 *
 * Tout ce fichier existe parce qu'un abonnement Web Push appartient à un
 * APPAREIL et non à une personne : le téléphone qu'on a en poche, celui qu'on a
 * changé le mois dernier et le poste de travail du bureau sont trois lignes
 * distinctes, dont deux mentent si on ne les montre pas. D'où quatre cartes
 * plutôt qu'un interrupteur : ce qu'on active ICI, ce qu'on a activé ailleurs,
 * ce qu'on accepte de recevoir, et quand on refuse d'être dérangé.
 *
 * La règle qui gouverne l'écran : ne jamais afficher un réglage qui ne fait
 * rien. Un navigateur qui ne sait pas recevoir, une permission refusée qu'aucun
 * site ne peut redemander, une sonnerie que l'administrateur n'a pas ouverte —
 * chacun de ces états DIT ce qui manque et où le corriger, au lieu d'offrir un
 * bouton qui laisserait croire que c'est réglé.
 */

export type PushTypeOption = {
  key: string;
  label: string;
  /** Traverse les heures de silence — voir `pushRule().urgent`. */
  urgent: boolean;
};

export type EnrolledDevice = {
  id: string;
  /**
   * Les douze derniers caractères de l'endpoint, et rien de plus. L'endpoint
   * entier est un jeton d'envoi ; sa fin suffit pour reconnaître l'appareil
   * qu'on tient en main, et c'est déjà la forme que retient le journal d'audit.
   */
  tail: string;
  label: string | null;
  userAgent: string | null;
  display: string | null;
  /** Déjà formatée côté serveur, au fuseau de Toronto (règle 9). */
  addedAt: string;
};

export type NotificationSettingsProps = {
  /** `null` = le serveur n'a pas de clés VAPID : personne ne peut recevoir. */
  vapidPublicKey: string | null;
  devices: EnrolledDevice[];
  types: PushTypeOption[];
  prefs: Record<string, boolean>;
  quiet: { from: string; to: string; bypassUrgent: boolean };
  /** Le numéro ne descend jamais ici — seulement ses quatre derniers chiffres. */
  mobile: { last4: string | null; ringMobile: boolean };
  /** L'état des DEUX interrupteurs de l'administrateur (`telephony.simulRing`). */
  ring: "on" | "feature_off" | "line_off";
};

/**
 * Où en est CE navigateur. `checking` est l'état du premier rendu : rien de ce
 * qui suit n'existe côté serveur, et afficher « à activer » avant d'avoir lu
 * `Notification.permission` ferait clignoter l'écran à chaque chargement.
 */
type DeviceState = "checking" | "unsupported" | "install" | "prompt" | "granted" | "denied";

// ── Ce que le navigateur veut bien dire de lui-même ──────────────────────────

/** L'application est-elle lancée depuis l'écran d'accueil plutôt qu'un onglet ? */
function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iPhone ou iPad — y compris l'iPad moderne, qui se présente comme un
 * Macintosh et que seul le tactile trahit. La distinction n'est pas cosmétique :
 * sur iOS, une page ouverte dans un ONGLET ne reçoit rien, quoi qu'on fasse.
 * Sans ce test, l'écran offrirait un bouton dont l'échec serait incompréhensible.
 */
function isAppleTouch(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * La clé VAPID publique, en octets — ce que `pushManager.subscribe` réclame.
 *
 * Le type est `Uint8Array<ArrayBuffer>` et non le `Uint8Array` nu : depuis
 * TypeScript 5.7, celui-ci autorise aussi un `SharedArrayBuffer`, que
 * `BufferSource` refuse. Sans la précision, l'appel ne compile pas.
 */
function applicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * « iPhone · Safari » plutôt qu'une URL de trois cents caractères.
 *
 * Des marques, pas des libellés : rien à traduire ici, et c'est voulu — un
 * téléphoniste reconnaît « Android · Chrome » dans les deux langues, alors
 * qu'une traduction de « Chrome » serait une devinette. Seul le repli, quand
 * la chaîne n'apprend rien, passe par le dictionnaire.
 */
function platformOf(ua: string): string | null {
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return null;
}

function browserOf(ua: string): string | null {
  // L'ordre est le tout : Edge et Chrome se déclarent « Safari », et Chrome sur
  // iPhone se déclare « CriOS ». Tester Safari en premier étiquetterait la
  // moitié du parc comme du Safari.
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\/|FxiOS/.test(ua)) return "Firefox";
  if (/CriOS|Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return null;
}

export function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const parts = [platformOf(userAgent), browserOf(userAgent)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

type DeviceProbe = {
  state: DeviceState;
  tail: string | null;
  registration: ServiceWorkerRegistration | null;
};

/**
 * Tout ce que ce navigateur a à dire, en une seule fois.
 *
 * L'ordre des refus n'est pas indifférent. iOS d'abord : dans un ONGLET,
 * `Notification` et `PushManager` existent, la permission peut même être
 * accordée, et rien n'arrivera jamais — c'est la panne la plus déroutante de
 * toutes, parce que tout a l'air de fonctionner. Le manque de capacités ensuite,
 * puis seulement la permission.
 */
async function probeDevice(): Promise<DeviceProbe> {
  if (isAppleTouch() && !isStandalone()) {
    return { state: "install", tail: null, registration: null };
  }
  // `isSecureContext` compte autant que les trois API : hors HTTPS (et hors
  // localhost), `register()` échoue — mieux vaut le dire que d'offrir un bouton
  // qui lèvera une exception à la première pression.
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return { state: "unsupported", tail: null, registration: null };
  }

  const state: DeviceState =
    Notification.permission === "granted"
      ? "granted"
      : Notification.permission === "denied"
        ? "denied"
        : "prompt";

  try {
    // `register()` est idempotent : il rend l'enregistrement existant plutôt
    // que d'en empiler un second, et il survit à la navigation comme à la
    // fermeture de l'application. Les options sont MOT POUR MOT celles de
    // `PwaBootstrap` : ré-enregistrer le même script avec des options
    // différentes ne crée pas une seconde inscription, il RÉÉCRIT celles de la
    // première — et `updateViaCache: "none"` est précisément ce qui permet à un
    // correctif du worker de se déployer, au lieu de rester servi depuis le
    // cache HTTP pendant des jours.
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    const existing = await registration.pushManager.getSubscription();
    return { state, tail: existing ? existing.endpoint.slice(-12) : null, registration };
  } catch {
    // Un worker qui refuse de s'enregistrer (navigation privée, réseau coupé)
    // ne change rien à la permission : on garde l'état lu, sans abonnement.
    return { state, tail: null, registration: null };
  }
}

export function NotificationSettings({
  vapidPublicKey,
  devices,
  types,
  prefs: initialPrefs,
  quiet: initialQuiet,
  mobile,
  ring,
}: NotificationSettingsProps) {
  const t = useTranslations("common");
  const router = useRouter();

  const [state, setState] = useState<DeviceState>("checking");
  const [tail, setTail] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [testing, setTesting] = useState(false);
  const registration = useRef<ServiceWorkerRegistration | null>(null);

  /**
   * L'écran ne bascule qu'UNE fois, de « on regarde » à un état définitif :
   * tout ce que le navigateur a à dire est lu d'un coup par `probeDevice`, puis
   * appliqué dans un seul rendu. Trois lectures séparées feraient clignoter la
   * carte à chaque chargement, entre « à activer » et « déjà activé ».
   *
   * L'enregistrement du service worker se fait ICI, au montage, et pas dans le
   * gestionnaire de clic : iOS n'accorde la permission que si
   * `requestPermission()` descend d'un vrai geste de l'utilisateur, et le
   * moindre `await` avant l'appel rompt ce lien. Quand le doigt touche le
   * bouton, la registration doit déjà être là.
   */
  useEffect(() => {
    let alive = true;
    probeDevice()
      .then((probe) => {
        if (!alive) return;
        registration.current = probe.registration;
        setState(probe.state);
        setTail(probe.tail);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Inscrit VRAIMENT quand le navigateur a un abonnement ET que le serveur en a
   * la trace. Les deux se perdent séparément — une ligne supprimée depuis un
   * autre écran, un navigateur qui a fait tourner ses clés — et il ne faut pas
   * annoncer « activé » quand la moitié manque : c'est le silence qu'on ne
   * diagnostique jamais.
   */
  const enrolledHere = tail !== null && devices.some((device) => device.tail === tail);

  const enable = () => {
    const reg = registration.current;
    if (!reg || !vapidPublicKey) {
      toast.error(t("push.enableFailed"));
      return;
    }
    setEnabling(true);
    // ⚠️ Aucun `await` avant cette ligne : sur iOS, la permission n'est
    // accordée que si l'appel descend directement du geste de l'utilisateur.
    // Une seule micro-tâche intercalée, et Safari refuse sans rien dire.
    Promise.resolve(Notification.requestPermission())
      .then((permission) => {
        setState(permission === "granted" ? "granted" : permission === "denied" ? "denied" : "prompt");
        if (permission !== "granted") return null;
        const options: PushSubscriptionOptionsInit = {
          // Obligatoire : le web n'a pas de poussée silencieuse, et WebKit
          // révoque l'abonnement d'une application qui n'affiche rien.
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(vapidPublicKey),
        };
        return reg.pushManager.subscribe(options).catch(async (error: unknown) => {
          // Un abonnement pris sous une AUTRE clé VAPID fait échouer celui-ci
          // (InvalidStateError) — c'est ce qui arrive au lendemain d'une
          // rotation de clés. On défait l'ancien et on recommence, plutôt que
          // de laisser l'appareil définitivement muet avec un bouton qui
          // échoue sans rien expliquer.
          const stale = await reg.pushManager.getSubscription();
          if (!stale) throw error;
          await stale.unsubscribe();
          return reg.pushManager.subscribe(options);
        });
      })
      .then(async (subscription) => {
        if (!subscription) return;
        const keys = subscription.toJSON().keys;
        const response = await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subscription: {
              endpoint: subscription.endpoint,
              keys: { p256dh: keys?.p256dh, auth: keys?.auth },
            },
            label: describeDevice(navigator.userAgent) ?? undefined,
            display: isStandalone() ? "standalone" : "browser",
          }),
        });
        if (!response.ok) throw new Error("subscribe");
        setTail(subscription.endpoint.slice(-12));
        toast.success(t("push.enabled"));
        router.refresh();
      })
      .catch(() => toast.error(t("push.enableFailed")))
      .finally(() => setEnabling(false));
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      if (response.ok) toast.success(t("push.testSent"));
      else toast.error(t("push.testFailed"));
    } catch {
      toast.error(t("push.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="space-y-4 md:space-y-5">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 font-heading text-lg font-medium">
          <BellRing className="size-4 text-muted-foreground" aria-hidden />
          {t("push.sectionTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("push.sectionSubtitle")}</p>
      </div>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <ThisDeviceCard
          state={state}
          configured={vapidPublicKey !== null}
          enrolled={enrolledHere}
          enabling={enabling}
          testing={testing}
          onEnable={enable}
          onTest={sendTest}
        />
        <DevicesCard devices={devices} currentTail={tail} registration={registration} />
        <TypesCard types={types} initial={initialPrefs} />
        <QuietHoursCard initial={initialQuiet} />
        <MobileCard last4={mobile.last4} ringMobile={mobile.ringMobile} ring={ring} />
      </div>
    </section>
  );
}

// ── 1. Cet appareil ──────────────────────────────────────────────────────────

function ThisDeviceCard({
  state,
  configured,
  enrolled,
  enabling,
  testing,
  onEnable,
  onTest,
}: {
  state: DeviceState;
  configured: boolean;
  enrolled: boolean;
  enabling: boolean;
  testing: boolean;
  onEnable: () => void;
  onTest: () => void;
}) {
  const t = useTranslations("common");

  /**
   * Un seul message à la fois, et le plus BLOQUANT en premier : un serveur sans
   * clé rend le reste sans objet, et un iPhone dans un onglet ne recevra rien
   * même avec la permission accordée. Les empiler tous laisserait choisir au
   * lecteur lequel le concerne.
   */
  const blocker =
    !configured
      ? t("push.notConfigured")
      : state === "install"
        ? t("push.installNeeded")
        : state === "unsupported"
          ? t("push.unsupported")
          : state === "denied"
            ? t("push.denied")
            : null;

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Vibrate className="size-4 text-muted-foreground" aria-hidden />
          {t("push.deviceTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("push.deviceIntro")}</p>

        {blocker ? <p className="text-sm text-foreground">{blocker}</p> : null}

        {!blocker && enrolled ? (
          <div className="space-y-3">
            <p className="text-sm">{t("push.activeHere")}</p>
            <Button
              type="button"
              variant="outline"
              onClick={onTest}
              disabled={testing}
              className="min-h-11 w-full sm:w-auto md:min-h-9"
            >
              {t("push.test")}
            </Button>
          </div>
        ) : null}

        {!blocker && !enrolled && state !== "checking" ? (
          <Button
            type="button"
            onClick={onEnable}
            disabled={enabling}
            className="min-h-11 w-full sm:w-auto md:min-h-9"
          >
            {enabling ? t("push.enabling") : t("push.enable")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── 2. Mes appareils ─────────────────────────────────────────────────────────

function DevicesCard({
  devices,
  currentTail,
  registration,
}: {
  devices: EnrolledDevice[];
  currentTail: string | null;
  registration: React.RefObject<ServiceWorkerRegistration | null>;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const forget = (device: EnrolledDevice) => {
    setBusy(device.id);
    startTransition(async () => {
      // Se désabonner de SON propre navigateur d'abord : sans cela, le service
      // de push continue d'accepter des envois pour un abonnement que la base
      // ne connaît plus, et le bouton « Activer » reviendrait sur un endpoint
      // déjà vivant — l'appareil se croirait sourd tout en pouvant sonner.
      if (currentTail && device.tail === currentTail) {
        try {
          const existing = await registration.current?.pushManager.getSubscription();
          await existing?.unsubscribe();
        } catch {
          // Un navigateur qui refuse de se désabonner ne doit pas empêcher la
          // ligne de disparaître de la base : c'est elle qui décide des envois.
        }
      }
      const result = await forgetDeviceAction({ id: device.id });
      setBusy(null);
      if (result.ok) {
        toast.success(t("push.forgotten"));
        router.refresh();
      } else {
        toast.error(t("error"));
      }
    });
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden />
          {t("push.devicesTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("push.devicesEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {devices.map((device) => {
              const name = device.label ?? describeDevice(device.userAgent) ?? t("push.unknownDevice");
              const here = currentTail !== null && device.tail === currentTail;
              return (
                <li
                  key={device.id}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {name}
                      {here ? <Badge variant="secondary">{t("push.thisDevice")}</Badge> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("push.addedOn", { date: device.addedAt })}
                      {device.display
                        ? ` — ${device.display === "standalone" ? t("push.installedApp") : t("push.browserTab")}`
                        : null}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => forget(device)}
                    disabled={pending && busy === device.id}
                    aria-label={t("push.forgetLabel", { device: name })}
                    className="min-h-11 md:min-h-9"
                  >
                    <Trash2 aria-hidden />
                    {t("push.forget")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── 3. Ce que je veux recevoir ───────────────────────────────────────────────

function TypesCard({
  types,
  initial,
}: {
  types: PushTypeOption[];
  initial: Record<string, boolean>;
}) {
  const t = useTranslations("common");
  const [prefs, setPrefs] = useState(initial);
  const [saving, startSaving] = useTransition();

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    startSaving(async () => {
      const result = await updatePushPrefsAction({ prefs });
      if (result.ok) toast.success(t("saved"));
      else toast.error(t("error"));
    });
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Inbox className="size-4 text-muted-foreground" aria-hidden />
          {t("push.typesTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("push.typesIntro")}</p>
          <ul className="space-y-0.5">
            {types.map((type) => (
              <li key={type.key} className="flex min-h-11 items-center gap-3">
                <Checkbox
                  id={`push-type-${type.key}`}
                  checked={prefs[type.key] !== false}
                  onCheckedChange={(checked) =>
                    setPrefs((current) => ({ ...current, [type.key]: checked === true }))
                  }
                  className="after:-inset-3.5"
                />
                <Label
                  htmlFor={`push-type-${type.key}`}
                  className="flex flex-1 flex-wrap items-center gap-1.5 font-normal"
                >
                  {type.label}
                  {/* L'étiquette double le mot, elle ne le remplace pas : c'est
                      elle qui explique la case « urgences » d'à côté. */}
                  {type.urgent ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {t("push.urgentMark")}
                    </Badge>
                  ) : null}
                </Label>
              </li>
            ))}
          </ul>
          <Button type="submit" disabled={saving} className="min-h-11 w-full sm:w-auto md:min-h-9">
            {t("profile.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── 4. Heures de silence ─────────────────────────────────────────────────────

function QuietHoursCard({
  initial,
}: {
  initial: { from: string; to: string; bypassUrgent: boolean };
}) {
  const t = useTranslations("common");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [bypass, setBypass] = useState(initial.bypassUrgent);
  const [saving, startSaving] = useTransition();

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    startSaving(async () => {
      const result = await updateQuietHoursAction({ from, to, bypassUrgent: bypass });
      if (result.ok) toast.success(t("saved"));
      else toast.error(result.error === "invalid" ? t("push.quietInvalid") : t("error"));
    });
  };

  const field = "min-h-11 md:min-h-9";

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <MoonStar className="size-4 text-muted-foreground" aria-hidden />
          {t("push.quietTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("push.quietIntro")}</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="quiet-from">{t("push.quietFrom")}</Label>
              <Input
                id="quiet-from"
                type="time"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className={field}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quiet-to">{t("push.quietTo")}</Label>
              <Input
                id="quiet-to"
                type="time"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className={field}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex min-h-11 items-center gap-3 md:min-h-9">
              <Switch id="quiet-bypass" checked={bypass} onCheckedChange={setBypass} />
              <Label htmlFor="quiet-bypass" className="font-normal">
                {t("push.quietBypass")}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">{t("push.quietBypassHelp")}</p>
          </div>

          <Button type="submit" disabled={saving} className={`${field} w-full sm:w-auto`}>
            {t("profile.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── 5. Mon cellulaire ────────────────────────────────────────────────────────

function MobileCard({
  last4,
  ringMobile,
  ring,
}: {
  last4: string | null;
  ringMobile: boolean;
  ring: "on" | "feature_off" | "line_off";
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [wantsRing, setWantsRing] = useState(ringMobile);
  const [saving, startSaving] = useTransition();
  const [removing, startRemoving] = useTransition();

  // L'interrupteur s'ouvre dès qu'il y a un numéro à faire sonner — celui qui
  // est enregistré, ou celui qu'on est en train de taper. Attendre un premier
  // enregistrement obligerait à revenir cocher, et personne ne revient.
  const hasNumber = last4 !== null || phone.trim() !== "";
  const available = ring === "on";

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    startSaving(async () => {
      // Champ vide = « je ne touche pas au numéro » (null), jamais « efface » :
      // l'écran ne connaît que « •••• 0199 », il ne peut pas redonner ce qu'on
      // ne lui a jamais confié. Le retrait a son propre bouton.
      const result = await updateMobileAction({
        phone: phone.trim() === "" ? null : phone,
        ringMobile: wantsRing,
      });
      if (result.ok) {
        toast.success(t("saved"));
        setPhone("");
        // Les quatre derniers chiffres viennent du serveur : sans rafraîchir,
        // l'écran continuerait d'afficher l'ancien numéro masqué.
        router.refresh();
      } else {
        toast.error(result.error === "phone" ? t("push.mobileInvalid") : t("error"));
      }
    });
  };

  const remove = () => {
    startRemoving(async () => {
      const result = await updateMobileAction({ phone: "", ringMobile: false });
      if (result.ok) {
        toast.success(t("saved"));
        setPhone("");
        setWantsRing(false);
        router.refresh();
      } else {
        toast.error(t("error"));
      }
    });
  };

  const field = "min-h-11 md:min-h-9";

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <PhoneForwarded className="size-4 text-muted-foreground" aria-hidden />
          {t("push.mobileTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("push.mobileIntro")}</p>

          <div className="space-y-1.5">
            <Label htmlFor="mobile-phone">{t("push.mobileNumber")}</Label>
            {last4 ? (
              <p className="text-sm">{t("push.mobileStored", { last4 })}</p>
            ) : null}
            <Input
              id="mobile-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={40}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className={field}
            />
            <p className="text-xs text-muted-foreground">{t("push.mobileHelp")}</p>
          </div>

          {/* L'interrupteur reste VISIBLE quand la maison n'a pas ouvert la
              fonction, mais désactivé et expliqué : le cacher laisserait croire
              que le réglage n'existe pas, l'offrir actif promettrait une
              sonnerie qui n'arriverait jamais (voir `resolveSimulRing`). */}
          <div className="space-y-1.5">
            <div className="flex min-h-11 items-center gap-3 md:min-h-9">
              <Switch
                id="mobile-ring"
                checked={wantsRing}
                disabled={!available || !hasNumber}
                onCheckedChange={setWantsRing}
              />
              <Label htmlFor="mobile-ring" className="font-normal">
                {t("push.ringMobile")}
              </Label>
            </div>
            {ring !== "on" ? (
              <p className="text-xs text-muted-foreground">
                {ring === "feature_off" ? t("push.ringFeatureOff") : t("push.ringLineOff")}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving} className={`${field} flex-1 sm:flex-none`}>
              {t("profile.save")}
            </Button>
            {last4 ? (
              <Button
                type="button"
                variant="destructive"
                onClick={remove}
                disabled={removing}
                className={field}
              >
                {t("push.mobileRemove")}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
