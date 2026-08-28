import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanBody } from "@/lib/deliverability/content";
import { rangeOf } from "@/lib/deliverability/range";
import type { DeliverabilityFacts, EvidenceSample } from "@/lib/deliverability/types";
import { getSetting } from "@/lib/settings";
import { brandTokens, scanCampaignBodies } from "./campaign-scan";
import {
  burstFacts,
  carrierSuppressionFacts,
  destinationFacts,
  engagementFacts,
  hostileReplyFacts,
  numberFacts,
  openerBodies,
  optOutFacts,
  queueFacts,
  quietHoursFacts,
  senderInconsistency,
  skipHistogram,
  stamp,
  suppressionLeaks,
} from "./queries";
import { scanTemplates } from "./templates";

/**
 * Rassemble TOUS les faits de délivrabilité en une passe.
 *
 * Un seul point d'entrée pour la page, et c'est délibéré : chaque requête
 * ajoutée ici part dans le même `Promise.all`, donc le coût de l'écran est
 * celui de la requête la plus lente, pas de leur somme. Une page qui gagnerait
 * un aller-retour à chaque nouvel indicateur finirait par ne plus être ouverte.
 *
 * Aucune interprétation ici : ce module LIT. C'est `assess()` — pur, testable
 * sans base — qui décide ce qui va mal.
 */

/**
 * La cadence du cron, lue dans `vercel.json` plutôt que recopiée.
 *
 * Ça compte : les commentaires du moteur supposent un répartiteur à la minute,
 * la configuration déployée le lance UNE FOIS PAR JOUR, et la file avance en
 * réalité sur les relances en cours de processus. Une constante en dur ici
 * dirait ce qu'on croit ; le fichier dit ce qui tourne.
 */
async function cronSchedule(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), "vercel.json"), "utf8");
    const parsed = JSON.parse(raw) as { crons?: { path?: string; schedule?: string }[] };
    const entry = parsed.crons?.find((c) => c.path === "/api/cron/dispatch");
    return entry?.schedule ?? null;
  } catch {
    return null;
  }
}

export async function collectFacts(days: number, now = new Date()): Promise<DeliverabilityFacts> {
  const range = rangeOf(days, now);
  const tokens = await brandTokens();

  const [
    numbers,
    skipped,
    optOut,
    carrierSuppressions,
    leaks,
    engagement,
    hostile,
    burst,
    inconsistency,
    quietHours,
    destinations,
    templates,
    campaignScan,
    queue,
    smsSettings,
    openers,
    schedule,
  ] = await Promise.all([
    numberFacts(range, now),
    skipHistogram(range),
    optOutFacts(range),
    carrierSuppressionFacts(range),
    suppressionLeaks(range),
    engagementFacts(range),
    hostileReplyFacts(range),
    burstFacts(range),
    senderInconsistency(range),
    quietHoursFacts(range),
    destinationFacts(range),
    scanTemplates(range),
    scanCampaignBodies(tokens),
    queueFacts(now),
    getSetting("sms"),
    openerBodies(range),
    cronSchedule(),
  ]);

  // L'analyse des ouvertures se fait ICI et non en SQL : reconnaître « STOP »
  // ou « arrêt » demande de plier les accents, et `unaccent` n'est pas
  // installé. Le corpus est borné à la première ligne de chaque fil, jamais au
  // fil entier.
  let missingOptOut = 0;
  let missingBrand = 0;
  const openerSamples: EvidenceSample[] = [];
  for (const opener of openers.rows) {
    const flags = scanBody(opener.body, { brandTokens: tokens, isOpener: true });
    if (!flags.hasOptOut) missingOptOut += 1;
    if (!flags.hasBrand) missingBrand += 1;
    if ((!flags.hasOptOut || !flags.hasBrand) && openerSamples.length < 5) {
      openerSamples.push({
        label: stamp(opener.createdAt),
        excerpt: opener.body.slice(0, 160),
        href: `/clients/${opener.clientId}`,
      });
    }
  }

  return {
    now,
    range,
    numbers,
    skipped,
    optOut,
    carrierSuppressions,
    suppressionLeaks: leaks.samples,
    suppressionLeakTotal: leaks.total,
    engagement,
    hostile,
    burst,
    senderInconsistency: inconsistency.rows,
    senderInconsistencyTotal: inconsistency.total,
    quietHours,
    destinations,
    templates,
    campaignIssues: campaignScan.issues,
    unguardedLadderRungs: campaignScan.unguarded,
    engine: {
      lastDispatchAt: smsSettings.lastDispatchAt ? new Date(smsSettings.lastDispatchAt) : null,
      killSwitch: smsSettings.killSwitch,
      killSwitchReason: smsSettings.killSwitchReason,
      backlog: queue.backlog,
      oldestPendingAt: queue.oldestPendingAt,
      cronSchedule: schedule,
    },
    openers: {
      scanned: openers.rows.length,
      missingOptOut,
      missingBrand,
      samples: openerSamples,
      truncated: openers.truncated,
    },
  };
}
