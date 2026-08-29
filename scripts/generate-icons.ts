/**
 * Fabrique les icônes de marque de l'application installable (PWA).
 *
 * Pourquoi un script plutôt que des fichiers binaires versionnés à la main :
 * le seul « logo » du produit est un carré arrondi dégradé portant un N, écrit
 * en CSS dans `src/app/(auth)/auth-card.tsx`. Tant que la marque tient en une
 * poignée de nombres, la source de vérité doit rester du texte relisible ;
 * régénérer vaut mieux que redessiner, et un changement de teinte se relit
 * dans un diff.
 *
 * Pourquoi tout est écrit ici, y compris l'encodeur PNG : `package.json` est
 * gelé (règle 7) et aucune bibliothèque d'image n'est installée. Un PNG en
 * couleurs vraies n'est pourtant qu'un en-tête, un zlib et un CRC — `node:zlib`
 * suffit. Le rendu se fait à quatre fois la taille finale puis se réduit par
 * moyenne : l'anticrénelage sort de la réduction, on n'a donc jamais à écrire
 * de code de couverture partielle.
 *
 * Les couleurs sont les jetons `--sidebar-primary` et `--primary` de
 * `globals.css` (oklch(0.55 0.13 255) et oklch(0.38 0.1 255)), soit #3772BB et
 * #174276. Le dégradé s'interpole en OKLab, comme le fait Tailwind v4 : sur
 * deux bleus de même teinte cela évite le creux de saturation du sRGB.
 *
 * Usage : pnpm tsx scripts/generate-icons.ts
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/* ────────────────────────────── Couleur ────────────────────────────── */

type Rgb = readonly [number, number, number];
type OkLab = readonly [number, number, number];

