"use client";

import { BellOff, Download, EllipsisVertical, Share, SquarePlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * La marche à suivre pour poser Nexus sur l'écran d'accueil.
 *
 * Ce n'est pas un encart promotionnel : sur iPhone, c'est la CONDITION
 * d'existence des notifications. WebKit n'expose l'API Push qu'à une page
 * lancée depuis l'écran d'accueil ; dans Safari, `window.Notification`
 * n'existe tout simplement pas. Un téléphoniste qui reste dans l'onglet n'a
 * donc pas « des notifications mal réglées » — il n'en aura JAMAIS, et rien à
 * l'écran ne le lui dit. D'où l'avertissement en toutes lettres, avant les
 * étapes : c'est la phrase la plus importante de tout ce chantier.
 *
 * Deux chemins, parce que les deux plateformes n'offrent pas le même geste :
 *
 * · **iOS** — aucun événement, aucune API, aucun bouton possible. Il n'y a que
 *   la manipulation manuelle, qu'il faut donc décrire avec les mots et les
 *   pictogrammes EXACTS que le téléphone affiche, sans quoi on cherche
 *   « Installer » dans un menu qui dit « Sur l'écran d'accueil ».
 * · **Android / Chrome** — `beforeinstallprompt` permet un vrai bouton. Il
 *   n'est pas garanti : il ne se déclenche qu'aux yeux du navigateur (critères
 *   d'engagement, application déjà installée, navigateur tiers). Le repli n'est
 *   donc pas un cas limite, c'est le cas ordinaire à prévoir — d'où les
 *   instructions de menu tant que l'événement n'est pas arrivé.
 *
 * La plateforme se lit à l'EXÉCUTION et jamais au rendu. Le serveur ne sait pas
 * quel téléphone lit la page, et trancher pendant le rendu produirait une
 * discordance d'hydratation — c'est-à-dire, sur cet écran-là, un guide iPhone
 * affiché une seconde à un utilisateur Android. D'où `useSyncExternalStore`, le
 * patron déjà employé par `saved-views.tsx` et `client-card.tsx` : le serveur
 * répond « je ne sais pas » et rien n'est dessiné tant que le navigateur n'a
 * pas répondu à sa place.
 *
 * Enfin, le panneau se POSITIONNE lui-même. La coquille le monte comme dernier
 * enfant de son `flex min-h-dvh`, hors de la mise en page : rendu dans le flux,
 * il deviendrait une troisième colonne coincée entre le bandeau latéral et le
 * contenu, sur chaque écran. Il est donc fixé, au-dessus de la barre de
 * navigation basse ET du bouton du webphone (mêmes décalages que
 * `webphone-dock.tsx`), et sous eux dans l'ordre d'empilement — un guide
 * d'installation ne doit jamais recouvrir un appel en cours.
 */

/** L'événement de Chrome — absent des types du DOM, propriétaire et facultatif. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Platform = "ios" | "generic";

const emptySubscribe = () => () => {};

/**
 * Deux mémoires de module, et un seul magasin pour les deux.
 *
 * `installedByEvent` : Android annonce l'installation par un événement, mais
 * l'onglet où l'on se trouve, lui, n'entre PAS en mode autonome — la requête
 * média continue de répondre « non » alors que l'icône est posée. Sans cette
 * mémoire, le guide resterait affiché sous les yeux de quelqu'un qui vient de
 * le suivre.
 *
 * `dismissed` : écarté pour cette session-ci. Volontairement en mémoire vive et
 * non dans `localStorage` — le problème, lui, n'est pas réglé : sans
 * installation, ce téléphone ne recevra jamais rien. Un « plus tard » définitif
 * enterrerait pour de bon le seul écran qui le dit. Il revient donc au prochain
 * démarrage, et disparaît le jour où l'application est installée.
 */
let installedByEvent = false;
let dismissed = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/** Déjà posée sur l'écran d'accueil ? Les trois aveux possibles. */
function detectInstalled(): boolean {
  if (installedByEvent) return true;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // Une requête média inconnue ne doit pas décider seule.
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * Un ordinateur de bureau n'a rien à installer POUR ÊTRE PRÉVENU.
 *
 * C'est toute la différence avec un iPhone : Chrome, Edge et Safari de bureau
 * accordent les notifications à un onglet ordinaire, alors qu'iOS ne les
 * accorde qu'à une application posée sur l'écran d'accueil. Inviter un
 * courtier assis devant son écran à « installer Nexus sur ce téléphone » lui
 * demanderait donc un geste inutile, avec le mauvais mot — et chaque invitation
 * qu'on peut ignorer sans conséquence apprend à ignorer les suivantes.
 *
 * Le critère est le POINTEUR et non la largeur de la fenêtre : une fenêtre
 * étroite sur un portable reste un portable, et une tablette tactile en
 * paysage reste un appareil à installer.
 */
function isHandheld(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    // Sans requête média exploitable, on préfère proposer : le geste est
    // dismissible, l'absence de notifications ne l'est pas.
    return true;
  }
}

/** Faut-il se taire ? De bureau, déjà installée, ou écartée pour cette session. */
function readHidden(): boolean {
  return dismissed || !isHandheld() || detectInstalled();
}

/** Le mode d'affichage change (installation, ouverture depuis l'icône). */
function subscribeHidden(onChange: () => void): () => void {
  listeners.add(onChange);
  const onInstalled = () => {
    installedByEvent = true;
    notifyListeners();
  };
  let media: MediaQueryList | null = null;
  try {
    media = window.matchMedia("(display-mode: standalone)");
    media.addEventListener("change", onChange);
  } catch {
    media = null;
  }
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    listeners.delete(onChange);
    media?.removeEventListener("change", onChange);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

/**
 * iPhone ou iPad — la seule distinction qui change le mode d'emploi.
 *
 * L'iPad se déclare « Macintosh » depuis iPadOS 13 : sans la seconde
 * condition, une tablette recevrait le guide Android et son propriétaire
 * chercherait un menu à trois points qui n'existe pas.
 */
function detectPlatform(): Platform {
  const ua = navigator.userAgent || "";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  return "generic";
}

/** Une étape numérotée. Le numéro est décoratif : c'est `<ol>` qui porte l'ordre. */
function Step({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
      >
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">{children}</div>
    </li>
  );
}

/**
 * Ce qu'il faut CHERCHER sur le téléphone : le pictogramme du système, doublé
 * du libellé exact. L'icône est `aria-hidden` — elle illustre le mot, elle ne
 * le remplace pas (règle 11).
 */
function Target({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs font-medium [&_svg]:size-3.5">
      {icon}
      {label}
    </span>
  );
}

export function InstallGuide({ className }: { className?: string }) {
  const t = useTranslations("common");
  // `null` tant que le navigateur n'a pas parlé : le serveur ne devine pas, et
  // rien ne s'affiche avant qu'on sache à qui l'on s'adresse.
  const platform = useSyncExternalStore<Platform | null>(
    emptySubscribe,
    detectPlatform,
    () => null,
  );
  // Le serveur répond « caché » : rien ne clignote entre le rendu et
  // l'hydratation, et le panneau n'apparaît que si le navigateur le réclame.
  const hidden = useSyncExternalStore(subscribeHidden, readHidden, () => true);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  /** L'invitation a été proposée puis consommée : Chrome ne la redonnera pas ici. */
  const [promptSpent, setPromptSpent] = useState(false);
  /**
   * Replié par défaut.
   *
   * Le mode d'emploi complet occupe près de la moitié d'un écran de téléphone,
   * et il s'affiche sur CHAQUE page tant que l'application n'est pas installée.
   * Déplié d'office, il recouvrait le formulaire qu'on était venu remplir — et
   * un panneau qui gêne se fait congédier d'un réflexe, sans être lu. Or c'est
   * le seul geste sans lequel rien du reste ne fonctionne sur iPhone : mieux
   * vaut une ligne qui survit qu'une page qu'on chasse.
   */
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Chrome émet son événement peu après le chargement — souvent AVANT que
    // React ait monté quoi que ce soit. On ne peut pas rattraper ce qui est
    // déjà passé (le gabarit racine est gelé, aucun script ne l'attend plus
    // tôt) : le guide affiche donc le mode d'emploi manuel, et le remplace par
    // un vrai bouton si l'événement finit par arriver.
    const onBeforeInstallPrompt = (event: Event) => {
      // Sans ce refus, Chrome affiche sa propre bannière : deux invitations à
      // installer, dont une qu'on ne contrôle pas et qui peut recouvrir la
      // barre de navigation basse.
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
      setPromptSpent(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  if (!platform || hidden) return null;

  const dismiss = () => {
    dismissed = true;
    notifyListeners();
  };

  const install = async () => {
    if (!installPrompt) return;
    // L'invitation ne sert qu'UNE fois : qu'elle soit acceptée ou refusée, on
    // la jette et l'on repasse au mode d'emploi manuel — un bouton qui ne fait
    // plus rien est pire que pas de bouton du tout.
    setInstallPrompt(null);
    setPromptSpent(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      // Refusée par le navigateur (déjà consommée, fenêtre perdue) : les
      // instructions de menu restent affichées juste en dessous.
    }
  };

  return (
    <div
      className={cn(
        // Sur téléphone : au-dessus de la barre de navigation basse (3,5 rem +
        // encoche) ET du bouton du webphone qui la surmonte (mêmes valeurs que
        // `ABOVE_NAV` dans webphone-dock.tsx). Sur écran large : à gauche, hors
        // du bandeau latéral (15 rem) et loin du bouton d'appel, posté à droite.
        "fixed inset-x-2 bottom-[calc(8.5rem+env(safe-area-inset-bottom))] z-30",
        "md:inset-x-auto md:bottom-6 md:left-64 md:w-96",
        className,
      )}
    >
      <Card className="shadow-xl">
        <CardHeader>
          <CardTitle>{t("install.title")}</CardTitle>
          {open ? <CardDescription>{t("install.why")}</CardDescription> : null}
          <CardAction>
            {/* Cible tactile pleine sur téléphone : ce bouton voisine le pouce
                qui vient de toucher « Installer ». */}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 md:size-8"
              aria-label={t("install.later")}
              onClick={dismiss}
            >
              <X aria-hidden />
            </Button>
          </CardAction>
        </CardHeader>

        {!open ? (
          <CardContent>
            <Button
              variant="outline"
              className="min-h-11 w-full"
              onClick={() => setOpen(true)}
              aria-expanded={false}
            >
              {t("install.how")}
            </Button>
          </CardContent>
        ) : null}

        <CardContent className={cn("max-h-[60vh] space-y-4 overflow-y-auto", !open && "hidden")}>
          {platform === "ios" ? (
            <>
              {/*
                Le ton le plus fort dont dispose la charte, et il est mérité :
                ce n'est pas « certaines notifications pourraient manquer », c'est
                « il n'y en aura aucune ». Le pictogramme double le titre, la
                couleur ne porte rien toute seule.
              */}
              <Alert variant="destructive">
                <BellOff aria-hidden />
                <AlertTitle>{t("install.iosNoPushTitle")}</AlertTitle>
                <AlertDescription>{t("install.iosNoPush")}</AlertDescription>
              </Alert>

              <ol className="space-y-3 text-sm">
                <Step index={1}>
                  <p>{t("install.iosStep1")}</p>
                  <Target icon={<Share aria-hidden />} label={t("install.iosShare")} />
                </Step>
                <Step index={2}>
                  <p>{t("install.iosStep2")}</p>
                  <Target icon={<SquarePlus aria-hidden />} label={t("install.iosAdd")} />
                </Step>
                <Step index={3}>
                  <p>{t("install.iosStep3")}</p>
                </Step>
              </ol>

              <p className="text-xs text-muted-foreground">{t("install.iosSafari")}</p>
            </>
          ) : (
            <>
              {installPrompt ? (
                <div className="space-y-2">
                  <Button
                    type="button"
                    size="lg"
                    className="min-h-11 w-full sm:w-auto"
                    onClick={install}
                  >
                    <Download aria-hidden />
                    {t("install.button")}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t("install.buttonHint")}</p>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {promptSpent ? t("install.declined") : t("install.noPrompt")}
                  </p>
                  <ol className="space-y-3 text-sm">
                    <Step index={1}>
                      <p>{t("install.menuStep1")}</p>
                      <Target
                        icon={<EllipsisVertical aria-hidden />}
                        label={t("install.menuLabel")}
                      />
                    </Step>
                    <Step index={2}>
                      <p>{t("install.menuStep2")}</p>
                    </Step>
                  </ol>
                </>
              )}
              <p className="text-xs text-muted-foreground">{t("install.androidThen")}</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
