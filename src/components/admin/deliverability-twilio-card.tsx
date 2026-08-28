"use client";

import { Loader2, RotateCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { DELIVERABILITY_LOOK, LookGlyph, LookIcon, VERDICT_LOOK } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Finding, Probe, TwilioProbes } from "@/lib/deliverability/types";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { api, ApiError } from "./api";
import { DeliverabilityFindings } from "./deliverability-findings";

/**
 * Ce que Twilio dit — la seule moitié de l'écran de délivrabilité qui sort du
 * bâtiment.
 *
 * ÎLOT CLIENT, et c'est le point : les neuf autres dixièmes de la page sont
 * calculés depuis la base au rendu serveur, donc instantanés. Une clé Twilio
 * absente, lente ou à portée restreinte ne doit ni retarder ni vider ce qui est
 * déjà su. Elle attend ici, seule, avec son propre bouton « Réessayer ».
 *
 * Les CINQ lectures d'une sonde se rendent en cinq choses visiblement
 * différentes, parce qu'elles appellent cinq gestes différents :
 *  · répondu — la donnée, en pleine encre ;
 *  · non configuré — il manque une variable, et on la NOMME (gris, on peut la poser) ;
 *  · portée insuffisante — une clé « restreinte » sans Monitor ni TrustHub
 *    échoue exactement comme une panne : c'est le piège le plus coûteux de
 *    cette carte, donc il est nommé plutôt que grisé (ambre) ;
 *  · injoignable — Twilio n'a pas répondu (rouge) ;
 *  · absent — Twilio a répondu « ça n'existe pas ». Pour la campagne A2P d'un
 *    envoi Canada→Canada, c'est la situation NORMALE : ni pictogramme d'alerte,
 *    ni couleur, juste la phrase. La peindre comme une panne apprendrait à
 *    ignorer la panne.
 */

/**
 * Chaque sonde s'arrête d'elle-même au bout de dix secondes côté serveur, et
 * les cinq partent en parallèle. Passé la demi-minute, ce n'est plus Twilio qui
 * est lent : c'est la route qui ne répondra pas. Un bouton « Réessayer » vaut
 * mieux qu'un rouet qui tourne indéfiniment.
 */
const PROBE_TIMEOUT_MS = 30_000;

/** Les deux moitiés arrivent ensemble : les constats commentent CES sondes-là. */
type TwilioPayload = { probes: TwilioProbes; findings: Finding[] };

/**
 * Un réglage à deux positions.
 *
 * Le MOT porte l'état ; la couleur ne fait que le répéter. L'encodage
 * intelligent éteint est la correction la moins chère de toute la page pour un
 * expéditeur francophone — un seul accent fait basculer le message en UCS-2,
 * soit 70 caractères par segment au lieu de 160 — et il ne doit pas se noyer
 * dans une ligne grise uniforme.
 */
function OnOff({ label, on }: { label: string; on: boolean }): ReactElement {
  const t = useTranslations("admin");
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-medium",
          on ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
        )}
      >
        {t(on ? "deliverability.twilio.on" : "deliverability.twilio.off")}
      </span>
    </span>
  );
}

/**
 * Une ligne de sonde : son libellé, et son état rendu selon les cinq lectures.
 *
 * `children` est une fonction plutôt qu'un nœud : la donnée n'existe QUE dans
 * l'état « répondu », et la faire passer par une prop optionnelle obligerait
 * chaque appelant à ré-inventer le même `if` — c'est-à-dire à ré-inventer, à
 * cinq endroits, la nuance entre « pas configuré » et « injoignable ».
 *
 * En dessous de `md`, le libellé se met AU-DESSUS de la valeur : sur 360 px,
 * deux colonnes rognent la valeur, et c'est la valeur qu'on est venu lire.
 */