/** Bornes du dégradé de la tuile — les deux jetons de marque, en clair. */
const BRAND_TOP = "#3772BB";
const BRAND_BOTTOM = "#174276";
const WHITE: Rgb = [255, 255, 255];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function hexToOkLab(hex: string): OkLab {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const r = srgbToLinear((n >> 16) & 0xff);
  const g = srgbToLinear((n >> 8) & 0xff);
  const b = srgbToLinear(n & 0xff);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function okLabToRgb(lab: OkLab): Rgb {
  const [L, A, B] = lab;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function mixOkLab(from: OkLab, to: OkLab, t: number): OkLab {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/* ───────────────────────────── Surface ─────────────────────────────── */

interface Surface {
  readonly w: number;
  readonly h: number;
  /** RGBA non prémultiplié. À l'échelle du suréchantillonnage, alpha ne vaut que 0 ou 255. */
  readonly px: Uint8Array;
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

function createSurface(w: number, h: number): Surface {
  return { w, h, px: new Uint8Array(w * h * 4) };
}

function setPixel(s: Surface, x: number, y: number, rgb: Rgb): void {
  const i = (y * s.w + x) * 4;
  s.px[i] = rgb[0];
  s.px[i + 1] = rgb[1];
  s.px[i + 2] = rgb[2];
  s.px[i + 3] = 255;
}

/**
 * Remplit une bande horizontale entre deux abscisses réelles. La convention est
 * celle du centre de pixel : le pixel x appartient à la bande si x+0.5 y tombe.
 */
function span(s: Surface, y: number, xMin: number, xMax: number, rgb: Rgb): void {
  if (y < 0 || y >= s.h || xMax < xMin) return;
  const from = Math.max(0, Math.ceil(xMin - 0.5));
  const to = Math.min(s.w - 1, Math.floor(xMax - 0.5));
  for (let x = from; x <= to; x++) setPixel(s, x, y, rgb);
}

/**
 * Remplissage d'un polygone CONVEXE par balayage. Sur un convexe, la ligne de
 * centre ne coupe le contour qu'en deux points : le minimum et le maximum des
 * intersections suffisent, sans avoir à trier ni à compter les parités.
 */
function fillConvex(s: Surface, pts: readonly Pt[], rgb: Rgb): void {
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of pts) {
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  const yFrom = Math.max(0, Math.floor(top));
  const yTo = Math.min(s.h - 1, Math.ceil(bottom));
  for (let y = yFrom; y <= yTo; y++) {
    const yc = y + 0.5;
    let xMin = Infinity;
    let xMax = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        const x = a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
    if (xMin <= xMax) span(s, y, xMin, xMax, rgb);
  }
}

/**
 * Tuile de fond : un carré à coins arrondis (rayon nul = plein cadre) rempli
 * d'un dégradé vertical. Le rayon se calcule ligne par ligne sur le cercle de
 * coin, ce qui donne un arc exact ; le crénelage est réglé par la réduction.
 */
function fillTile(s: Surface, radius: number, topColor: OkLab, bottomColor: OkLab): void {
  for (let y = 0; y < s.h; y++) {
    const yc = y + 0.5;
    let inset = 0;
    if (radius > 0) {
      const dy = yc < radius ? radius - yc : yc > s.h - radius ? yc - (s.h - radius) : 0;
      if (dy > 0) inset = radius - Math.sqrt(Math.max(0, radius * radius - dy * dy));
    }
    const rgb = okLabToRgb(mixOkLab(topColor, bottomColor, yc / s.h));
    span(s, y, inset, s.w - inset, rgb);
  }
}

/* ─────────────────────────────── Le N ──────────────────────────────── */

/*
 * Le N du produit est un caractère gras de 20 px centré dans une pastille de
 * 56 px. On n'en garde pas la taille — perdue à l'échelle d'une icône — mais
 * les PROPORTIONS : une lettre presque aussi large que haute, un fût d'environ
 * un cinquième de la hauteur de capitale. Le tout est construit en trois
 * quadrilatères, sans police : trois nombres suffisent à décrire un N, et un
 * fichier de fonte n'aurait pas sa place dans le dépôt pour trois traits.
 */
/**
 * Largeur de la lettre rapportée à sa hauteur de capitale. Un N gras de
 * grotesque tourne autour de 0.87 ; on reste un peu au-dessus parce que cette
 * lettre-ci doit encore se lire à 32 px, taille à laquelle les contrepoints
 * d'un N trop étroit se bouchent.
 */
const N_WIDTH = 0.92;
/** Épaisseur des deux fûts verticaux, rapportée à la hauteur — c'est le gras. */
const N_STEM = 0.2;
/**
 * Largeur HORIZONTALE de l'oblique — mesurée à plat sur une barre penchée,
 * elle vaut donc bien plus que son épaisseur réelle : perpendiculairement,
 * 0.248 rend 1.03 fois le fût. Une oblique mathématiquement égale au fût
 * paraît plus MAIGRE que lui, parce qu'elle court plus long ; on la charge
 * légèrement pour qu'elle pèse le même poids à l'œil.
 */
const N_DIAGONAL = 0.248;

/** Les trois quadrilatères du N, centrés sur (cx, cy) pour une hauteur donnée. */
function nQuads(cx: number, cy: number, height: number): readonly (readonly Pt[])[] {
  const w = height * N_WIDTH;
  const stem = height * N_STEM;
  const diag = height * N_DIAGONAL;
  const left = cx - w / 2;
  const right = cx + w / 2;
  const top = cy - height / 2;
  const bottom = cy + height / 2;
  return [
    // Fût gauche.
    [
      { x: left, y: top },
      { x: left + stem, y: top },
      { x: left + stem, y: bottom },
      { x: left, y: bottom },
    ],
    // Fût droit.
    [
      { x: right - stem, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: right - stem, y: bottom },
    ],
    // Oblique : elle part du bord EXTÉRIEUR gauche en haut et rejoint le bord
    // extérieur droit en bas, si bien que les deux jonctions sont pleines et
    // qu'aucun angle rentrant ne vient trouer la lettre.
    [
      { x: left, y: top },
      { x: left + diag, y: top },
      { x: right, y: bottom },
      { x: right - diag, y: bottom },
    ],
  ];
}

/* ────────────────────────── Suréchantillonnage ─────────────────────── */

/** Facteur linéaire : 4 signifie 16 échantillons par pixel final. */
const SUPERSAMPLE = 4;

/**
 * Réduction en alpha PRÉMULTIPLIÉ. C'est ce qui sauve la pastille de
 * notification : moyenner les canaux RVB d'échantillons transparents y
 * déposerait un liseré sombre autour du glyphe blanc, puisque le « rien »
 * transparent est encodé (0,0,0,0). Pondérer chaque couleur par son alpha rend
 * les pixels vides muets ; là où tout est vide, on retombe sur `clear`.
 */
function downsample(src: Surface, factor: number, clear: Rgb): Uint8Array {
  const w = src.w / factor;
  const h = src.h / factor;
  const out = new Uint8Array(w * h * 4);
  const samples = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.w + (x * factor + dx)) * 4;
          const a = src.px[i + 3];
          sr += src.px[i] * a;
          sg += src.px[i + 1] * a;
          sb += src.px[i + 2] * a;
          sa += a;
        }
      }
      const o = (y * w + x) * 4;
      if (sa === 0) {
        out[o] = clear[0];
        out[o + 1] = clear[1];
        out[o + 2] = clear[2];
        out[o + 3] = 0;
      } else {
        out[o] = Math.round(sr / sa);
        out[o + 1] = Math.round(sg / sa);
        out[o + 2] = Math.round(sb / sa);
        out[o + 3] = Math.round(sa / samples);
      }
    }
  }
  return out;
}

