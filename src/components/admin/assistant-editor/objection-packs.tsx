"use client";

import { ChevronDownIcon, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EDITOR_TAB_LOOK, LookIcon } from "@/components/look";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../api";
import type { AssistantEditorData } from "./types";

type Pack = AssistantEditorData["packs"][number];
type Item = Pack["items"][number];

const LOOK = EDITOR_TAB_LOOK.objections;

/** Une objection vierge — les quatre temps de la réponse, dans l'ordre. */
const emptyItem = (index: number): Item => ({
  key: `objection_${index + 1}`,
  triggerHint: "",
  acknowledge: "",
  reframe: "",
  ask: "",
});

/**
 * Les paquets d'objections — cochés, ouverts, corrigés, complétés.
 *
 * L'onglet n'offrait que des cases : on choisissait entre deux paquets écrits
 * par quelqu'un d'autre, sans pouvoir en lire une ligne. Or une objection est
 * ce qu'un courtier entend tous les jours et reformule sans arrêt — la matière
 * la plus vivante de la configuration, et la seule qu'on ne pouvait pas
 * toucher.
 *
 * Deux gestes distincts vivent ici, et l'écran les sépare : COCHER décide de
 * ce que CET assistant mobilise (c'est sa configuration, enregistrée avec
 * lui) ; ÉDITER change le paquet pour TOUS ceux qui s'en servent (c'est une
 * ressource partagée, enregistrée tout de suite). D'où deux boutons
 * d'enregistrement, et un avertissement quand la modification en touche
 * d'autres.
 */
export function ObjectionPacksEditor({
  packs,
  selected,
  onToggle,
}: {
  packs: Pack[];
  selected: string[];
  onToggle: (id: string, next: boolean) => void;
}) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-3">
      {packs.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("editor.objections.none")}
        </p>
      ) : null}

      {packs.map((pack) => (
        <PackCard
          key={pack.id}
          pack={pack}
          checked={selected.includes(pack.id)}
          open={openId === pack.id}
          onOpen={() => setOpenId(openId === pack.id ? null : pack.id)}
          onToggle={(next) => onToggle(pack.id, next)}
          onSaved={() => router.refresh()}
        />
      ))}

      {creating ? (
        <NewPackForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      ) : (
        <Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => setCreating(true)}>
          <Plus /> {t("editor.objections.newPack")}
        </Button>
      )}
    </div>
  );
}

