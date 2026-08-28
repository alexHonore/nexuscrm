/**
 * Unitaire — les deux vocabulaires de `messages.status`.
 *
 * La colonne est un `text` LIBRE : elle reçoit mot pour mot ce que Twilio
 * renvoie ET les quelques littéraux que notre file écrit elle-même. Deux
 * vocabulaires dans une seule colonne, aucune contrainte pour les départager.
 * `status-classes.ts` est le seul endroit qui sait lequel est lequel — ce
 * fichier vérifie qu'il le sait encore.
 *
 * Trois régressions, dans l'ordre de gravité :
 *
 *  1. **Un littéral qui tombe dans « other ».** Un « delivered » majuscule ou
 *     un `dry_run` oublié ne fait pas planter la page : il fait CHUTER le taux
 *     de remise sans qu'aucune alarme ne pointe la cause. Le balayage ci-dessous
 *     relit le dépôt plutôt que de faire confiance à une liste recopiée.
 *  2. **`cancelled` et `canceled` confondus.** Deux orthographes, deux gestes,
 *     et la même erreur de lecture dans les deux sens : soit une annulation
 *     humaine se lit comme un incident de plateforme, soit une annulation
 *     Twilio disparaît du décompte de ce que l'équipe a retiré. C'est la
 *     raison d'être du fichier (contradiction C5).
 *  3. **La copie de `COUNTED` qui dérive.** `BILLABLE_STATUSES` est une copie
 *     verbatim de l'exécutant du plafond quotidien — le module pur n'a pas le
 *     droit d'importer le module serveur. Le dernier cas est le seul lien entre
 *     les deux : sans lui, l'écran afficherait de la marge là où l'envoi refuse
 *     déjà de partir.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BILLABLE_STATUSES,
  IN_FLIGHT_STATUSES,
  NO_DLR_STATUS,
  STALE_IN_FLIGHT_STATUSES,
  STATUS_BUCKETS,
  bucketOf,
  type StatusBucket,
} from "@/lib/deliverability/status-classes";
import { STATUS_RANK } from "@/lib/sms/status";

// `daily-cap.ts` ouvre sur `import "server-only"` — interdit hors d'un rendu
// serveur Next. On le neutralise pour pouvoir comparer les deux listes ; c'est
// tout l'objet du dernier cas.
vi.mock("server-only", () => ({}));

/**
 * `unknown` est le SEUL littéral connu qui tombe volontairement dans
 * « other » : il veut dire « on ne sait pas si c'est parti », et le ranger
 * ailleurs mentirait. Toute autre valeur du dépôt qui atterrit dans « other »
 * est un trou de couverture.
 */
const DELIBERATELY_OTHER = new Set(["unknown"]);

// ── Le balayage du dépôt ────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Tout littéral que le dépôt ÉCRIT dans `messages.status`.
 *
 * On repère chaque `.insert(messages)` / `.update(messages)`, puis on lit les
 * `status:` de l'objet qui suit — y compris les ternaires
 * (`status: sent ? "queued" : "dry_run"`), qui sont exactement les endroits où
 * un littéral se glisse sans se voir. Relire le dépôt plutôt qu'épingler une
 * liste : une liste recopiée est précisément ce que ce fichier existe pour
 * empêcher, et le prochain chemin d'écriture ne pensera pas à venir ici.
 */
function writtenStatusLiterals(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of sourceFiles("src")) {
    const source = readFileSync(file, "utf8");
    for (const write of source.matchAll(/\.(?:insert|update)\(\s*messages\s*\)/g)) {
      // La fenêtre couvre le `.values({…})` / `.set({…})` qui suit sans
      // déborder sur la mutation d'une AUTRE table (scheduledJobs, touches),
      // qui a son propre vocabulaire de statuts.
      const window = source.slice(write.index, write.index + 700);
      for (const assignment of window.matchAll(/\bstatus:\s*([^,\n}]+)/g)) {
        for (const literal of assignment[1].matchAll(/"([a-z_]+)"/g)) {
          const set = found.get(literal[1]) ?? new Set<string>();
          set.add(file);
          found.set(literal[1], set);
        }
      }
    }
  }
  return found;
}

/** L'inventaire tenu à jour côté interface : `thread.status.*`. */
function uiStatusLiterals(): string[] {
  const parsed: unknown = JSON.parse(readFileSync("messages/fr/conversations.json", "utf8"));
  const thread = (parsed as { thread?: { status?: Record<string, string> } }).thread;
  return Object.keys(thread?.status ?? {});
}

