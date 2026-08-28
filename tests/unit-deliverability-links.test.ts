/**
 * Unitaire — les liens de correction mènent quelque part.
 *
 * Ce que ce fichier empêche : un bouton « Corriger » qui ouvre un 404.
 *
 * Sur n'importe quel autre écran, un lien mort est un désagrément. Sur une
 * surface de conformité, c'est un mensonge : l'opérateur clique, la page ne
 * s'ouvre pas ou s'ouvre vide, il referme — et il repart en croyant que le
 * geste a été fait. Le constat, lui, restera rouge au prochain calcul, sans
 * que personne ne comprenne pourquoi.
 *
 * D'où la vérification qui compte ici, et qui ne peut PAS se faire par le
 * typage : chaque chemin écrit dans `links.ts` est résolu SUR LE DISQUE contre
 * l'arborescence de `src/app`, groupes de routes `(app)` et segments
 * dynamiques `[id]` compris. Une page renommée ou déplacée fait échouer ce
 * test le jour du déplacement, pas six mois plus tard devant un opérateur.
 *
 * Les autres cas défendent la deuxième règle du module, qui dit la même chose
 * autrement : mieux vaut AUCUN lien qu'un lien qui ment. Un identifiant vide
 * ne doit pas fabriquer `/clients/` (la liste de tous les contacts, pas la
 * fiche visée), et rien qui ne soit pas `https:` ne doit finir au bout d'un
 * `href` sur lequel un administrateur va cliquer.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deepLinkFor, isExternal } from "@/lib/deliverability/links";
import { FINDING_DOCS } from "@/lib/deliverability/findings";
import { destinationOf } from "@/lib/deliverability/npa";
import {
  ASSISTANT_TABS,
  CAMPAIGN_TABS,
  FINDING_IDS,
  type DeepLinkKind,
  type DeepLinkTarget,
} from "@/lib/deliverability/types";

const APP_DIR = join(process.cwd(), "src", "app");

/**
 * Vrai quand le chemin d'URL donné aboutit à un `page.tsx` réel.
 *
 * Même marche que `tests/int-rbac.test.ts` sur `route.ts`, à deux nuances
 * près qui sont exactement celles du routeur de Next :
 *  · un dossier `(app)` est un GROUPE — il n'apparaît pas dans l'URL, donc il
 *    se traverse sans consommer de segment ;
 *  · un dossier `[id]` accepte n'importe quel segment.
 * Sans ces deux règles, `/clients/<uuid>` serait déclaré mort alors qu'il vit
 * dans `src/app/(app)/clients/[id]/page.tsx`.
 */
function resolvesToPage(dir: string, segments: string[]): boolean {
  if (segments.length === 0) return existsSync(join(dir, "page.tsx"));
  const [head, ...rest] = segments;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith("(") && name.endsWith(")")) {
      // Groupe de routes : on descend SANS consommer de segment.
      if (resolvesToPage(join(dir, name), segments)) return true;
      continue;
    }
    const dynamic = name.startsWith("[") && name.endsWith("]");
    if (name === head || dynamic) {
      if (resolvesToPage(join(dir, name), rest)) return true;
    }
  }
  return false;
}

/** Le chemin, débarrassé de sa chaîne de requête, résolu sur le disque. */
function pageExists(href: string): boolean {
  const path = href.split("?")[0] ?? "";
  return resolvesToPage(APP_DIR, path.split("/").filter(Boolean));
}

// Des identifiants qui ressemblent aux vrais : la page de campagne comme celle
// d'assistant renvoient `notFound()` sur un segment qui n'est pas un UUID.
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const ASSISTANT_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Une cible par NATURE de cible. Le type `Record<DeepLinkKind, …>` est la
 * moitié la plus utile du test : ajouter une variante à `DeepLinkTarget` sans
 * l'ajouter ici ne compile pas, donc une nouvelle destination ne peut pas
 * entrer dans le produit sans que sa route soit vérifiée.
 */
