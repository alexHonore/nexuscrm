/**
 * Intégration — le repli des gabarits, contre la VRAIE requête.
 *
 * `scanTemplates` plie en DEUX temps : Postgres regroupe grossièrement sur une
 * clé `md5()`, puis TypeScript replie finement (accents, apostrophes, dates,
 * montants, pied de page) et rattrape la dérive au SimHash. Le raccourci ne
 * tient qu'à UN invariant :
 *
 *   **la clé SQL applique un sous-ensemble STRICT des règles TypeScript.**
 *
 * Sa partition est donc plus FINE, et le repli TypeScript ne peut que
 * re-fusionner des représentants — jamais en perdre un. Si la clé SQL
 * fusionnait deux corps que le normaliseur TypeScript garde distincts, le
 * `min(body)` de l'agrégat en garderait UN SEUL : le second gabarit
 * disparaîtrait de l'écran sans laisser de trace, et ses messages seraient
 * recomptés sur le premier. Sur un onglet de conformité, c'est le pire mode de
 * panne possible — un chiffre faux qui a l'air juste.
 *
 * Cet invariant est démontré ici de DEUX façons complémentaires, parce qu'un
 * invariant démontré à l'oral dérive :
 *
 *  1. **paire par paire**, contre la vraie requête : deux corps sont semés
 *     seuls, et `scanned` dit s'ils partagent une clé SQL. S'ils la partagent,
 *     `normalizeTemplate` DOIT être d'accord ;
 *  2. **globalement** : replier le corpus RANGÉE PAR RANGÉE doit donner
 *     exactement les mêmes grappes que le replier depuis les groupes
 *     grossiers. Une sur-fusion en SQL se verrait immédiatement — une grappe
 *     de moins, et des messages transvasés sur la mauvaise.
 *
 * Et le plafond : au-delà de `MAX_SCAN_ROWS` groupes, l'écran doit DIRE qu'il
 * n'a pas tout lu (`truncated`) plutôt que sous-compter en silence.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  resetDb,
  testDb,
} from "./helpers/db";
import { messages } from "@/db/schema-sms";
import {
  MAX_SCAN_ROWS,
  foldTemplates,
  normalizeTemplate,
  type CoarseGroup,
} from "@/lib/deliverability/dedupe";
import { rangeOf } from "@/lib/deliverability/range";
import type { TemplateCluster } from "@/lib/deliverability/types";

vi.mock("server-only", () => ({}));

const { scanTemplates } = await import("@/lib/deliverability-server/templates");

const NOW = new Date("2026-08-27T15:00:00Z");
const RANGE = rangeOf(7, NOW);
const SENT_AT = new Date("2026-08-22T12:00:00Z");

// ── Le corpus ───────────────────────────────────────────────────────────────

/**
 * Trente prénoms québécois. AUCUN n'apparaît ailleurs dans les corps semés —
 * c'est délibéré : la clé SQL remplace le prénom par un `replace()` SANS
 * frontière de mot, là où TypeScript borne le motif. Un client prénommé « Marc »
 * ferait de « marché » un « ~p~hé » côté SQL seulement, et disperserait le
 * gabarit au lieu de le rassembler.
 */
const PRENOMS = [
  "Simon", "Nathalie", "Pierre", "Sophie", "Martin", "Isabelle", "Gabriel", "Vincent",
  "Caroline", "Sebastien", "Josee", "Mathieu", "Veronique", "Guillaume", "Stephanie",
  "Francois", "Chantal", "Olivier", "Melanie", "Sylvain", "Genevieve", "Patrick",
  "Nadine", "Maxime", "Julie", "Benoit", "Karine", "Antoine", "Valerie", "Charles",
];

/** Le barreau d'ouverture d'une campagne : un seul gabarit, trente instances. */
const evaluation = (prenom: string) =>
  `Bonjour ${prenom}, ici Alex du Groupe Nexus. Votre maison à Lévis vaut peut-être ` +
  `plus qu'en 2024 — voulez-vous une évaluation gratuite ? Répondez STOP pour vous désabonner.`;

/** Un texte SANS rapport : il doit rester une grappe à lui. */
const suivi =
  "Merci pour votre appel. Je vous envoie les trois fiches dont nous avons parlé. " +
  "Bonne journée ! Répondez STOP pour ne plus rien recevoir.";

