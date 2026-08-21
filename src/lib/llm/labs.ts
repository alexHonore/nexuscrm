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
 *
 * Aucune phrase d'interface ici : la note d'un laboratoire (« ce qu'il vaut
 * pour notre usage ») vit dans `messages/<locale>/assistants.json` sous
 * `model.labNote.<noteKey>` — sinon un administrateur anglophone lisait des
 * notes en français.
 */

export interface LabBrand {
  id: string;
  name: string;
  /** Couleur de la maison — sert au fond de la tuile et à l'accent. */
  color: string;
  /** Clé i18n de la note, sous `assistants.model.labNote.*`. */
  noteKey: string;
  /** Glyphe géométrique, tracé dans une boîte 24×24. */
  glyph: "burst" | "orbit" | "quad" | "loop" | "bars" | "wave" | "cross" | "spark" | "hex";
}

/** Laboratoires reconnus, par préfixe d'identifiant OpenRouter. */
export const LABS: Record<string, LabBrand> = {
  anthropic: { id: "anthropic", name: "Anthropic", color: "#CC785C", noteKey: "anthropic", glyph: "burst" },
  openai: { id: "openai", name: "OpenAI", color: "#10A37F", noteKey: "openai", glyph: "orbit" },
  google: { id: "google", name: "Google", color: "#4285F4", noteKey: "google", glyph: "quad" },
  "meta-llama": { id: "meta-llama", name: "Meta", color: "#0866FF", noteKey: "meta-llama", glyph: "loop" },
  mistralai: { id: "mistralai", name: "Mistral", color: "#FA520F", noteKey: "mistralai", glyph: "bars" },
  deepseek: { id: "deepseek", name: "DeepSeek", color: "#4D6BFE", noteKey: "deepseek", glyph: "wave" },
  "x-ai": { id: "x-ai", name: "xAI", color: "#111111", noteKey: "x-ai", glyph: "cross" },
  qwen: { id: "qwen", name: "Qwen", color: "#615CED", noteKey: "qwen", glyph: "hex" },
  moonshotai: { id: "moonshotai", name: "Moonshot", color: "#16B364", noteKey: "moonshotai", glyph: "spark" },
  "z-ai": { id: "z-ai", name: "Z.ai", color: "#3859FF", noteKey: "z-ai", glyph: "hex" },
  amazon: { id: "amazon", name: "Amazon", color: "#FF9900", noteKey: "amazon", glyph: "spark" },
  nvidia: { id: "nvidia", name: "NVIDIA", color: "#76B900", noteKey: "nvidia", glyph: "quad" },
  minimax: { id: "minimax", name: "MiniMax", color: "#FF4D4F", noteKey: "minimax", glyph: "spark" },
  "bytedance-seed": {
    id: "bytedance-seed",
    name: "ByteDance",
    color: "#325AB4",
    noteKey: "bytedance-seed",
    glyph: "hex",
  },
  perplexity: { id: "perplexity", name: "Perplexity", color: "#20808D", noteKey: "perplexity", glyph: "orbit" },
  cohere: { id: "cohere", name: "Cohere", color: "#39594D", noteKey: "cohere", glyph: "bars" },
  tencent: { id: "tencent", name: "Tencent", color: "#0052D9", noteKey: "tencent", glyph: "loop" },
  nousresearch: {
    id: "nousresearch",
    name: "Nous Research",
    color: "#8B5CF6",
    noteKey: "nousresearch",
    glyph: "spark",
  },
  openrouter: { id: "openrouter", name: "OpenRouter", color: "#6467F2", noteKey: "openrouter", glyph: "cross" },
};

/**
 * Préfixes qui désignent la MÊME maison.
 *
 * OpenRouter préfixe d'un « ~ » ses espaces de noms d'alias flottants, et
 * publie certaines gammes sous deux préfixes. Sans cette table, Anthropic
 * apparaît DEUX FOIS dans l'entonnoir : une tuile à sa couleur, une tuile
 * grise « ~anthropic ».
 */
const LAB_ALIASES: Record<string, string> = {
  "~anthropic": "anthropic",
  "~openai": "openai",
  "~google": "google",
  meta: "meta-llama",
};

/** Laboratoire inconnu : gris neutre plutôt qu'une couleur inventée. */
export const UNKNOWN_LAB: LabBrand = {
  id: "autre",
  name: "Autre",
  color: "#64748B",
  noteKey: "autre",
  glyph: "hex",
};

/** Le préfixe d'un identifiant OpenRouter — « anthropic/claude-… » → anthropic. */
export function labIdOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash === -1) return "autre";
  const prefix = modelId.slice(0, slash);
  return LAB_ALIASES[prefix] ?? prefix;
}

/**
 * Un identifiant qui pointe vers « la dernière version » plutôt que vers une
 * version précise.
 *
 * Ce n'est pas interdit, c'est SIGNALÉ : le modèle derrière l'alias change
 * sans prévenir, et un assistant dont le prompt et les garde-fous ont été
 * réglés sur un modèle donné peut se mettre à répondre autrement du jour au
 * lendemain, sans qu'aucune configuration n'ait bougé.
 */
export function isFloatingAlias(modelId: string): boolean {
  return modelId.startsWith("~") || /-latest(:|$)/.test(modelId) || /^openrouter\//.test(modelId);
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
