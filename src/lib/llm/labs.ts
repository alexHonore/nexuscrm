/**
 * Identité visuelle des laboratoires d'IA — module PUR.
 *
 * Choisir un modèle dans une liste de 350 identifiants techniques
 * (`anthropic/claude-sonnet-5`, `google/gemini-3.7-flash`…) demande de savoir
 * d'avance ce qu'on cherche. On passe donc par le LABORATOIRE d'abord : c'est
 * la seule chose qu'un utilisateur reconnaît sans effort, par sa couleur et son
 * nom.
 *
 * Les marques sont dessinées EN LIGNE, en SVG géométrique aux couleurs de
 * chaque maison. Pas de fichier distant, pas de dépendance nouvelle, et aucune
 * imitation approximative d'un logo déposé : la reconnaissance vient de la
 * couleur et du nom, qui suffisent.
 */

export interface LabBrand {
  id: string;
  name: string;
  /** Couleur de la maison — sert au fond de la tuile et à l'accent. */
  color: string;
  /** Ce que ce laboratoire vaut pour NOTRE usage, en une phrase. */
  noteFr: string;
  /** Glyphe géométrique, tracé dans une boîte 24×24. */
  glyph: "burst" | "orbit" | "quad" | "loop" | "bars" | "wave" | "cross" | "spark" | "hex";
}

/** Laboratoires reconnus, par préfixe d'identifiant OpenRouter. */
export const LABS: Record<string, LabBrand> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    color: "#CC785C",
    noteFr: "Suit les consignes longues avec constance — le meilleur choix quand les garde-fous comptent.",
    glyph: "burst",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    color: "#10A37F",
    noteFr: "Très large gamme, du plus économique au plus capable.",
    glyph: "orbit",
  },
  google: {
    id: "google",
    name: "Google",
    color: "#4285F4",
    noteFr: "Rapide et peu coûteux — souvent le bon choix pour le classifieur.",
    glyph: "quad",
  },
  "meta-llama": {
    id: "meta-llama",
    name: "Meta",
    color: "#0866FF",
    noteFr: "Modèles ouverts, hébergés par plusieurs fournisseurs.",
    glyph: "loop",
  },
  mistralai: {
    id: "mistralai",
    name: "Mistral",
    color: "#FA520F",
    noteFr: "Maison française, bon en français — à essayer pour le ton québécois.",
    glyph: "bars",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    color: "#4D6BFE",
    noteFr: "Très bon rapport qualité-prix sur le raisonnement.",
    glyph: "wave",
  },
  "x-ai": {
    id: "x-ai",
    name: "xAI",
    color: "#111111",
    noteFr: "Modèles Grok.",
    glyph: "cross",
  },
  qwen: {
    id: "qwen",
    name: "Qwen",
    color: "#615CED",
    noteFr: "Gamme ouverte très fournie, souvent économique.",
    glyph: "hex",
  },
  moonshotai: {
    id: "moonshotai",
    name: "Moonshot",
    color: "#16B364",
    noteFr: "Modèles Kimi, longues fenêtres de contexte.",
    glyph: "spark",
  },
  "z-ai": { id: "z-ai", name: "Z.ai", color: "#3859FF", noteFr: "Modèles GLM.", glyph: "hex" },
  amazon: { id: "amazon", name: "Amazon", color: "#FF9900", noteFr: "Modèles Nova.", glyph: "spark" },
  nvidia: { id: "nvidia", name: "NVIDIA", color: "#76B900", noteFr: "Modèles Nemotron.", glyph: "quad" },
  minimax: { id: "minimax", name: "MiniMax", color: "#FF4D4F", noteFr: "Modèles MiniMax.", glyph: "spark" },
  "bytedance-seed": {
    id: "bytedance-seed",
    name: "ByteDance",
    color: "#325AB4",
    noteFr: "Modèles Seed.",
    glyph: "hex",
  },
};

/** Laboratoire inconnu : gris neutre plutôt qu'une couleur inventée. */
export const UNKNOWN_LAB: LabBrand = {
  id: "autre",
  name: "Autre",
  color: "#64748B",
  noteFr: "Laboratoire non répertorié.",
  glyph: "hex",
};

/** Le préfixe d'un identifiant OpenRouter — « anthropic/claude-… » → anthropic. */
export function labIdOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? "autre" : modelId.slice(0, slash);
}

export function labOf(modelId: string): LabBrand {
  return LABS[labIdOf(modelId)] ?? { ...UNKNOWN_LAB, id: labIdOf(modelId), name: labIdOf(modelId) };
}

/**
 * Un modèle utilisable pour une conversation SMS.
 *
 * Les variantes `:batch` sont ÉCARTÉES : elles s'exécutent en différé, parfois
 * des heures plus tard. Les proposer dans un sélecteur pour un assistant qui
 * répond à un client serait un piège — moins cher à l'affichage, inutilisable
 * en pratique. Idem pour `:free`, dont les quotas coupent sans prévenir.
 */
export function isInteractiveModel(modelId: string): boolean {
  return !modelId.includes(":batch") && !modelId.includes(":free");
}
