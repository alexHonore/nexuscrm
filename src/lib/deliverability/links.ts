import type { DeepLinkTarget } from "./types";

/**
 * Les liens de correction — le SEUL endroit du dépôt qui écrive une de ces
 * routes. Module PUR : ni Next, ni base, ni environnement.
 *
 * Tout l'écran de délivrabilité tient sur une promesse : « voici ce qui va
 * mal, et voici où le corriger ». Un chemin recopié dans quatre composants
 * tient six mois, puis une route bouge et il reste des boutons qui mènent à
 * une page 404 — sur une surface de conformité, c'est pire que pas de bouton
 * du tout, parce qu'un lien mort laisse croire que le geste a été fait.
 * D'où la cible TYPÉE (`DeepLinkTarget`) et cette fonction unique :
 * `tests/unit-deliverability-links.test.ts` vérifie qu'un `page.tsx` existe
 * bel et bien au bout de chaque chemin écrit ici.
 *
 * Deux règles de refus, et elles disent la même chose : mieux vaut aucun lien
 * qu'un lien qui ment.
 *  · Un identifiant vide rend `null` — `/clients/` n'est pas la fiche du
 *    contact, c'est la liste de tous les contacts.
 *  · Une adresse externe qui n'est pas en `https:` rend `null`. Un lien
 *    profond est une chose sur laquelle l'administrateur CLIQUE : `http:`,
 *    `javascript:` ou `data:` n'ont rien à faire au bout d'un bouton, et la
 *    seule cible externe légitime ici est la console Twilio.
 */

/** Un identifiant utilisable : ni vide, ni fait d'espaces. */
const usableId = (id: string): string | null => {
  const trimmed = id.trim();
  return trimmed.length > 0 ? encodeURIComponent(trimmed) : null;
};

/**
 * Une adresse externe acceptable. `new URL` sert aussi de validation : une
 * chaîne qui n'est pas une adresse lève, et on rend `null` au lieu de poser
 * un `href` cassé dans la page.
 */
function externalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Le chemin prêt à poser dans un `<Link href>`, ou `null` quand il n'y a rien
 * à ouvrir (constat structurel, correction en dehors de l'application).
 *
 * Les onglets ne sont pas encodés : `CampaignTab` et `AssistantTab` sont des
 * unions de littéraux, pas des saisies — encoder « ladder » donnerait
 * « ladder ». Les identifiants, eux, viennent de la base et passent par
 * `encodeURIComponent`.
 */
export function deepLinkFor(target: DeepLinkTarget): string | null {
  switch (target.kind) {
    case "campaign": {
      // `?tab=` est lu par l'éditeur de campagne comme l'éditeur d'assistant
      // le fait déjà. Tant que le paramètre n'est pas branché, l'écran ouvre
      // son premier onglet : le lien reste bon, il est seulement moins précis.
      const id = usableId(target.id);
      return id ? `/admin/campaigns/${id}?tab=${target.tab}` : null;
    }
    case "assistant": {
      const id = usableId(target.id);
      return id ? `/admin/assistants/${id}?tab=${target.tab}` : null;
    }
    case "guardrails":
      // La clé de règle est facultative : sans elle, on ouvre la liste. Une
      // clé inconnue de l'écran ne casse rien — elle est ignorée.
      return target.ruleKey && target.ruleKey.trim().length > 0
        ? `/admin/guardrails?rule=${encodeURIComponent(target.ruleKey.trim())}`
        : "/admin/guardrails";
    case "client": {
      const id = usableId(target.id);
      return id ? `/clients/${id}` : null;
    }
    case "conversation":
      // Il n'existe PAS de route par conversation : `/conversations` est une
      // boîte de réception, et l'ouverture d'un fil passe par la fiche du
      // client (`/clients/<id>`). On rend donc la boîte, jamais
      // `/conversations/<id>`, qui serait un 404 avec l'air d'un lien juste.
      // Le jour où une page par fil existera, ce cas sera le seul à changer.
      return "/conversations";
    case "settings":
      return "/admin/settings";
    case "goLive":
      return "/admin/go-live";
    case "external":
      return externalUrl(target.url);
    case "none":
      return null;
  }
}

/**
 * Vrai quand le lien SORT de l'application.
 *
 * Le composant s'en sert pour marquer le bouton (`target="_blank"`, l'icône
 * de sortie) : quitter le CRM pour la console Twilio est une décision, et
 * l'administrateur doit la voir avant de cliquer, pas après. C'est la NATURE
 * de la cible qui répond, pas la validité de l'adresse — une adresse externe
 * refusée par `deepLinkFor` reste une cible externe, elle n'a simplement plus
 * de lien.
 */
export function isExternal(target: DeepLinkTarget): boolean {
  return target.kind === "external";
}
