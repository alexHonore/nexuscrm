"use client";

import { Check, Loader2, MessageSquareText, RefreshCw, ShoppingCart, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { errorMessage } from "./errors";
import type { AdminUserDto } from "./types";

/**
 * Achat d'un nouveau numéro voip.ms SANS passer par le portail : province →
 * ville → numéro → confirmation. Le montant est débité du solde prépayé du
 * compte voip.ms principal ; le numéro est routé et attribué au téléphoniste
 * dans la foulée (sa ligne SIP est créée au besoin).
 */

/**
 * Doit DÉPASSER le pire cas du serveur (quatre appels voip.ms bornés à 45 s) :
 * si le navigateur abandonnait avant, le bouton redeviendrait cliquable alors
 * que la commande est encore en vol chez voip.ms — et un admin impatient
 * paierait le numéro deux fois.
 */
const ORDER_TIMEOUT_MS = 210_000;

type BillingType = "perminute" | "flat";

type MarketPrices = { monthly: number | null; setup: number | null; minute: number | null };

type MarketDid = {
  did: string;
  e164: string | null;
  ratecenter: string;
  sms: boolean;
  prices: { perminute: MarketPrices; flat: MarketPrices };
};

type Province = { province: string; description?: string };

export type OrderDidResult = {
  ok: boolean;
  did: string;
  account: string;
  alreadyOwned: boolean;
  calleridUpdated: boolean;
  released: { id: string; name: string; email: string }[];
  provision: { account: string; password: string; created: boolean; derived: boolean } | null;
  user: AdminUserDto;
};

export function OrderDidDialog({
  user,
  open,
  onOpenChange,
  onOrdered,
}: {
  user: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOrdered: (res: OrderDidResult) => void;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();

  const [market, setMarket] = useState<{ provinces: Province[]; balance: number | null } | null>(null);
  const [province, setProvince] = useState("");
  const [ratecenters, setRatecenters] = useState<string[] | null>(null);
  const [ratecenter, setRatecenter] = useState("");
  const [dids, setDids] = useState<MarketDid[] | null>(null);
  const [selected, setSelected] = useState<MarketDid | null>(null);
  const [billingType, setBillingType] = useState<BillingType>("perminute");
  const [loading, setLoading] = useState<"ratecenters" | "dids" | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Échec du premier chargement : la vitrine doit le DIRE et offrir un réessai. */
  const [marketError, setMarketError] = useState<string | null>(null);

  const numberFmt = new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  /** Tarif à la minute : jusqu'à 4 décimales (« 0,009 »). */
  const rateFmt = new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const money = (n: number | null) => (n === null ? "—" : numberFmt.format(n));
  const rate = (n: number | null) => (n === null ? "—" : rateFmt.format(n));

  const failVoip = (err: unknown) =>
    toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });

  const loadRatecenters = async (prov: string) => {
    setRatecenters(null);
    setRatecenter("");
    setDids(null);
    setSelected(null);
    setLoading("ratecenters");
    try {
      const res = await api<{ ratecenters: { ratecenter: string }[] }>(
        `/api/admin/voipms/available-dids?province=${encodeURIComponent(prov)}`,
      );
      setRatecenters(res.ratecenters.map((r) => r.ratecenter));
    } catch (err) {
      failVoip(err);
    } finally {
      setLoading(null);
    }
  };

  const loadDids = async (prov: string, rc: string) => {
    setDids(null);
    setSelected(null);
    setLoading("dids");
    try {
      const res = await api<{ dids: MarketDid[] }>(
        `/api/admin/voipms/available-dids?province=${encodeURIComponent(prov)}&ratecenter=${encodeURIComponent(rc)}`,
      );
      setDids(res.dids);
    } catch (err) {
      failVoip(err);
    } finally {
      setLoading(null);
    }
  };

  /**
   * Premier chargement : provinces + solde, Québec présélectionné.
   *
   * Aucun indicateur de chargement n'est posé ici : « en cours » se DÉDUIT de
   * l'absence de vitrine et d'erreur (voir `marketLoading`). Un drapeau posé à
   * la main restait bloqué quand la fenêtre était fermée en cours de route, et
   * la garde de réentrée empêchait alors tout nouveau chargement.
   */
  const loadMarket = async () => {
    try {
      const res = await api<{ provinces: Province[]; balance: number | null }>(
        "/api/admin/voipms/available-dids",
      );
      setMarket(res);
      const preferred = res.provinces.some((p) => p.province === "QC")
        ? "QC"
        : (res.provinces[0]?.province ?? "");
      setProvince(preferred);
      if (preferred) await loadRatecenters(preferred);
    } catch (err) {
      setMarketError(errorMessage(t, err));
      failVoip(err);
    }
  };

  // Une seule requête en vol : un `ref` suffit et n'entraîne aucun rendu.
  const marketFetching = useRef(false);
  useEffect(() => {
    if (!open || market || marketError || marketFetching.current) return;
    marketFetching.current = true;
    void loadMarket().finally(() => {
      marketFetching.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- déclenché par l'ouverture seulement
  }, [open, market, marketError]);

  const retryMarket = () => {
    setMarketError(null);
    marketFetching.current = true;
    void loadMarket().finally(() => {
      marketFetching.current = false;
    });
  };

  /** « en cours » dérivé : ouvert, rien à montrer, rien à corriger. */
  const marketLoading = open && !market && !marketError;

  const submit = async () => {
    if (!selected) return;
    setOrdering(true);
    try {
      const res = await api<OrderDidResult>("/api/admin/voipms/order-did", {
        method: "POST",
        body: JSON.stringify({ userId: user.id, did: selected.did, billingType }),
        signal: AbortSignal.timeout(ORDER_TIMEOUT_MS),
      });
      toast.success(t("users.voip.order.ordered", { number: formatPhone(res.did) }));
      onOrdered(res);
      setConfirmOpen(false);
      onOpenChange(false);
      // Vitrine ET solde périmés : le numéro vient d'être vendu et débité.
      setMarket(null);
      setDids(null);
      setSelected(null);
      setRatecenter("");
    } catch (err) {
      failVoip(err);
    } finally {
      setOrdering(false);
    }
  };

  /** Fermeture propre : la confirmation ne doit JAMAIS survivre à une annulation. */
  const close = () => {
    setConfirmOpen(false);
    onOpenChange(false);
  };

  const selectedPrices = selected ? selected.prices[billingType] : null;
  const selectedNumber = selected ? formatPhone(selected.e164 ?? `+1${selected.did}`) : "";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("users.voip.order.title")}</DialogTitle>
          <DialogDescription>{t("users.voip.order.desc", { name: user.name })}</DialogDescription>
        </DialogHeader>

        {marketLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </p>
        ) : null}

        {/* Un échec du premier chargement doit rester lisible après le toast. */}
        {marketError && !market ? (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {marketError}
            </p>
            <p className="text-xs text-muted-foreground">{t("users.voip.ipHint")}</p>
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={retryMarket}
            >
              <RefreshCw className="size-4" />
              {t("users.provision.retry")}
            </Button>
          </div>
        ) : null}

        {market ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("users.voip.order.province")}</Label>
                <Select
                  items={market.provinces.map((p) => ({
                    value: p.province,
                    label: p.description || p.province,
                  }))}
                  value={province}
                  onValueChange={(v) => {
                    const prov = String(v);
                    setProvince(prov);
                    void loadRatecenters(prov);
                  }}
                  disabled={loading !== null || ordering}
                >
                  <SelectTrigger className="min-h-11 w-full md:min-h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {market.provinces.map((p) => (
                      <SelectItem key={p.province} value={p.province}>
                        {p.description || p.province}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("users.voip.order.ratecenter")}</Label>
                <Select
                  items={(ratecenters ?? []).map((rc) => ({ value: rc, label: rc }))}
                  // null (et non "") : c'est ce qui déclenche l'affichage du placeholder.
                  value={ratecenter || null}
                  onValueChange={(v) => {
                    const rc = String(v);
                    setRatecenter(rc);
                    void loadDids(province, rc);
                  }}
                  disabled={loading !== null || ordering || !ratecenters?.length}
                >
                  <SelectTrigger className="min-h-11 w-full md:min-h-8">
                    <SelectValue
                      placeholder={
                        loading === "ratecenters" ? t("loading") : t("users.voip.order.ratecenterPlaceholder")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(ratecenters ?? []).map((rc) => (
                      <SelectItem key={rc} value={rc}>
                        {rc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t("users.voip.order.billingTitle")}</Label>
              <RadioGroup
                value={billingType}
                onValueChange={(v) => setBillingType(v as BillingType)}
                className="gap-2"
              >
                <label className="flex min-h-11 items-start gap-2 text-sm md:min-h-0">
                  <RadioGroupItem value="perminute" className="mt-0.5" disabled={ordering} />
                  <span>
                    <span className="font-medium">{t("users.voip.order.perminute")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("users.voip.order.perminuteHint")}
                    </span>
                  </span>
                </label>
                <label className="flex min-h-11 items-start gap-2 text-sm md:min-h-0">
                  <RadioGroupItem value="flat" className="mt-0.5" disabled={ordering} />
                  <span>
                    <span className="font-medium">{t("users.voip.order.flat")}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("users.voip.order.flatHint")}
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {loading === "dids" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("loading")}
              </p>
            ) : null}

            {dids !== null && loading !== "dids" ? (
              <div className="space-y-1.5">
                <Label>{t("users.voip.order.numbers")}</Label>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                  {dids.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">{t("users.voip.order.noNumbers")}</p>
                  ) : (
                    dids.map((d) => {
                      const prices = d.prices[billingType];
                      const isSelected = selected?.did === d.did;
                      return (
                        <button
                          key={d.did}
                          type="button"
                          className={cn(
                            "flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                            isSelected && "bg-muted",
                          )}
                          onClick={() => setSelected(d)}
                          disabled={ordering}
                        >
                          <span className="flex w-full items-center gap-1.5">
                            {isSelected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                            <span className="font-mono text-sm font-medium">
                              {formatPhone(d.e164 ?? `+1${d.did}`)}
                            </span>
                            {d.sms ? (
                              <span className="flex items-center gap-0.5 rounded bg-muted px-1 py-px text-[0.65rem] text-muted-foreground">
                                <MessageSquareText className="size-3" />
                                SMS
                              </span>
                            ) : null}
                          </span>
                          <span className="flex w-full flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span>{t("users.voip.order.monthly", { price: money(prices.monthly) })}</span>
                            {billingType === "perminute" ? (
                              <span>{t("users.voip.order.perMinuteRate", { price: rate(prices.minute) })}</span>
                            ) : null}
                            {prices.setup ? (
                              <span>{t("users.voip.order.setupFee", { price: money(prices.setup) })}</span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}

            {market.balance !== null ? (
              <p className="text-xs text-muted-foreground">
                {t("users.voip.order.balance", { balance: money(market.balance) })}
              </p>
            ) : null}

          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={close}
            disabled={ordering}
            className="min-h-11 md:min-h-8"
          >
            {t("cancel")}
          </Button>
          {/*
            La confirmation vit dans une fenêtre SÉPARÉE (et non à la place du
            bouton de commande) : un double-clic ne peut plus traverser l'étape
            de confirmation et déclencher un achat que l'admin n'a pas relu.
          */}
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger
              render={<Button className="min-h-11 md:min-h-8" />}
              disabled={!selected || ordering}
            >
              <ShoppingCart className="size-4" />
              {selected
                ? t("users.voip.order.submit", { number: selectedNumber })
                : t("users.voip.order.submitEmpty")}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("users.voip.order.confirmSubmit")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("users.voip.order.confirmHint", {
                    number: selectedNumber,
                    price: money(selectedPrices?.monthly ?? null),
                    name: user.name,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={ordering}>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    // La fenêtre ne se ferme qu'une fois l'achat abouti : on
                    // garde l'indicateur de progression sous les yeux.
                    e.preventDefault();
                    void submit();
                  }}
                  disabled={ordering}
                >
                  {ordering ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ShoppingCart className="size-4" />
                  )}
                  {ordering ? t("users.voip.order.ordering") : t("users.voip.order.confirmSubmit")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