/* ───────────────────────────── Encodeur PNG ────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * PNG 8 bits RGBA, non entrelacé, une seule ligne de filtre 0 (« None »). Les
 * filtres prédictifs feraient gagner quelques octets sur une photo ; sur des
 * aplats et un dégradé vertical ils n'apportent rien que zlib ne trouve déjà,
 * et ils coûteraient un décodeur plus long dans la vérification ci-dessous.
 */
function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 6; // type couleur : vraies couleurs + alpha
  ihdr[10] = 0; // compression deflate
  ihdr[11] = 0; // filtrage adaptatif standard
  ihdr[12] = 0; // pas d'entrelacement
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly px: Uint8Array;
}

/**
 * Décodeur de contrôle. Il ne sait relire que ce que l'encodeur ci-dessus
 * produit — et c'est le but : on ne vérifie pas la conformité du PNG en
 * général, on vérifie que le fichier posé sur le disque contient bien l'image
 * qu'on croyait y écrire.
 */
function decodePng(file: Buffer): DecodedPng {
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("signature PNG absente");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("latin1");
    const data = file.subarray(offset + 8, offset + 8 + length);
    const expected = file.readUInt32BE(offset + 8 + length);
    if (crc32(file.subarray(offset + 4, offset + 8 + length)) !== expected) {
      throw new Error(`CRC invalide sur le bloc ${type}`);
    }
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("format PNG inattendu");
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`ligne ${y} : filtre ${filter} inattendu`);
    px.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, px };
}

/* ──────────────────────────── Les variantes ────────────────────────── */

/*
 * Rayon de la tuile : `rounded-2xl` (16 px) sur `size-14` (56 px) dans
 * auth-card.tsx, soit 2/7 du côté. On garde le rapport, pas le pixel.
 */
const TILE_RADIUS = 16 / 56;

/*
 * Hauteur du N rapportée au côté de l'icône, par famille :
 *
 * — 0.52 en plein carré : à l'échelle d'une icône, le glyphe de 20 px dans 56
 *   qu'affiche la carte d'authentification (25 %) serait perdu ; une lettre qui
 *   occupe un peu plus de la moitié du carré est la proportion habituelle d'une
 *   icône d'application, et elle tient le coup à 32 px.
 * — 0.44 en masquable : le système recadre lui-même, et la seule zone garantie
 *   est un cercle de 80 % du côté. Rapporté à ce cercle, 0.44 rend la même
 *   présence que 0.52 dans le carré entier, tout en laissant la diagonale de la
 *   lettre (0.30 du côté depuis le centre) loin des 0.40 du bord.
 * — 0.62 pour la pastille : elle est rendue à 24 dp dans la barre d'état, en
 *   monochrome, sans fond pour la porter. Elle doit remplir.
 */
const GLYPH_FULL = 0.52;
const GLYPH_MASKABLE = 0.44;
const GLYPH_BADGE = 0.62;

interface Variant {
  /** Chemin relatif à `public/`. */
  readonly path: string;
  readonly size: number;
  /** Fond dégradé, ou glyphe seul sur transparent. */
  readonly tile: boolean;
  /** Rayon des coins, en fraction du côté. */
  readonly radius: number;
  /** Hauteur de capitale, en fraction du côté. */
  readonly glyph: number;
  /** Ce que doit valoir l'alpha du pixel de coin — vérifié après écriture. */
  readonly cornerAlpha: 0 | 255;
}