function ProbeRow<T>({
  label,
  probe,
  children,
}: {
  label: string;
  probe: Probe<T>;
  children: (data: T) => ReactElement;
}): ReactElement {
  const t = useTranslations("admin");

  let body: ReactElement;
  if (probe.state === "ok") {
    body = children(probe.data);
  } else if (probe.state === "absent") {
    // Aucun pictogramme, aucune teinte : la phrase dit elle-même que c'est
    // normal. Le seul cas réellement attendu est la campagne A2P d'un envoi
    // canadien — ailleurs, un 404 reste rare, mais le mensonge serait de le
    // peindre en rouge.
    body = <p className="text-muted-foreground">{t("deliverability.twilio.absent")}</p>;
  } else if (probe.state === "unconfigured") {
    body = (
      <div className="space-y-0.5">
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <LookGlyph look={VERDICT_LOOK.unknown} className="size-3.5" />
          {t("deliverability.twilio.unconfigured")}
        </p>
        {/* Les noms de variables sont copiés tels quels dans Vercel : en
            chasse fixe, et coupés en bout de mot plutôt qu'en dehors de la
            carte. */}
        <p className="font-mono text-xs break-words text-muted-foreground">
          {t("deliverability.twilio.unconfiguredHint", { vars: probe.missing.join(", ") })}
        </p>
      </div>
    );
  } else {
    const scope = probe.reason === "scope";
    body = (
      <p
        className={cn(
          "flex items-start gap-1.5",
          scope ? "text-amber-600 dark:text-amber-400" : "text-destructive",
        )}
      >
        <LookGlyph look={scope ? VERDICT_LOOK.warn : VERDICT_LOOK.danger} className="mt-0.5 size-3.5" />
        <span className="min-w-0 break-words">
          {t(
            scope
              ? "deliverability.twilio.scopeMissing"
              : "deliverability.twilio.unavailable",
          )}
          {/* Le statut HTTP est une pièce à conviction, pas une phrase : il
              part tel quel dans un billet de support Twilio. */}
          {probe.status === undefined ? null : (
            <span className="ml-1.5 font-mono text-xs tabular-nums">{probe.status}</span>
          )}
        </span>
      </p>
    );
  }

  return (
    <div className="grid gap-1 px-4 py-3 md:grid-cols-[12rem_1fr] md:items-start md:gap-4">
      <p className="text-sm font-medium">{label}</p>
      <div className="min-w-0 text-sm">{body}</div>
    </div>
  );
}