const TARGETS: Record<DeepLinkKind, DeepLinkTarget> = {
  campaign: { kind: "campaign", id: CAMPAIGN_ID, tab: "ladder" },
  assistant: { kind: "assistant", id: ASSISTANT_ID, tab: "guardrails" },
  guardrails: { kind: "guardrails", ruleKey: "no_price_promise" },
  client: { kind: "client", id: CLIENT_ID },
  conversation: { kind: "conversation", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  settings: { kind: "settings" },
  goLive: { kind: "goLive" },
  external: { kind: "external", url: "https://console.twilio.com" },
  none: { kind: "none" },
};

const ALL_KINDS = Object.keys(TARGETS) as DeepLinkKind[];

// ── Les chemins existent ─────────────────────────────────────────────────────

describe("chaque lien mène à une page qui existe", () => {
  it("le résolveur de routes sait dire non", () => {
    // Un balayage qui répond « oui » à tout rendrait les cas suivants
    // décoratifs : ils passeraient encore le jour où toutes les pages
    // disparaîtraient. On vérifie donc d'abord qu'il sépare vrai et faux.
    expect(pageExists("/admin/deliverability"), "la page de cet écran existe").toBe(true);
    expect(pageExists(`/clients/${CLIENT_ID}`), "le segment dynamique [id] est reconnu").toBe(true);
    expect(pageExists("/admin/page-qui-nexiste-pas")).toBe(false);
    expect(pageExists("/admin/settings/sous-page-imaginaire")).toBe(false);
    // `/admin` n'a pas de page à lui : le groupe (app) ne doit pas faire
    // remonter le `page.tsx` de la racine.
    expect(pageExists("/admin")).toBe(false);
  });

  it("chaque NATURE de cible aboutit à un page.tsx réel", () => {
    const dead: string[] = [];
    for (const kind of ALL_KINDS) {
      const target = TARGETS[kind];
      const href = deepLinkFor(target);
      if (href === null || isExternal(target)) continue;
      if (!pageExists(href)) dead.push(`${kind} → ${href}`);
    }
    expect(dead, `liens morts (aucun page.tsx au bout) :\n  ${dead.join("\n  ")}`).toEqual([]);
  });

  it("chaque constat du catalogue vise une nature de cible connue", () => {
    // Le registre déclare `targetKind` ; si un constat visait une nature que
    // `deepLinkFor` ne sait pas écrire, son bouton n'apparaîtrait jamais —
    // silencieusement, sans erreur, et personne ne le remarquerait.
    const unknown = FINDING_IDS.filter((id) => !ALL_KINDS.includes(FINDING_DOCS[id].targetKind));
    expect(unknown, `constats visant une nature inconnue : ${unknown.join(", ")}`).toEqual([]);
    expect(FINDING_IDS.length, "un catalogue vide validerait n'importe quoi").toBeGreaterThan(20);
  });

  it("aucun lien interne ne sort de l'application par accident", () => {
    // Un chemin qui commence par `//` est protocol-relatif : le navigateur
    // l'envoie vers un AUTRE domaine. Un `href` interne commence par un seul
    // `/`, toujours.
    const offenders: string[] = [];
    for (const kind of ALL_KINDS) {
      const target = TARGETS[kind];
      if (isExternal(target)) continue;
      const href = deepLinkFor(target);
      if (href === null) continue;
      if (!href.startsWith("/") || href.startsWith("//") || href.includes("://")) {
        offenders.push(`${kind} → ${href}`);
      }
    }
    expect(offenders, `chemins internes suspects : ${offenders.join(", ")}`).toEqual([]);
  });

  it("la boîte de réception remplace la page par fil, qui n'existe pas", () => {
    // Il n'y a PAS de `/conversations/<id>` sur le disque. Rendre la boîte est
    // le choix juste : on perd la précision, on ne fabrique pas un 404.
    expect(deepLinkFor(TARGETS.conversation)).toBe("/conversations");
    expect(pageExists("/conversations")).toBe(true);
    expect(
      pageExists("/conversations/cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      "si une page par fil apparaît, ce cas doit être revu",
    ).toBe(false);
  });

  it("les cibles sans identifiant mènent à leur page fixe", () => {
    expect(deepLinkFor({ kind: "settings" })).toBe("/admin/settings");
    expect(deepLinkFor({ kind: "goLive" })).toBe("/admin/go-live");
    expect(deepLinkFor({ kind: "guardrails" })).toBe("/admin/guardrails");
    for (const href of ["/admin/settings", "/admin/go-live", "/admin/guardrails"]) {
      expect(pageExists(href), href).toBe(true);
    }
  });
});

// ── Les onglets ──────────────────────────────────────────────────────────────

/** Les identifiants d'onglets lus dans le VRAI éditeur, pas recopiés. */
function tabIdsIn(file: string, pattern: RegExp): string[] {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    for (const quoted of (match[1] ?? "").matchAll(/"([a-z][a-z0-9_-]*)"/g)) out.push(quoted[1]);
  }
  return out;
}

const CAMPAIGN_EDITOR_TABS = tabIdsIn(
  "src/components/admin/campaign-editor/index.tsx",
  /const TAB_IDS = \[([^\]]*)\]/g,
);
const ASSISTANT_EDITOR_TABS = tabIdsIn(
  "src/components/admin/assistant-editor/index.tsx",
  /tabs: \[([^\]]*)\]/g,
);