/**
 * Le MÊME gabarit avec un lien de suivi PAR DESTINATAIRE. C'est la première
 * source de fausse unicité : sans le repli des liens, mille envois d'un même
 * texte feraient mille gabarits et l'essaimage deviendrait indétectable.
 */
const fiche = (jeton: string) =>
  `Voici la fiche complète : https://suivi.example.com/f/${jeton} — Alex, Groupe Nexus. ` +
  `Répondez STOP pour arrêter.`;

/** Un rappel rendu (le prénom est là) … */
const rappelRendu = (prenom: string) =>
  `Rappel : votre visite est confirmée pour demain, ${prenom}. Répondez STOP pour vous désabonner.`;

/** … et la même rangée partie SANS être rendue : le champ de fusion a fui. */
const rappelBrut =
  "Rappel : votre visite est confirmée pour demain, {{prenom}}. Répondez STOP pour vous désabonner.";

interface CorpusRow {
  label: string;
  body: string;
  /** Nom complet de la fiche : la requête n'a qu'un `full_name` à découper. */
  fullName: string;
  /** Sur quelle ligne le fil est épinglé — c'est ELLE qui porte l'essaimage. */
  sender: "A" | "B";
}

/** Le corpus complet : 39 rangées, 5 gabarits, dont un porté par deux lignes. */
const CORPUS: CorpusRow[] = [
  ...PRENOMS.map((p) => ({
    label: `evaluation:${p}`,
    body: evaluation(p),
    fullName: `${p} Tremblay`,
    sender: "A" as const,
  })),
  // Trois envois du même texte depuis DEUX lignes : l'essaimage, le seul
  // chiffre de cet onglet qui alarme (CTIA §5.5.2).
  { label: "suivi:1", body: suivi, fullName: "Rene Roy", sender: "A" },
  { label: "suivi:2", body: suivi, fullName: "Lucie Roy", sender: "B" },
  { label: "suivi:3", body: suivi, fullName: "Denis Roy", sender: "B" },
  { label: "fiche:AB12CD", body: fiche("AB12CD"), fullName: "Hugo Roy", sender: "A" },
  { label: "fiche:XY34ZW", body: fiche("XY34ZW"), fullName: "Manon Roy", sender: "A" },
  { label: "fiche:QR56ST", body: fiche("QR56ST"), fullName: "Felix Roy", sender: "A" },
  { label: "rappel:Julie", body: rappelRendu("Julie"), fullName: "Julie Roy", sender: "A" },
  { label: "rappel:Antoine", body: rappelRendu("Antoine"), fullName: "Antoine Roy", sender: "A" },
  { label: "rappel:brut", body: rappelBrut, fullName: "Marc Roy", sender: "A" },
];

const firstNameOf = (row: CorpusRow) => row.fullName.split(" ")[0];

let numberA: string;
let numberB: string;

async function makeNumbers(): Promise<void> {
  numberA = (await makeSmsNumber({ e164: "+15815550001", label: "Ligne A" })).id;
  numberB = (await makeSmsNumber({ e164: "+15815550002", label: "Ligne B" })).id;
}

/** Sème les rangées demandées : une fiche, un fil et un sortant PARTI par rangée. */
async function seed(rows: CorpusRow[]): Promise<void> {
  const values: (typeof messages.$inferInsert)[] = [];
  for (const [index, row] of rows.entries()) {
    const phone = `+1418555${(1000 + index).toString()}`;
    const client = await makeClient({ fullName: row.fullName, phone });
    const conversation = await makeConversation({
      clientId: client.id,
      clientPhone: phone,
      smsNumberId: row.sender === "A" ? numberA : numberB,
    });
    values.push({
      conversationId: conversation.id,
      direction: "out",
      body: row.body,
      source: "ladder",
      // Sans sid, la requête ignore la rangée : le repli ne lit QUE ce qui est
      // réellement parti chez des gens.
      twilioSid: `SM${index.toString().padStart(32, "0")}`,
      status: "delivered",
      segments: 1,
      encoding: "GSM-7",
      createdAt: SENT_AT,
    });
  }
  await testDb.insert(messages).values(values);
}

/** La même semence repliée RANGÉE PAR RANGÉE : la partition la plus fine possible. */
function foldRowByRow(rows: CorpusRow[]): TemplateCluster[] {
  const groups: CoarseGroup[] = rows.map((row, index) => ({
    coarseKey: `rangee-${index}`,
    body: row.body,
    messages: 1,
    distinctRecipients: 1,
    senders: [row.sender === "A" ? numberA : numberB],
    firstName: firstNameOf(row),
  }));
  return foldTemplates(groups);
}

