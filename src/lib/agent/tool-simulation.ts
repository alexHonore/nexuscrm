/**
 * Résultats d'outils SIMULÉS — module pur, partagé par le bac à sable et la
 * suite de garde-fous.
 *
 * Une seule copie, délibérément. Ces deux surfaces doivent répondre au modèle
 * de la MÊME façon, sinon un assistant qui passe la suite se comporte
 * autrement à l'essai — et l'écart serait invisible jusqu'à ce que quelqu'un
 * compare les deux à la main.
 *
 * Deux principes, tous deux appris à nos dépens :
 *
 *  · Les réponses sont NEUTRES : on ne dit jamais au modèle qu'il est dans un
 *    essai. Une version antérieure annonçait « exemples non réservables » et le
 *    modèle rappelait l'outil en boucle au lieu de rédiger — un comportement
 *    que la production n'a jamais. L'avertissement « ce n'est pas réel »
 *    s'adresse à l'humain, à l'écran.
 *
 *  · Les réponses suivent les MÊMES règles que `executeTools` en production
 *    (`runtime.ts`) : arguments validés par zod, `book_meeting` refusé tant
 *    qu'un champ requis manque ou que le créneau n'a pas été offert, outils à
 *    effet de bord joués une seule fois par tour, `get_slots` muet sur un
 *    cran qui ne réserve pas. Une version antérieure répondait « confirmé » à
 *    tout `book_meeting` : l'essai montrait un rendez-vous pris là où la
 *    production escaladait — l'admin livrait un assistant qui ne réservait
 *    jamais.
 *
 * Ce module n'exécute RIEN : aucun agenda consulté, aucun rendez-vous créé.
 */
import { fromZonedTime } from "date-fns-tz";
import { formatSlotLabel, type BookingSlot } from "@/lib/booking/provider";
import { missingFieldsError, parseToolArgs } from "./tools";

/** Fuseau des libellés — celui de l'app (voir AGENTS.md). */
const SLOT_TZ = "America/Toronto";

/**
 * Outils dont l'effet est irréversible : joués une seule fois par tour — MÊME
 * liste qu'en production. `get_slots` n'en fait pas partie : le rappeler
 * renvoie les disponibilités, pas « déjà exécuté ».
 */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "book_meeting",
  "stop",
  "handoff",
  "schedule_followup",
]);

/** Ces outils terminent le tour : rappeler le modèle ensuite ne sert à rien. */
export function isTerminalTool(name: string): boolean {
  return name === "stop" || name === "handoff";
}

// ── Disponibilités simulées ─────────────────────────────────────────────────

/** Créneaux offerts par l'agenda simulé : jour de semaine + heure locale. */
const SIMULATED_SLOT_PATTERN: readonly { weekday: number; hour: number; minute: number }[] = [
  { weekday: 4, hour: 14, minute: 0 }, // jeudi 14 h
  { weekday: 5, hour: 18, minute: 30 }, // vendredi 18 h 30
  { weekday: 1, hour: 10, minute: 0 }, // lundi 10 h
];

/**
 * Les disponibilités que l'agenda simulé « trouve » — les prochaines
 * occurrences de jeudi 14 h, vendredi 18 h 30 et lundi 10 h (heure de
 * Toronto), TOUJOURS dans le futur par rapport à `now`.
 *
 * Les libellés passent par `formatSlotLabel`, exactement comme en production :
 * le modèle lit « jeudi 14 h », pas « jeudi 14h » ni une variante inventée ici.
 * Les instants ISO servent à valider `book_meeting` comme le ferait l'agenda
 * réel (un créneau non offert est refusé) — ils ne sont PAS montrés au modèle,
 * parce que la production ne les montre pas non plus.
 */
export function simulatedSlots(now: Date = new Date()): BookingSlot[] {
  const slots: BookingSlot[] = [];
  for (const pattern of SIMULATED_SLOT_PATTERN) {
    // On avance jour par jour dans le calendrier de Toronto (chaîne de date,
    // jamais une arithmétique d'instants) pour ne pas glisser d'un jour autour
    // d'un changement d'heure.
    for (let offset = 1; offset <= 8; offset += 1) {
      const probe = new Date(now.getTime() + offset * 86_400_000);
      const y = probe.getUTCFullYear();
      const m = String(probe.getUTCMonth() + 1).padStart(2, "0");
      const d = String(probe.getUTCDate()).padStart(2, "0");
      const hh = String(pattern.hour).padStart(2, "0");
      const mm = String(pattern.minute).padStart(2, "0");
      const local = fromZonedTime(`${y}-${m}-${d}T${hh}:${mm}:00`, SLOT_TZ);
      if (local.getTime() <= now.getTime()) continue;
      if (localWeekday(local) !== pattern.weekday) continue;
      slots.push({ iso: local.toISOString(), label: formatSlotLabel(local, SLOT_TZ) });
      break;
    }
  }
  return slots;
}

/** Jour de semaine (0 = dimanche) de l'instant, vu de Toronto. */
function localWeekday(date: Date): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: SLOT_TZ, weekday: "short" }).format(
    date,
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
}

/** « jeudi 14 h, vendredi 18 h 30 » — ce que la couche L7 et get_slots montrent. */
export function simulatedSlotsText(count = 2, now: Date = new Date()): string {
  return simulatedSlots(now)
    .slice(0, Math.max(1, Math.min(3, count)))
    .map((s) => s.label)
    .join(", ");
}