describe("les onglets visés existent dans l'éditeur", () => {
  it("les listes sont bien lues dans les éditeurs", () => {
    // Une extraction qui rend un tableau vide ferait passer les deux cas
    // suivants sans rien vérifier — le pire des faux verts.
    expect(CAMPAIGN_EDITOR_TABS.length, "onglets de campagne introuvables").toBeGreaterThan(3);
    expect(ASSISTANT_EDITOR_TABS.length, "onglets d'assistant introuvables").toBeGreaterThan(3);
  });

  it("`?tab=` de campagne est un sous-ensemble des onglets réels", () => {
    // `?tab=inconnu` n'est pas un 404 : l'éditeur ouvre son premier onglet.
    // C'est justement le danger — le lien A L'AIR de marcher, il dépose
    // seulement l'opérateur sur le mauvais écran, et il cherche.
    const strays = CAMPAIGN_TABS.filter((tab) => !CAMPAIGN_EDITOR_TABS.includes(tab));
    expect(strays, `onglets de campagne inexistants : ${strays.join(", ")}`).toEqual([]);
  });

  it("`?tab=` d'assistant est un sous-ensemble des onglets réels", () => {
    const strays = ASSISTANT_TABS.filter((tab) => !ASSISTANT_EDITOR_TABS.includes(tab));
    expect(strays, `onglets d'assistant inexistants : ${strays.join(", ")}`).toEqual([]);
  });

  it("chaque onglet déclaré s'écrit tel quel dans l'adresse", () => {
    // Les onglets sont des littéraux du type, pas une saisie : les encoder
    // n'apporterait rien et rendrait le lien illisible dans la barre
    // d'adresse. Ce cas fige ce choix, et vérifie au passage la forme exacte
    // que l'éditeur d'assistant lit dans `searchParams.tab`.
    for (const tab of CAMPAIGN_TABS) {
      expect(deepLinkFor({ kind: "campaign", id: CAMPAIGN_ID, tab })).toBe(
        `/admin/campaigns/${CAMPAIGN_ID}?tab=${tab}`,
      );
    }
    for (const tab of ASSISTANT_TABS) {
      expect(deepLinkFor({ kind: "assistant", id: ASSISTANT_ID, tab })).toBe(
        `/admin/assistants/${ASSISTANT_ID}?tab=${tab}`,
      );
    }
  });
});