/** Repère une grappe par un fragment de son corps représentatif. */
function clusterWith(clusters: TemplateCluster[], fragment: string): TemplateCluster | undefined {
  return clusters.find((c) => c.representativeBody.includes(fragment));
}

beforeEach(async () => {
  await resetDb();
  await makeNumbers();
});

afterAll(async () => {
  await closeDb();
});

// ── La sémantique du repli ──────────────────────────────────────────────────

describe("scanTemplates — ce que l'opérateur doit lire", () => {
  it("trente prénoms différents ne font qu'UN gabarit", async () => {
    // C'est la raison d'être de l'étage SQL : cinq mille messages qui ne
    // diffèrent que par un prénom doivent traverser le réseau en UNE ligne.
    // Sans lui, cinquante mille corps remonteraient à chaque chargement de page.
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);

    const grappe = clusterWith(scan.clusters, "ici Alex du Groupe Nexus");
    expect(grappe, "les trente instances doivent former une seule grappe").toBeDefined();
    expect(grappe?.messages).toBe(30);
    expect(grappe?.distinctRecipients, "trente téléphones distincts").toBe(30);
    expect(grappe?.distinctSendingNumbers, "un seul expéditeur : rien à signaler").toBe(1);
    // Les grappes sortent triées par volume décroissant : la plus grosse en tête.
    expect(scan.clusters[0].messages).toBe(30);
    expect(scan.truncated).toBe(false);
  });

  it("deux gabarits sans rapport restent DEUX grappes", async () => {
    // Sur-fusionner FABRIQUE une alerte d'essaimage sur des textes sans
    // rapport — et une alerte inventée sur un écran de conformité coûte la
    // confiance de tout l'onglet.
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);

    const relance = clusterWith(scan.clusters, "ici Alex du Groupe Nexus");
    const merci = clusterWith(scan.clusters, "Merci pour votre appel");
    expect(merci).toBeDefined();
    expect(merci?.messages).toBe(3);
    expect(relance?.representativeBody).not.toBe(merci?.representativeBody);
  });

  it("un lien de suivi PAR DESTINATAIRE ne fragmente pas le gabarit", async () => {
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);

    const grappe = clusterWith(scan.clusters, "Voici la fiche complète");
    expect(grappe?.messages, "trois liens différents, un seul gabarit").toBe(3);
    // Le corps représentatif est un corps RÉEL, avec un vrai lien dedans :
    // l'opérateur doit reconnaître ce que les gens ont reçu, pas un gabarit
    // reconstruit qu'il n'a jamais envoyé.
    expect(grappe?.representativeBody).toContain("https://suivi.example.com/f/");
  });

  it("un même gabarit porté par DEUX lignes est de l'essaimage", async () => {
    // `distinctSendingNumbers ≥ 2` est le SEUL chiffre de cet onglet qui alarme.
    // La bonne réponse est d'épingler le gabarit à UN numéro — jamais de
    // réécrire le texte pour faire baisser le chiffre : la variation fabriquée
    // est elle-même la transgression (politique de messagerie Twilio, clause
    // d'EFFET).
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);

    const grappe = clusterWith(scan.clusters, "Merci pour votre appel");
    expect(grappe?.distinctSendingNumbers).toBe(2);
  });

  it("le champ de fusion non rendu reste une grappe À PART — et c'est mesuré", async () => {
    // Le normaliseur remplace `{{prenom}}` par la sentinelle de CHAMP (`~f~`)
    // et un prénom rendu par la sentinelle de PERSONNE (`~p~`) : deux gabarits
    // distincts, que le second repli ne rattrape pas — distance de Hamming
    // mesurée 6, au-dessus de SIMHASH_MAX_DISTANCE = 3, exactement ce que
    // documente le seuil (« un mot changé dans un gabarit de ≈ 100 caractères :
    // 5 → ne fusionne pas »).
    //
    // Ce n'est PAS un défaut : la fuite de champ de fusion a son propre constat
    // (`merge_field_leak`, via `scanBody`). Ce test épingle la frontière pour
    // qu'un ajustement du seuil ne la déplace pas sans qu'on s'en aperçoive.
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);

    const rendu = clusterWith(scan.clusters, "confirmée pour demain, Antoine");
    const brut = clusterWith(scan.clusters, "{{prenom}}");
    expect(rendu?.messages, "les deux instances rendues se replient ensemble").toBe(2);
    expect(brut?.messages, "la rangée non rendue reste seule").toBe(1);
  });

  it("une base sans le moindre sortant rend un balayage vide, pas une erreur", async () => {
    const scan = await scanTemplates(RANGE);
    expect(scan).toEqual({ clusters: [], scanned: 0, truncated: false });
  });
});