const VARIANTS: readonly Variant[] = [
  // `purpose: "any"` — la tuile arrondie, telle quelle, sans masque système.
  { path: "icons/icon-192.png", size: 192, tile: true, radius: TILE_RADIUS, glyph: GLYPH_FULL, cornerAlpha: 0 },
  { path: "icons/icon-512.png", size: 512, tile: true, radius: TILE_RADIUS, glyph: GLYPH_FULL, cornerAlpha: 0 },
  // `purpose: "maskable"` — coins CARRÉS : le système pose son propre masque,
  // et des coins déjà arrondis en dessous se verraient comme un double arrondi.
  { path: "icons/icon-maskable-192.png", size: 192, tile: true, radius: 0, glyph: GLYPH_MASKABLE, cornerAlpha: 255 },
  { path: "icons/icon-maskable-512.png", size: 512, tile: true, radius: 0, glyph: GLYPH_MASKABLE, cornerAlpha: 255 },
  // Pastille de notification : Android n'en retient QUE le canal alpha et
  // repeint le reste. Tout dégradé y serait perdu ; on ne livre que la forme.
  { path: "icons/badge-96.png", size: 96, tile: false, radius: 0, glyph: GLYPH_BADGE, cornerAlpha: 0 },
  // iOS : plein cadre et surtout OPAQUE — un apple-touch-icon transparent
  // s'affiche sur du noir, l'appareil n'aplatit rien.
  { path: "apple-touch-icon.png", size: 180, tile: true, radius: 0, glyph: GLYPH_FULL, cornerAlpha: 255 },
];

function render(variant: Variant): Uint8Array {
  const s = variant.size * SUPERSAMPLE;
  const surface = createSurface(s, s);
  if (variant.tile) {
    fillTile(surface, variant.radius * s, hexToOkLab(BRAND_TOP), hexToOkLab(BRAND_BOTTOM));
  }
  for (const quad of nQuads(s / 2, s / 2, variant.glyph * s)) {
    fillConvex(surface, quad, WHITE);
  }
  // Là où rien n'est dessiné, la couleur retenue est le blanc du glyphe : le
  // bord anticrénelé de la pastille s'éteint alors en alpha sans virer au gris.
  return downsample(surface, SUPERSAMPLE, WHITE);
}

/* ─────────────────────────────── Sortie ────────────────────────────── */

function alphaAt(png: DecodedPng, x: number, y: number): number {
  return png.px[(y * png.width + x) * 4 + 3];
}

function rgbAt(png: DecodedPng, x: number, y: number): Rgb {
  const i = (y * png.width + x) * 4;
  return [png.px[i], png.px[i + 1], png.px[i + 2]];
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const root = process.cwd();
  if (!existsSync(join(root, "package.json"))) {
    throw new Error("à lancer depuis la racine du dépôt : pnpm tsx scripts/generate-icons.ts");
  }
  const publicDir = join(root, "public");
  mkdirSync(join(publicDir, "icons"), { recursive: true });

  for (const variant of VARIANTS) {
    const target = join(publicDir, variant.path);
    writeFileSync(target, encodePng(variant.size, variant.size, render(variant)));

    // On relit le fichier écrit plutôt que le tampon en mémoire : c'est le
    // seul moyen de savoir que l'encodeur, et pas seulement le rasteur, a fait
    // son travail.
    const png = decodePng(readFileSync(target));
    const last = variant.size - 1;
    assert(png.width === variant.size && png.height === variant.size, `${variant.path} : dimensions ${png.width}×${png.height}`);
    for (const [x, y] of [
      [0, 0],
      [last, 0],
      [0, last],
      [last, last],
    ] as const) {
      assert(
        alphaAt(png, x, y) === variant.cornerAlpha,
        `${variant.path} : coin (${x},${y}) alpha ${alphaAt(png, x, y)}, attendu ${variant.cornerAlpha}`,
      );
    }
    // Le centre exact du carré tombe sur l'oblique du N : il est blanc et opaque
    // dans toutes les variantes. C'est le contrôle qui attrape un glyphe absent.
    const centre = Math.floor(variant.size / 2);
    assert(alphaAt(png, centre, centre) === 255, `${variant.path} : centre transparent`);
    assert(
      rgbAt(png, centre, centre).every((c) => c >= 250),
      `${variant.path} : centre non blanc (${rgbAt(png, centre, centre).join(",")})`,
    );
    if (!variant.tile) {
      // Pastille : rien d'autre que du blanc, sinon Android en tirerait une
      // silhouette différente de celle qu'on voit ici.
      for (let i = 0; i < png.px.length; i += 4) {
        if (png.px[i + 3] === 0) continue;
        assert(png.px[i] >= 250 && png.px[i + 1] >= 250 && png.px[i + 2] >= 250, `${variant.path} : pixel non blanc`);
      }
    }
    if (variant.cornerAlpha === 255 && !variant.path.startsWith("icons/")) {
      // apple-touch-icon : PAS un seul pixel translucide, nulle part.
      for (let i = 3; i < png.px.length; i += 4) {
        assert(png.px[i] === 255, `${variant.path} : pixel translucide`);
      }
    }
    console.log(`${variant.path.padEnd(30)} ${String(statSync(target).size).padStart(7)} o  ${variant.size}×${variant.size}  ✓`);
  }
}

main();