// ── Les identifiants ─────────────────────────────────────────────────────────

describe("un identifiant douteux ne fabrique jamais de chemin", () => {
  it("un identifiant vide ou fait d'espaces rend null", () => {
    // `/clients/` n'est pas la fiche du contact : c'est la liste de TOUS les
    // contacts. Le bouton disparaît, il ne se trompe pas de page.
    for (const id of ["", " ", "\t", "\n  \n"]) {
      expect(deepLinkFor({ kind: "client", id }), `client « ${JSON.stringify(id)} »`).toBeNull();
      expect(deepLinkFor({ kind: "campaign", id, tab: "ladder" }), "campagne").toBeNull();
      expect(deepLinkFor({ kind: "assistant", id, tab: "identity" }), "assistant").toBeNull();
    }
  });

  it("une clé de règle vide ouvre la LISTE des garde-fous, pas un filtre vide", () => {
    // Ici l'identifiant est facultatif : sans lui la page reste juste, elle
    // est seulement moins précise. Rendre `null` priverait l'opérateur d'un
    // lien parfaitement valable.
    expect(deepLinkFor({ kind: "guardrails", ruleKey: "" })).toBe("/admin/guardrails");
    expect(deepLinkFor({ kind: "guardrails", ruleKey: "   " })).toBe("/admin/guardrails");
    expect(deepLinkFor({ kind: "guardrails", ruleKey: " no_price_promise " })).toBe(
      "/admin/guardrails?rule=no_price_promise",
    );
  });

  it("un identifiant vide de FIL rend quand même la boîte de réception", () => {
    // Exception assumée et sûre : l'identifiant du fil n'entre PAS dans le
    // chemin, donc il ne peut pas fabriquer `/conversations/`. Rien à encoder,
    // rien à refuser.
    expect(deepLinkFor({ kind: "conversation", id: "" })).toBe("/conversations");
  });

  it("un identifiant venu de la base est encodé, jamais recopié tel quel", () => {
    // Les identifiants viennent de Postgres. Un jour l'un d'eux portera une
    // barre oblique ou un espace ; recopié tel quel, il inventerait un segment
    // de route — au mieux un 404, au pire une autre page.
    expect(deepLinkFor({ kind: "client", id: "a b/c" })).toBe("/clients/a%20b%2Fc");
    expect(deepLinkFor({ kind: "client", id: "../admin/users" })).toBe(
      "/clients/..%2Fadmin%2Fusers",
    );
    expect(deepLinkFor({ kind: "client", id: "  " + CLIENT_ID + "  " })).toBe(
      `/clients/${CLIENT_ID}`,
    );
    // Une clé de règle passe par le même filtre — elle atterrit dans la
    // requête, où un `&` couperait le paramètre en deux.
    expect(deepLinkFor({ kind: "guardrails", ruleKey: "a&b=c" })).toBe(
      "/admin/guardrails?rule=a%26b%3Dc",
    );
  });
});

// ── Le dehors ────────────────────────────────────────────────────────────────