// ── L'invariant de raffinement ──────────────────────────────────────────────

describe("invariant — la clé SQL ne fusionne JAMAIS ce que TypeScript sépare", () => {
  /**
   * Sept corps représentatifs, un par piège : deux instances d'un même gabarit,
   * un gabarit étranger, deux liens de suivi différents, un rappel rendu et le
   * même rappel non rendu.
   */
  const SONDES: CorpusRow[] = [
    { label: "evaluation:Simon", body: evaluation("Simon"), fullName: "Simon Tremblay", sender: "A" },
    { label: "evaluation:Julie", body: evaluation("Julie"), fullName: "Julie Tremblay", sender: "A" },
    { label: "suivi", body: suivi, fullName: "Rene Roy", sender: "A" },
    { label: "fiche:AB12CD", body: fiche("AB12CD"), fullName: "Hugo Roy", sender: "A" },
    { label: "fiche:XY34ZW", body: fiche("XY34ZW"), fullName: "Manon Roy", sender: "A" },
    { label: "rappel:Julie", body: rappelRendu("Julie"), fullName: "Julie Roy", sender: "A" },
    { label: "rappel:brut", body: rappelBrut, fullName: "Marc Roy", sender: "A" },
  ];

  it("paire par paire : deux corps de même clé SQL ont le même gabarit TypeScript", async () => {
    // La clé grossière n'est pas exportée, et la recopier ici la ferait dériver
    // du jour où elle change. On l'interroge donc PAR SON EFFET : deux rangées
    // semées seules, `scanned === 1` veut dire « même clé SQL ». C'est la vraie
    // requête qui répond, pas une copie.
    const partages: string[] = [];
    const fautes: string[] = [];

    for (let i = 0; i < SONDES.length; i += 1) {
      for (let j = i + 1; j < SONDES.length; j += 1) {
        await resetDb();
        await makeNumbers();
        await seed([SONDES[i], SONDES[j]]);
        const scan = await scanTemplates(RANGE);

        const memeCle = scan.scanned === 1;
        if (!memeCle) continue; // SQL plus fin que TypeScript : permis, et sans danger.
        partages.push(`${SONDES[i].label} ~ ${SONDES[j].label}`);
        const gauche = normalizeTemplate(SONDES[i].body, firstNameOf(SONDES[i]));
        const droite = normalizeTemplate(SONDES[j].body, firstNameOf(SONDES[j]));
        if (gauche !== droite) {
          fautes.push(
            `${SONDES[i].label} + ${SONDES[j].label}\n    SQL : une seule clé\n` +
              `    TS  : ${JSON.stringify(gauche)}\n    TS  : ${JSON.stringify(droite)}`,
          );
        }
      }
    }

    expect(
      fautes,
      "Ces paires partagent une clé SQL alors que le normaliseur TypeScript les sépare : " +
        "`min(body)` en garderait UN SEUL et l'autre gabarit disparaîtrait de l'écran.\n  " +
        fautes.join("\n  "),
    ).toEqual([]);
    // Et le test ne doit pas passer par VACUITÉ. Si l'étage SQL cessait de
    // replier (une substitution retirée de la clé), aucune paire ne partagerait
    // plus de clé, l'invariant serait trivialement vrai — et cinquante mille
    // corps traverseraient le réseau à chaque chargement de page sans que rien
    // ne le signale. Les deux replis qui portent tout le gain sont donc épinglés
    // nommément : le prénom du destinataire, et le lien de suivi par personne.
    expect(
      partages.sort(),
      "l'étage SQL doit replier le prénom ET le lien de suivi — sinon il ne sert à rien",
    ).toEqual(["evaluation:Simon ~ evaluation:Julie", "fiche:AB12CD ~ fiche:XY34ZW"]);
  });

  it("globalement : replier rangée par rangée donne les MÊMES grappes", async () => {
    // Formulation d'ensemble du même invariant. Si la clé SQL fusionnait deux
    // corps que TypeScript sépare, `min(body)` en perdrait un : on verrait une
    // grappe de moins et des messages transvasés. Comparer les deux chemins sur
    // la même semence rend cette panne impossible à manquer.
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);
    const parRangee = foldRowByRow(CORPUS);

    expect(scan.clusters.length, "autant de grappes par les deux chemins").toBe(parRangee.length);
    const volumes = (list: TemplateCluster[]) => list.map((c) => c.messages).sort((a, b) => a - b);
    expect(volumes(scan.clusters), "et les mêmes volumes, grappe pour grappe").toEqual(
      volumes(parRangee),
    );
    const expediteurs = (list: TemplateCluster[]) =>
      list.map((c) => c.distinctSendingNumbers).sort((a, b) => a - b);
    expect(expediteurs(scan.clusters)).toEqual(expediteurs(parRangee));
    // Rien ne se perd : la somme des grappes est le nombre de sortants partis.
    expect(scan.clusters.reduce((n, c) => n + c.messages, 0)).toBe(CORPUS.length);
  });

  it("le nombre de groupes grossiers ne descend jamais sous le nombre de gabarits", async () => {
    // Conséquence directe et bon marché de l'invariant : une partition plus
    // fine a forcément au moins autant de classes. Le jour où `scanned` passe
    // sous ce plancher, c'est que la clé SQL a fusionné plus que TypeScript.
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);
    const gabarits = new Set(CORPUS.map((r) => normalizeTemplate(r.body, firstNameOf(r))));
    expect(scan.scanned).toBeGreaterThanOrEqual(gabarits.size);
  });
});

