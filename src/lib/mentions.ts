/**
 * Les mentions « @collègue » des commentaires internes.
 *
 * Le même texte a DEUX formes, qui ne se mélangent jamais :
 *
 * - la forme STOCKÉE, `@[Nom](uuid)`, écrite dans `comments.body`. C'est elle
 *   que lisent les notifications (`extractMentionIds`, `commentExcerpt`) et le
 *   contexte de l'agent ; elle ne change pas ;
 * - la forme AFFICHÉE, `@Nom`, la seule qu'on voit en écrivant. Le composeur
 *   insérait autrefois le jeton brut, et l'identifiant du collègue s'étalait au
 *   milieu de la phrase. L'identifiant voyage désormais À CÔTÉ du texte
 *   (`MentionRef[]`) et ne le rejoint qu'à l'envoi (`toStoredBody`).
 *
 * Module PUR — ni React, ni base : le composeur et les tests le partagent.
 */

export type MentionRef = { id: string; name: string };

export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; id: string; name: string };

export type MentionRange = { start: number; end: number; ref: MentionRef };

/** Le jeton stocké — même motif que `commentExcerpt`, côté serveur. */
const STORED_TOKEN = /@\[([^\]]+)\]\(([0-9a-fA-F-]{36})\)/g;

/** Ce qui peut précéder un « @ » qui ouvre une mention — sinon c'est une adresse courriel. */
const OPENS_MENTION = /[\s([{.,;:!?]/;

/** Découpe un commentaire stocké en texte et en mentions, pour l'afficher. */
export function parseStoredBody(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let last = 0;
  for (const match of body.matchAll(STORED_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", text: body.slice(last, index) });
    out.push({ kind: "mention", name: match[1], id: match[2] });
    last = index + match[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Les « @Nom » du texte affiché qui désignent ENCORE un collègue choisi.
 *
 * - Le nom le plus long gagne : choisir « Alex » puis « Alex Roy » ne coupe
 *   pas le second en deux.
 * - Le nom finit sur une frontière : « @Alexandre » n'est pas « @Alex ».
 * - Le « @ » ouvre un mot : « info@Alex » est une adresse, pas une mention.
 * - Deux homonymes : le dernier choisi l'emporte. Le texte ne porte pas de
 *   quoi les distinguer, et c'est le plus probable — on vient de le choisir.
 * - Un nom retouché à la main (« @Marie Trembla ») n'est plus une mention :
 *   il redevient du texte, sans notification.
 */
export function mentionRanges(text: string, refs: readonly MentionRef[]): MentionRange[] {
  if (refs.length === 0 || !text.includes("@")) return [];
  const byName = new Map<string, MentionRef>();
  for (const ref of refs) if (ref.name) byName.set(ref.name, ref);
  if (byName.size === 0) return [];
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  const out: MentionRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > 0 && !OPENS_MENTION.test(text[start - 1])) continue;
    const ref = byName.get(match[1]);
    if (ref) out.push({ start, end: start + match[0].length, ref });
  }
  return out;
}

/** Le texte affiché, prêt pour la base : chaque « @Nom » choisi devient `@[Nom](uuid)`. */
export function toStoredBody(text: string, refs: readonly MentionRef[]): string {
  let out = "";
  let last = 0;
  for (const { start, end, ref } of mentionRanges(text, refs)) {
    // Un « ] » dans le nom fermerait le jeton trop tôt.
    out += `${text.slice(last, start)}@[${ref.name.replace(/[[\]]/g, "")}](${ref.id})`;
    last = end;
  }
  return out + text.slice(last);
}

/**
 * La mention en cours de frappe au curseur (« @mar| »), s'il y en a une.
 *
 * Muette sur une mention déjà choisie (`done`) : sans ça, la liste se
 * rouvrait sur « Marie Tremblay » juste après l'avoir insérée.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
  done: readonly MentionRange[] = [],
): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !OPENS_MENTION.test(upToCaret[at - 1])) return null;
  if (done.some((r) => r.start === at)) return null;
  const query = upToCaret.slice(at + 1);
  if (query.length > 30 || /[\n@\]()]/.test(query)) return null;
  return { start: at, query };
}

/**
 * Effacer UN caractère d'une mention l'efface en entier.
 *
 * Sans ça, un Retour arrière laissait « @Marie Trembla » : plus une mention,
 * pas vraiment du texte. On compare les deux valeurs plutôt que d'écouter la
 * touche : les claviers Android n'envoient pas « Backspace ».
 */
export function eraseWholeMention(
  prev: string,
  next: string,
  refs: readonly MentionRef[],
): { text: string; caret: number } | null {
  if (next.length !== prev.length - 1) return null;
  let d = 0;
  while (d < next.length && prev[d] === next[d]) d++;
  if (prev.slice(d + 1) !== next.slice(d)) return null;
  const hit = mentionRanges(prev, refs).find((r) => d >= r.start && d < r.end);
  if (!hit) return null;
  return { text: prev.slice(0, hit.start) + prev.slice(hit.end), caret: hit.start };
}

/** Minuscules sans accents : « hel » trouve « Hélène ». */
export function foldForSearch(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Où la requête tombe dans le nom, pour la mettre en gras. `null` si elle n'y
 * est pas — ou si plier les accents a changé la longueur du nom : les
 * positions ne correspondraient plus aux lettres affichées.
 */
export function searchMatch(name: string, query: string): [number, number] | null {
  const q = foldForSearch(query.trim());
  if (!q) return null;
  const folded = foldForSearch(name);
  const at = folded.indexOf(q);
  if (at === -1 || folded.length !== name.length) return null;
  return [at, at + q.length];
}

/**
 * Les collègues proposés pour « @requête » : ceux dont le NOM commence par la
 * requête, puis ceux dont un MOT commence par elle (« phil » → Jean-Philippe),
 * puis le reste. L'ordre reçu (alphabétique) tient à l'intérieur d'un rang.
 */
export function rankMentionCandidates<T extends MentionRef>(
  users: readonly T[],
  query: string,
  limit = 6,
): T[] {
  const q = foldForSearch(query.trim());
  if (!q) return users.slice(0, limit);
  const scored: { user: T; rank: number }[] = [];
  for (const user of users) {
    const name = foldForSearch(user.name);
    const at = name.indexOf(q);
    if (at === -1) continue;
    scored.push({ user, rank: at === 0 ? 0 : /[\s'’-]/.test(name[at - 1]) ? 1 : 2 });
  }
  return scored
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((s) => s.user);
}