function PackCard({
  pack,
  checked,
  open,
  onOpen,
  onToggle,
  onSaved,
}: {
  pack: Pack;
  checked: boolean;
  open: boolean;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations("assistants");
  const [label, setLabel] = useState(pack.label);
  const [items, setItems] = useState<Item[]>(pack.items);
  const [busy, setBusy] = useState(false);

  const dirty = label !== pack.label || JSON.stringify(items) !== JSON.stringify(pack.items);

  const save = async () => {
    setBusy(true);
    try {
      // Un paquet partagé : l'enregistrement est IMMÉDIAT et distinct du
      // « Enregistrer » de l'assistant, qui ne concerne que sa configuration.
      const res = await api<{ invalidated: string[] }>(`/api/objection-packs/${pack.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label, items }),
      });
      toast.success(
        res.invalidated.length > 0
          ? t("editor.objections.savedShared", { count: res.invalidated.length })
          : t("editor.objections.saved"),
      );
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("editor.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/objection-packs/${pack.id}`, { method: "DELETE" });
      toast.success(t("editor.objections.deleted"));
      onSaved();
    } catch (err) {
      // Un paquet en service ne disparaît pas sous les pieds d'un assistant :
      // le serveur nomme ceux qui s'en servent.
      const used =
        err instanceof ApiError && Array.isArray(err.data.assistants)
          ? (err.data.assistants as { name: string }[]).map((a) => a.name)
          : [];
      toast.error(
        used.length > 0
          ? t("editor.objections.inUse", { names: used.join(", ") })
          : t("editor.errors.save"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-lg border"
      style={
        checked
          ? {
              borderColor: `color-mix(in srgb, ${LOOK.color} 45%, transparent)`,
              backgroundColor: `color-mix(in srgb, ${LOOK.color} 5%, transparent)`,
            }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-3 p-3">
        {/* Cocher = ce que CET assistant mobilise. Rien à voir avec le contenu. */}
        <Checkbox
          checked={checked}
          aria-label={t("editor.objections.use", { name: pack.label })}
          onCheckedChange={(next) => onToggle(Boolean(next))}
        />
        <LookIcon look={LOOK} size="sm" />
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left md:min-h-8"
          onClick={onOpen}
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{pack.label}</span>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t("editor.objections.itemCount", { count: pack.items.length })}
          </Badge>
          {pack.isBuiltin ? (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {t("editor.objections.builtin")}
            </Badge>
          ) : null}
          <ChevronDownIcon
            aria-hidden
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {open ? (
        <div className="space-y-3 border-t p-3">
          <div className="space-y-1.5">
            <Label htmlFor={`pack-label-${pack.id}`}>{t("editor.objections.packLabel")}</Label>
            <Input
              id={`pack-label-${pack.id}`}
              className="min-h-11 md:min-h-9"
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          {items.map((item, i) => (
            <ItemFields
              key={i}
              item={item}
              index={i}
              onChange={(next) => setItems(items.map((it, j) => (j === i ? next : it)))}
              onRemove={() => setItems(items.filter((_, j) => j !== i))}
            />
          ))}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              onClick={() => setItems([...items, emptyItem(items.length)])}
            >
              <Plus /> {t("editor.objections.addItem")}
            </Button>
            <span className="flex-1" />
            <Button
              variant="ghost"
              className="min-h-11 text-destructive md:min-h-9"
              disabled={busy}
              onClick={remove}
            >
              <Trash2 /> {t("editor.objections.deletePack")}
            </Button>
            <Button className="min-h-11 md:min-h-9" disabled={busy || !dirty} onClick={save}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              {t("editor.objections.savePack")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("editor.objections.sharedHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Une objection : ce qui la déclenche, puis les trois temps de la réponse.
 *
 * Reconnaître, recadrer, redemander — c'est la structure que le prompt rend
 * telle quelle, et la seule raison pour laquelle un paquet vaut mieux qu'un
 * modèle qui improvise. Les quatre champs sont donc séparés, pas un pavé de
 * texte : un paquet dont on ne remplit que « reconnais » produit une réponse
 * qui compatit et ne demande rien.
 */
function ItemFields({
  item,
  index,
  onChange,
  onRemove,
}: {
  item: Item;
  index: number;
  onChange: (next: Item) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("assistants");
  const set = (patch: Partial<Item>) => onChange({ ...item, ...patch });

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden className="font-mono text-xs text-muted-foreground">
          {index + 1}.
        </span>
        <Input
          className="min-h-11 flex-1 font-mono text-xs md:min-h-8"
          value={item.key}
          maxLength={60}
          aria-label={t("editor.objections.itemKey")}
          onChange={(e) => set({ key: e.target.value })}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 text-destructive md:size-8"
          aria-label={t("editor.objections.removeItem", { index: index + 1 })}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      {(
        [
          ["triggerHint", "trigger"],
          ["acknowledge", "acknowledge"],
          ["reframe", "reframe"],
          ["ask", "ask"],
        ] as const
      ).map(([field, key]) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`obj-${index}-${field}`} className="text-xs">
            {t(`editor.objections.${key}`)}
          </Label>
          <Textarea
            id={`obj-${index}-${field}`}
            rows={2}
            maxLength={400}
            placeholder={t(`editor.objections.${key}Placeholder`)}
            value={item[field]}
            onChange={(e) => set({ [field]: e.target.value } as Partial<Item>)}
          />
        </div>
      ))}
    </div>
  );
}

/** Créer un paquet — l'identifiant est écrit UNE fois, il ne se change plus. */
function NewPackForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const t = useTranslations("assistants");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api("/api/objection-packs", {
        method: "POST",
        body: JSON.stringify({ id, label, items: [] }),
      });
      toast.success(t("editor.objections.created"));
      onCreated();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === "id_taken"
          ? t("editor.objections.idTaken")
          : t("editor.errors.save"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-pack-label">{t("editor.objections.packLabel")}</Label>
          <Input
            id="new-pack-label"
            className="min-h-11 md:min-h-9"
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-pack-id">{t("editor.objections.packId")}</Label>
          <Input
            id="new-pack-id"
            className="min-h-11 font-mono text-xs md:min-h-9"
            value={id}
            maxLength={60}
            placeholder="vendeur_fr"
            onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
          />
          {/* Il ne se change plus après coup : c'est lui que les assistants
              référencent, et un fichier d'export le transporte. */}
          <p className="text-xs text-muted-foreground">{t("editor.objections.packIdHint")}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="min-h-11 md:min-h-9" disabled={busy} onClick={onCancel}>
          {t("editor.objections.cancel")}
        </Button>
        <Button
          className="min-h-11 md:min-h-9"
          disabled={busy || id.length < 2 || label.trim() === ""}
          onClick={create}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          {t("editor.objections.createPack")}
        </Button>
      </div>
    </div>
  );
}