// ── Simulation d'UN appel ───────────────────────────────────────────────────

export interface ToolSimulationContext {
  /** Arguments bruts envoyés par le modèle — validés ici par zod. */
  args: unknown;
  /** Le cran d'objectif courant réserve-t-il une rencontre, et de quel type? */
  appointmentType: "meet" | "inperson" | null;
  /** Champs de qualification exigés avant de réserver, pour ce cran. */
  requiredFields: readonly string[];
  /** Qualification accumulée (fil + tour courant). */
  qualification: Record<string, unknown>;
  /** Horloge injectable — les tests fixent les créneaux. */
  now?: Date;
}

export interface SimulatedToolOutcome {
  name: string;
  /** Faux quand les arguments n'ont pas passé zod — l'appel ne compte pas. */
  ok: boolean;
  /** Ce que le modèle lit, rattaché à son identifiant par l'appelant. */
  content: string;
  /** Vrai si une réservation a ÉCHOUÉ — la production escalade alors. */
  bookingFailed: boolean;
  terminated: "stop" | "handoff" | null;
}

/**
 * Simule UN appel d'outil avec les MÊMES règles que la production. L'ordre des
 * vérifications est celui de `executeTools` : zod, puis dédoublonnage des
 * effets de bord, puis la logique propre à l'outil.
 */
export function simulateToolCall(
  name: string,
  done: Set<string>,
  ctx: ToolSimulationContext,
): SimulatedToolOutcome {
  const base = { name, bookingFailed: false, terminated: null };
  const parsed = parseToolArgs(name, ctx.args);
  if (!parsed.ok) {
    return { ...base, ok: false, content: `${name} : ${parsed.error}` };
  }
  if (SIDE_EFFECT_TOOLS.has(name) && done.has(name)) {
    return { ...base, ok: true, content: `${name} : déjà exécuté à ce tour` };
  }

  switch (parsed.name) {
    case "get_slots": {
      const { count } = parsed.args as { count: number };
      if (!ctx.appointmentType) {
        return { ...base, ok: true, content: "get_slots : ce cran d'objectif ne réserve pas de rencontre" };
      }
      return { ...base, ok: true, content: `get_slots : ${simulatedSlotsText(count, ctx.now)}` };
    }

    case "book_meeting": {
      const args = parsed.args as { slotIso: string; email?: string };
      const missing = ctx.requiredFields.filter((field) => {
        const value = ctx.qualification[field];
        return typeof value !== "string" || value.trim() === "";
      });
      if (missing.length > 0) {
        return { ...base, ok: true, bookingFailed: true, content: missingFieldsError(missing) };
      }
      if (!ctx.appointmentType) {
        return {
          ...base,
          ok: true,
          bookingFailed: true,
          content: "book_meeting : ce cran ne réserve pas de rencontre",
        };
      }
      done.add(name);
      // L'agenda simulé juge le créneau comme le vrai : une date illisible est
      // « invalid_slot », une heure qui n'a pas été offerte est « slot_taken ».
      const startsAt = new Date(args.slotIso);
      if (Number.isNaN(startsAt.getTime())) {
        return {
          ...base,
          ok: true,
          bookingFailed: true,
          content: "book_meeting : ÉCHEC (invalid_slot) — ne confirme RIEN, propose autre chose.",
        };
      }
      const offered = simulatedSlots(ctx.now).some((s) => s.iso === startsAt.toISOString());
      if (!offered) {
        return {
          ...base,
          ok: true,
          bookingFailed: true,
          content: "book_meeting : ÉCHEC (slot_taken) — ne confirme RIEN, propose autre chose.",
        };
      }
      return { ...base, ok: true, content: `book_meeting : confirmé pour ${args.slotIso}` };
    }

    case "stop":
      done.add(name);
      return { ...base, ok: true, content: "", terminated: "stop" };

    case "handoff":
      done.add(name);
      return { ...base, ok: true, content: "", terminated: "handoff" };

    default:
      // update_qualification, schedule_followup, transfer_assistant,
      // close_conversation : notés, comme en production.
      if (SIDE_EFFECT_TOOLS.has(name)) done.add(name);
      return { ...base, ok: true, content: `${name} : pris en compte` };
  }
}

/**
 * Forme HISTORIQUE, sans arguments ni cran — encore utilisée par la suite de
 * garde-fous (`guardrails/runner.ts`), qui ne rejoue pas les arguments du
 * modèle. Elle suppose un cran qui réserve et aucun champ requis, et ne valide
 * rien : c'est le maximum de fidélité possible sans contexte. Les réponses
 * canoniques (disponibilités, « déjà exécuté ») viennent de la même source que
 * le bac à sable, pour que les deux surfaces lisent les mêmes heures.
 */
export function simulatedToolResult(name: string, done: Set<string>): string {
  if (SIDE_EFFECT_TOOLS.has(name) && done.has(name)) return `${name} : déjà exécuté à ce tour`;
  if (SIDE_EFFECT_TOOLS.has(name)) done.add(name);
  switch (name) {
    case "get_slots":
      return `get_slots : ${simulatedSlotsText(2)}`;
    case "book_meeting":
      return "book_meeting : confirmé";
    case "stop":
    case "handoff":
      return "";
    default:
      return `${name} : pris en compte`;
  }
}