describe("une seule cible a le droit de sortir de l'application", () => {
  it("`isExternal` est vrai pour EXACTEMENT une nature de cible", () => {
    // Le composant s'en sert pour marquer le bouton (`target="_blank"`,
    // l'icône de sortie). Une deuxième nature devenue « externe » sans être
    // pensée ferait quitter le CRM sans prévenir.
    const external = ALL_KINDS.filter((kind) => isExternal(TARGETS[kind]));
    expect(external).toEqual(["external"]);
  });

  it("une adresse externe refusée reste une cible EXTERNE", () => {
    // C'est la NATURE de la cible qui répond, pas la validité de l'adresse :
    // sinon un lien cassé se déguiserait en lien interne et le bouton perdrait
    // sa marque de sortie au moment précis où elle importe.
    const refused: DeepLinkTarget = { kind: "external", url: "javascript:alert(1)" };
    expect(deepLinkFor(refused)).toBeNull();
    expect(isExternal(refused)).toBe(true);
  });

  it("seul `https:` est accepté", () => {
    expect(deepLinkFor({ kind: "external", url: "https://console.twilio.com" })).toBe(
      // `new URL().toString()` normalise : la racine reçoit sa barre finale.
      "https://console.twilio.com/",
    );
    expect(
      deepLinkFor({
        kind: "external",
        url: "https://console.twilio.com/us1/account/keys-credentials/api-keys",
      }),
    ).toBe("https://console.twilio.com/us1/account/keys-credentials/api-keys");
  });

  it("tout ce qui n'est pas `https:` rend null", () => {
    // `javascript:` au bout d'un `href` s'exécute dans la page : c'est la
    // faille la plus banale qui soit, et un tableau de bord de conformité est
    // le dernier endroit où l'ouvrir. `http:` est refusé aussi — un lien de
    // console qu'on ouvre en clair n'a pas de raison d'exister en 2026.
    for (const url of [
      "http://console.twilio.com",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "//console.twilio.com",
      "console.twilio.com",
      "pas une adresse du tout",
      "",
    ]) {
      expect(deepLinkFor({ kind: "external", url }), `« ${url} » ne doit pas devenir un href`).toBeNull();
    }
  });

  it("« rien à ouvrir » se dit null, pas par un lien vers l'accueil", () => {
    // Un constat structurel se corrige ailleurs (dans Vercel, dans la console
    // Twilio, dans le code). Envoyer l'opérateur sur `/dashboard` « pour ne
    // pas laisser le bouton vide » lui ferait perdre le fil sans rien régler.
    expect(deepLinkFor({ kind: "none" })).toBeNull();
    expect(isExternal({ kind: "none" })).toBe(false);
  });
});

/**
 * Régression — la table des indicatifs canadiens, et ce qui n'est pas une
 * destination du tout.
 *
 * `942` (Toronto) et `257` (Colombie-Britannique) sont en service depuis le
 * 24 mai 2025. Les oublier faisait lire un mobile de Toronto comme un mobile
 * américain — et c'est ce chiffre-là qui décide si le courtier doit s'inquiéter
 * d'une inscription A2P 10DLC qu'il n'a aucune raison de faire.
 */
describe("destinations", () => {
  it("les indicatifs canadiens récents sont reconnus", () => {
    for (const npa of ["942", "257", "263", "418", "514", "581", "819", "873"]) {
      expect(destinationOf(`+1${npa}5550134`), `${npa} est canadien`).toBe("ca");
    }
  });

  it("un mobile américain reste américain", () => {
    for (const npa of ["212", "305", "415", "617"]) {
      expect(destinationOf(`+1${npa}5550134`), `${npa} est américain`).toBe("us");
    }
  });

  it("un numéro sans frais n'est pas « du trafic vers les États-Unis »", () => {
    // Les ranger côté américain gonflait `us_bound_share`, l'indicateur qui
    // déclenche la question de l'inscription A2P — une alerte bâtie sur un
    // numéro qui n'aurait jamais dû être texté.
    for (const npa of ["800", "833", "844", "855", "866", "877", "888", "900", "600"]) {
      expect(destinationOf(`+1${npa}5550134`), `${npa} est un service`).toBe("service");
    }
  });

  it("hors du plan nord-américain, c'est international ; sinon, inconnu", () => {
    expect(destinationOf("+33612345678")).toBe("intl");
    expect(destinationOf("+441234567890")).toBe("intl");
    expect(destinationOf(null)).toBe("unknown");
    expect(destinationOf("")).toBe("unknown");
    expect(destinationOf("+1")).toBe("unknown");
    expect(destinationOf("4185550134")).toBe("unknown");
  });
});