describe("chaque littéral que le dépôt écrit a son seau", () => {
  it("ceux que NOTRE file écrit elle-même", () => {
    // `sending`, `queued`, `skipped`, `dry_run`, `failed`, `unknown`,
    // `cancelled`, `received` : huit littéraux, cinq fichiers, aucun contrat
    // qui les relie à ce dictionnaire — d'où le balayage.
    const written = writtenStatusLiterals();
    const files = new Set([...written.values()].flatMap((s) => [...s]));
    // Un balayage qui ne trouve plus rien passerait sans rien vérifier.
    expect(written.size, "le balayage ne reconnaît plus une écriture de statut").toBeGreaterThanOrEqual(8);
    expect(files.size, "un seul fichier écrivant des statuts ? le motif a changé").toBeGreaterThanOrEqual(4);

    const uncovered = [...written.entries()]
      .filter(([literal]) => bucketOf(literal) === "other" && !DELIBERATELY_OTHER.has(literal))
      .map(([literal, where]) => `« ${literal} » écrit par ${[...where].join(", ")}`);
    expect(
      uncovered,
      `Littéraux écrits en base sans seau — ils tomberaient dans « other » et fausseraient les taux :\n  ${uncovered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("ceux que l'interface sait déjà afficher", () => {
    // `messages/fr/conversations.json` est l'inventaire tenu à jour côté
    // écran : un statut qui s'y trouve a forcément été vu en base. Un statut
    // rendu « Annulé » dans le fil et « other » dans le tableau de bord, c'est
    // le même message compté deux fois différemment sur deux écrans.
    const literals = uiStatusLiterals();
    expect(literals.length, "l'inventaire de l'interface a disparu").toBeGreaterThan(10);
    const uncovered = literals.filter(
      (l) => bucketOf(l) === "other" && !DELIBERATELY_OTHER.has(l),
    );
    expect(uncovered, `Statuts affichables sans seau : ${uncovered.join(", ")}`).toEqual([]);
  });

  it("ceux que Twilio nous dicte et qu'on recopie tels quels", () => {
    // `recordDeliveryOutcome` écrit la chaîne de Twilio SANS la traduire ;
    // `STATUS_RANK` (`src/lib/sms/status.ts`) est le vocabulaire partagé du
    // webhook de statut et de la réconciliation REST. Tout ce qui a un rang
    // là-bas peut donc arriver dans la colonne.
    const uncovered = Object.keys(STATUS_RANK).filter(
      (l) => bucketOf(l) === "other" && !DELIBERATELY_OTHER.has(l),
    );
    expect(uncovered, `Statuts Twilio sans seau : ${uncovered.join(", ")}`).toEqual([]);
    // Et en particulier : `canceled` a le rang 4 (terminal) sous cette graphie
    // EXACTE, ce qui prouve que l'orthographe à un L circule bien en base.
    expect(STATUS_RANK.canceled, "l'orthographe de Twilio a bougé — relire C5").toBe(4);
  });
});

// ── C5 ──────────────────────────────────────────────────────────────────────

describe("contradiction C5 — « canceled » et « cancelled »", () => {
  it("les deux orthographes sont reconnues et ne se mélangent PAS", () => {
    // Un L = Twilio : un message PROGRAMMÉ annulé avant son heure.
    // Deux L = nous : un humain a retiré un envoi encore en file
    // (`conversations/actions.ts`), le fil le rend « Annulé » et barre le texte.
    expect(bucketOf("canceled"), "l'annulation Twilio").toBe("carrier_cancelled");
    expect(bucketOf("cancelled"), "l'annulation humaine").toBe("operator_cancelled");
    expect(bucketOf("canceled")).not.toBe(bucketOf("cancelled"));
    // Et surtout : aucune des deux ne tombe dans « other ». Une seule des deux
    // reconnue est le pire des trois mondes — le total ferme, et il ment.
    for (const spelling of ["canceled", "cancelled"]) {
      expect(bucketOf(spelling), spelling).not.toBe("other");
    }
  });

  it("ni l'une ni l'autre ne se confond avec un échec de livraison", () => {
    // Un geste d'annulation n'est pas un incident : le compter en `failed`
    // ferait chercher une panne à chaque fois qu'un téléphoniste se ravise.
    for (const spelling of ["canceled", "cancelled"]) {
      expect(["failed", "undelivered", "delivered"], spelling).not.toContain(bucketOf(spelling));
    }
  });

  it("la normalisation traite la casse, pas le nombre de L", () => {
    // La colonne est du texte libre alimenté par un tiers : un « Delivered »
    // majuscule tombé dans « other » ferait chuter le taux de remise sans
    // qu'aucune alerte ne pointe la cause. Mais normaliser ne veut pas dire
    // rapprocher : deux L restent deux L.
    expect(bucketOf("  CANCELLED  ")).toBe("operator_cancelled");
    expect(bucketOf("Canceled")).toBe("carrier_cancelled");
    expect(bucketOf(" Delivered ")).toBe("delivered");
    expect(bucketOf("\tSENT\n")).toBe("in_flight");
    expect(bucketOf("Dry_Run")).toBe("never_left");
  });
});

// ── Rien ne tombe par terre ─────────────────────────────────────────────────

describe("bucketOf ne lève jamais et ne jette jamais une rangée", () => {
  it("l'absence, le vide et l'inconnu ressortent en « other »", () => {
    // Un histogramme dont les colonnes ne totalisent pas le nombre de rangées
    // est un histogramme qui ment. Une exception, elle, emporterait la page
    // entière sur une seule rangée bizarre.
    const strays: readonly (string | null | undefined)[] = [
      null,
      undefined,
      "",
      "   ",
      // `read` (RCS/WhatsApp) : volontairement hors catalogue, mais Twilio
      // l'émet — il doit être rangé, pas refusé.
      "read",
      "partially_delivered",
      "42",
      "DELIVERED_MAYBE",
      "statut inventé demain",
    ];
    for (const value of strays) {
      const label = JSON.stringify(value);
      expect(() => bucketOf(value), label).not.toThrow();
      expect(bucketOf(value), label).toBe("other");
    }
  });

  it("« other » reste un chiffre à lire, pas un fond de tiroir", () => {
    // `unknown` est écrit par deux chemins qui disent littéralement « on ne
    // sait pas » : une coupure réseau pendant l'envoi (Twilio a peut-être
    // accepté — renvoyer ferait un doublon) et un sid introuvable à la
    // réconciliation. Le ranger dans `never_left` ou dans `failed` mentirait.
    expect(bucketOf("unknown")).toBe("other");
  });

  it("chaque seau déclaré est atteignable par au moins un littéral", () => {
    // Un seau sans littéral est une colonne vide dans la répartition : elle
    // occupe une place et n'apprend rien.
    const witnesses: Record<StatusBucket, string> = {
      in_flight: "queued",
      delivered: "delivered",
      undelivered: "undelivered",
      failed: "failed",
      carrier_cancelled: "canceled",
      operator_cancelled: "cancelled",
      never_left: "skipped",
      received: "received",
      other: "unknown",
    };
    const unreachable = STATUS_BUCKETS.filter((b) => bucketOf(witnesses[b]) !== b);
    expect(unreachable, `seaux qu'aucun littéral n'atteint : ${unreachable.join(", ")}`).toEqual([]);
  });

  it("l'entrant ne pollue pas les taux sortants", () => {
    // `receiving` est la graphie que Twilio expose ; notre webhook écrit
    // toujours `received`. Même nature, même seau — et ce seau existe pour que
    // le total ferme, pas pour entrer dans un taux de remise.
    expect(bucketOf("received")).toBe("received");
    expect(bucketOf("receiving")).toBe("received");
  });

  it("ce qui n'est jamais sorti de la maison a son seau à part", () => {
    // `skipped` (interrupteur d'arrêt, désabonnement, bac à sable) et
    // `dry_run` ont un dénominateur SÉPARÉ : les mêler aux taux de remise
    // ferait chuter le taux à chaque coupure volontaire.
    expect(bucketOf("skipped")).toBe("never_left");
    expect(bucketOf("dry_run")).toBe("never_left");
  });
});

// ── Les listes qui nourrissent les indicateurs ──────────────────────────────

describe("les listes de statuts", () => {
  it("tout ce qui est « en vol » l'est vraiment", () => {
    for (const status of IN_FLIGHT_STATUSES) {
      expect(bucketOf(status), status).toBe("in_flight");
    }
  });

  it("`sent` vole encore, mais se surveille ailleurs", () => {
    // `IN_FLIGHT_STATUSES` est volontairement plus étroit que le seau : `sent`
    // est PARTI, il attend son accusé, et c'est sa persistance au-delà de 24 h
    // qui a révélé la panne du 2026-08-25 (les envois partaient, les rappels
    // de statut n'arrivaient plus, 44 messages livrés affichaient « En file »).
    expect(bucketOf(NO_DLR_STATUS)).toBe("in_flight");
    expect(IN_FLIGHT_STATUSES, "le mélanger noierait l'angle mort du 25 août").not.toContain(NO_DLR_STATUS);
    expect(NO_DLR_STATUS).toBe("sent");
  });

  it("« immobile » ne se dit que de ce que la réconciliation va relire", () => {
    // Un message PROGRAMMÉ a le droit d'attendre son heure : la
    // réconciliation ne le sonde pas, et le déclarer coincé allumerait une
    // alarme rouge sur le fonctionnement normal d'un envoi différé.
    expect(STALE_IN_FLIGHT_STATUSES).not.toContain("scheduled");
    expect(IN_FLIGHT_STATUSES).toContain("scheduled");
    const outside = STALE_IN_FLIGHT_STATUSES.filter((s) => !IN_FLIGHT_STATUSES.includes(s));
    expect(outside, `statuts déclarés immobiles sans être en vol : ${outside.join(", ")}`).toEqual([]);
  });

  it("la liste des « immobiles » est celle que `reconcile.ts` sonde vraiment", () => {
    // Le module le dit en toutes lettres : si `reconcile.ts` change sa liste,
    // celle-ci doit suivre. Un tableau de bord qui désigne comme coincé ce que
    // le moteur ne va JAMAIS débloquer envoie l'opérateur chercher une panne
    // qui n'existe pas. On relit donc la requête plutôt que la promesse.
    const source = readFileSync("src/lib/jobs/reconcile.ts", "utf8");
    const probed = source.match(/inArray\(\s*messages\.status,\s*\[([^\]]*)\]/);
    expect(probed, "la requête de réconciliation a changé de forme — relire à la main").not.toBeNull();
    const statuses = [...(probed?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(statuses.length, "aucun statut lu dans reconcile.ts").toBeGreaterThan(0);
    expect([...statuses].sort()).toEqual([...STALE_IN_FLIGHT_STATUSES].sort());
  });
});

// ── Le garde de dérive ──────────────────────────────────────────────────────

describe("BILLABLE_STATUSES ne dérive pas de l'exécutant du plafond", () => {
  it("la copie vaut encore l'original", async () => {
    // `status-classes.ts` est PUR : il ne peut pas importer `daily-cap.ts`,
    // qui ouvre sur `server-only` et touche `@/db`. Il RECOPIE donc `COUNTED`,
    // et ce cas est le seul lien entre les deux fichiers. Sans lui, la copie
    // dérive en silence et l'écran annonce de la marge sous un plafond que
    // `handleSendSms` considère déjà plein — il reporte au lendemain pendant
    // que le tableau de bord dit qu'il reste de la place.
    const { COUNTED } = await import("@/lib/sms-server/daily-cap");
    expect(
      [...BILLABLE_STATUSES],
      "COUNTED a changé dans src/lib/sms-server/daily-cap.ts — recopier la liste ici",
    ).toEqual([...COUNTED]);
  });

  it("chaque statut compté au plafond a bel et bien quitté la maison", () => {
    // Le plafond compte « tout ce qui est sorti ». Un statut qui n'est jamais
    // parti (`skipped`, `dry_run`) ou un entrant consommerait du quota sans
    // qu'aucun message n'ait été remis à Twilio.
    const wrong = BILLABLE_STATUSES.filter((s) => ["never_left", "received"].includes(bucketOf(s)));
    expect(wrong, `statuts comptés au plafond sans être partis : ${wrong.join(", ")}`).toEqual([]);
  });

  it("et `unknown` y est — un envoi peut-être parti se compte comme parti", () => {
    // C'est le choix prudent : renvoyer ferait un doublon, donc on assume
    // qu'il est sorti. Il tombe dans « other » à l'affichage, ce qui est une
    // autre question — et volontairement une autre colonne.
    expect(BILLABLE_STATUSES).toContain("unknown");
    expect(bucketOf("unknown")).toBe("other");
  });
});
