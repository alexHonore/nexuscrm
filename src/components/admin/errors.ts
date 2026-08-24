"use client";

import type { useTranslations } from "next-intl";
import { ApiError } from "./api";

export type Tr = ReturnType<typeof useTranslations>;

/**
 * Message d'erreur lisible pour les écrans d'administration : codes serveur
 * connus → i18n, erreurs voip.ms → statut exact remonté par l'API, sinon le
 * message brut ou un générique.
 */
export function errorMessage(t: Tr, err: unknown): string {
  // Abandon côté navigateur : voip.ms dépasse parfois le temps qu'on lui laisse.
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return t("users.verify.unreachable");
  }
  if (err instanceof ApiError) {
    const code = err.code;
    const known = [
      "email_taken",
      "cannot_deactivate_self",
      "cannot_demote_self",
      "cannot_delete_self",
      "invalid_did",
      "has_activity",
      "user_not_found",
    ];
    if (known.includes(code)) return t(`users.errors.${code}`);
    if (code === "voipms") {
      const msg = typeof err.data.message === "string" ? err.data.message : String(err.data.status ?? "");
      return `${t("users.voip.apiError")} : ${msg}`;
    }
    if (typeof err.data.message === "string") return err.data.message;
  }
  return t("genericError");
}