export function DeliverabilityTwilioCard(): ReactElement {
  const t = useTranslations("admin");
  const locale = useLocale();
  const nf = useMemo(
    () => new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA"),
    [locale],
  );

  const [payload, setPayload] = useState<TwilioPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /**
   * Le code de la route, pas une phrase traduite : il n'y a rien à comprendre
   * pour le courtier, mais tout à recopier dans un billet de support. Une
   * panne réseau n'en a pas — on n'en invente pas.
   */
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setErrorCode(null);
    try {
      setPayload(
        await api<TwilioPayload>("/api/admin/deliverability/twilio", {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }),
      );
    } catch (err) {
      // On JETTE la réponse précédente : sur un écran de conformité, des
      // sondes d'il y a cinq minutes présentées comme actuelles valent moins
      // que rien.
      setPayload(null);
      setFailed(true);
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Un seul tir au montage : la seule autre façon de relancer est le bouton,
  // et il appelle `load` directement.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void load();
  }, [load]);

  const probes = payload?.probes ?? null;
  /**
   * Au moins une sonde a RÉPONDU.
   *
   * Sans clé Twilio, la liste de constats est vide elle aussi — et un « Rien à
   * corriger » posé là-dessus serait exactement le mensonge que cette carte
   * existe pour éviter. Le bloc de constats ne s'affiche donc que si l'on a su
   * quelque chose : soit une sonde a parlé, soit l'évaluation a quand même
   * trouvé à redire (une clé à portée restreinte se constate sans qu'aucune
   * sonde n'aboutisse).
   */
  const answered =
    probes !== null &&
    [probes.account, probes.service, probes.senderPool, probes.a2p, probes.alerts].some(
      (p) => p.state === "ok",
    );
  const showFindings = payload !== null && (payload.findings.length > 0 || answered);

  return (
    <div className="space-y-4">
      <Card className="shadow-xs">
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <LookIcon look={DELIVERABILITY_LOOK.engine} size="lg" />
            <div className="min-w-0 space-y-0.5">
              <CardTitle>{t("deliverability.twilio.title")}</CardTitle>
              <CardDescription>{t("deliverability.twilio.subtitle")}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              {t("deliverability.states.loading")}
            </p>
          ) : null}

          {failed ? (
            <div className="space-y-2 px-4 py-3">
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-destructive">
                <LookGlyph look={VERDICT_LOOK.danger} className="size-3.5" />
                {t("deliverability.states.unavailable")}
                {errorCode === null ? null : (
                  <span className="font-mono text-xs">{errorCode}</span>
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() => void load()}
              >
                <RotateCw aria-hidden className="size-4" />
                {t("deliverability.twilio.retry")}
              </Button>
            </div>
          ) : null}

          {/* `divide-y` plutôt qu'un liseré par ligne : l'en-tête porte déjà le
              sien, et deux traits collés font un trait épais qu'on prend pour
              une séparation de section. */}
          {probes === null ? null : (
            <div className="divide-y">
              <ProbeRow label={t("deliverability.twilio.account")} probe={probes.account}>
                {(d) => (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words">{d.friendlyName || "—"}</span>
                    {/* Le statut du compte reste en puce NEUTRE : c'est le
                        constat « compte suspendu », calculé côté serveur, qui
                        décide de l'alarme. Deux endroits qui jugent le même
                        champ finissent toujours par se contredire. */}
                    <Badge variant="secondary" className="font-mono">
                      {d.status}
                    </Badge>
                  </div>
                )}
              </ProbeRow>

              <ProbeRow label={t("deliverability.twilio.service")} probe={probes.service}>
                {(d) => (
                  <div className="space-y-1">
                    <p className="break-words">{d.friendlyName || d.sid}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <OnOff
                        label={t("deliverability.twilio.smartEncoding")}
                        on={d.smartEncoding}
                      />
                      {/* Une URL de rappel absente, c'est l'angle mort du
                          25 août : les envois partent, aucun accusé ne revient,
                          et la file reste « En file » pour toujours. */}
                      <OnOff
                        label={t("deliverability.twilio.statusCallback")}
                        on={d.statusCallback !== null}
                      />
                      <OnOff
                        label={t("deliverability.twilio.stickySender")}
                        on={d.stickySender}
                      />
                    </div>
                  </div>
                )}
              </ProbeRow>

              <ProbeRow label={t("deliverability.twilio.senderPool")} probe={probes.senderPool}>
                {(d) => (
                  <div className="space-y-1">
                    <p className="tabular-nums">
                      {t("deliverability.twilio.poolNumbers", {
                        count: nf.format(d.numbers.length),
                      })}
                    </p>
                    {/* Les numéros eux-mêmes, en clair : c'est en les comparant à
                        ceux du CRM qu'on voit l'orphelin — celui qui envoie sans
                        être attaché au service, donc sans campagne ni marque. */}
                    {d.numbers.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {d.numbers.map((n) => (
                          <span
                            key={n}
                            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums"
                          >
                            {formatPhone(n)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </ProbeRow>

              <ProbeRow label={t("deliverability.twilio.a2p")} probe={probes.a2p}>
                {(d) => (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="font-mono">
                        {d.campaignStatus}
                      </Badge>
                      {d.usAppToPersonUsecase ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {d.usAppToPersonUsecase}
                        </span>
                      ) : null}
                    </div>
                    {d.errors.length > 0 ? (
                      <ul className="space-y-0.5 text-xs">
                        {d.errors.map((e, i) => (
                          <li
                            key={`${e.code ?? "?"}-${i}`}
                            className="flex flex-wrap items-baseline gap-x-2"
                          >
                            <span className="font-mono tabular-nums">
                              {e.code === null ? "—" : e.code}
                            </span>
                            <span className="min-w-0 break-words text-muted-foreground">
                              {e.description}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
              </ProbeRow>

              <ProbeRow label={t("deliverability.twilio.alerts")} probe={probes.alerts}>
                {(d) =>
                  d.errors.length === 0 ? (
                    <p className="text-muted-foreground">
                      {t("deliverability.twilio.alertsNone")}
                    </p>
                  ) : (
                    // Tous les codes, jamais un extrait : en couper la queue
                    // ferait disparaître sans le dire le code rare qui explique
                    // justement la panne du jour.
                    <ul className="space-y-0.5 md:max-w-xs">
                      {d.errors.map((e) => (
                        <li key={e.code} className="flex items-baseline justify-between gap-3">
                          <span className="font-mono text-xs tabular-nums">{e.code}</span>
                          <span className="tabular-nums">{nf.format(e.count)}</span>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </ProbeRow>
            </div>
          )}

        </CardContent>
      </Card>

      {/* Les constats issus de CES sondes, rendus par le même composant que ceux
          de la base : deux listes de tâches dessinées différemment sur le même
          écran se liraient comme deux niveaux d'urgence, ce qu'elles ne sont pas.
          `moreCount` vaut zéro — la route ne plafonne rien, elle en rend cinq au
          maximum et il n'y a donc jamais de reste à compter. */}
      {showFindings && payload !== null ? (
        <DeliverabilityFindings findings={payload.findings} moreCount={0} />
      ) : null}
    </div>
  );
}