// ── Le plafond de lecture ───────────────────────────────────────────────────

describe("MAX_SCAN_ROWS — l'écran le DIT plutôt que de sous-compter", () => {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
  /**
   * Un mot de six lettres, sans le moindre chiffre. Les chiffres sont
   * justement ce que la clé SQL efface (`[0-9]+` → `~n~`) : numéroter les corps
   * les ferait tous tomber dans le MÊME groupe grossier et le plafond ne serait
   * jamais atteint. Le multiplicateur étale les mots pour éviter des seaux
   * SimHash dégénérés.
   */
  function mot(index: number): string {
    let reste = (index * 2654435761) % 308915776; // 26^6
    let sortie = "";
    for (let i = 0; i < 6; i += 1) {
      sortie += ALPHABET[reste % 26];
      reste = Math.floor(reste / 26);
    }
    return sortie;
  }

  it("au-delà du plafond, truncated passe à vrai et le balayage s'arrête net", async () => {
    // La requête demande `MAX_SCAN_ROWS + 1` groupes exprès : la rangée en trop
    // est la SONDE qui révèle qu'il y en avait davantage. Sans elle, un corpus
    // exactement au plafond serait indiscernable d'un corpus tronqué — et un
    // onglet de conformité qui sous-compte en silence est pire qu'un onglet qui
    // annonce « analyse partielle ».
    const client = await makeClient({ fullName: "Corpus Volumineux", phone: "+14185559999" });
    const conversation = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberA,
    });
    const total = MAX_SCAN_ROWS + 1;
    for (let debut = 0; debut < total; debut += 1000) {
      const lot: (typeof messages.$inferInsert)[] = [];
      for (let i = debut; i < Math.min(debut + 1000, total); i += 1) {
        lot.push({
          conversationId: conversation.id,
          direction: "out",
          body: `Note interne ${mot(i)}`,
          source: "human",
          twilioSid: `SM${i.toString().padStart(32, "0")}`,
          status: "delivered",
          segments: 1,
          encoding: "GSM-7",
          createdAt: SENT_AT,
        });
      }
      await testDb.insert(messages).values(lot);
    }

    const scan = await scanTemplates(RANGE);
    expect(scan.truncated, "le plafond a mordu : l'écran doit le dire").toBe(true);
    expect(scan.scanned, "exactement le plafond de groupes est retenu").toBe(MAX_SCAN_ROWS);
    // Et la rangée-sonde n'est PAS comptée dans les grappes : elle sert à
    // lever le drapeau, pas à gonfler les totaux.
    expect(scan.clusters.reduce((n, c) => n + c.messages, 0)).toBe(MAX_SCAN_ROWS);
  }, 60_000);

  it("sous le plafond, truncated reste faux", async () => {
    await seed(CORPUS);
    const scan = await scanTemplates(RANGE);
    expect(scan.truncated).toBe(false);
    expect(scan.scanned).toBeLessThan(MAX_SCAN_ROWS);
  });
});
