/**
 * Unitaire — l'ossature de l'application INSTALLÉE.
 *
 * Ce que ces tests protègent : chacune des pannes ci-dessous est SILENCIEUSE.
 * Un manifeste renvoyé vers /login ne produit pas d'erreur — le navigateur
 * cesse simplement de proposer l'installation. Un service worker redirigé ne
 * lève pas — `register()` échoue et il n'y a plus de notifications. Une
 * `viewport-fit` absente n'affiche rien de travers en développement — c'est
 * l'iPhone du téléphoniste qui pose la barre de navigation sous la barre de
 * geste. Aucune de ces trois régressions ne se verrait en relisant un diff.
 *
 * Tout se lit sur le TEXTE des fichiers plutôt que par exécution : vitest tourne
 * en environnement « node », sans jsdom (et package.json est gelé), donc ni
 * `navigator`, ni `window`, ni service worker ne peuvent être instanciés ici.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { afterLoginPath, safeNextPath } from "@/lib/auth/next-path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("le proxy laisse passer ce que l'installation exige", () => {
  const source = read("src/proxy.ts");

  // Le navigateur demande le manifeste SANS identifiants (Next ne pose
  // `crossorigin="use-credentials"` qu'en pré-production) : sans exemption, il
  // reçoit la page de connexion et l'annonce comme « Unexpected token < ».
  it.each(["/manifest.webmanifest", "/manifest.json", "/sw.js", "/offline"])(
    "%s est public",
    (path) => {
      expect(source).toContain(`"${path}"`);
    },
  );

  it("garde la destination quand la session a expiré", () => {
    // La valeur d'une notification tient dans « CE client-là ». Le proxy
    // effaçait la barre d'adresse en redirigeant : la fiche était perdue.
    expect(source).toContain('url.searchParams.set("next"');
    expect(source).toContain("request.nextUrl.search");
  });

  it("continue de renvoyer vers /login sans cookie", () => {
    expect(source).toContain('request.cookies.has("nexus_session")');
    expect(source).toContain("NextResponse.redirect");
  });
});

describe("la destination retenue ne peut pas mener ailleurs", () => {
  it("accepte un chemin relatif à nous", () => {
    expect(safeNextPath("/clients/0b7f2e10-1c3a-4f5b-9d2e-8a1c4b6d7e90")).toBe(
      "/clients/0b7f2e10-1c3a-4f5b-9d2e-8a1c4b6d7e90",
    );
    expect(safeNextPath("/conversations?tab=attention")).toBe("/conversations?tab=attention");
    // Le tiret est banal dans un UUID : une classe de caractères de contrôle
    // écrite en littéraux l'avait un temps rejeté, ce qui privait de sa fiche
    // exactement la notification qu'on venait d'ouvrir.
    expect(safeNextPath("/admin/import-export")).toBe("/admin/import-export");
  });

  it.each([
    ["https://evil.example", "adresse absolue"],
    ["//evil.example", "double barre — absolue pour le navigateur"],
    ["/\\evil.example", "barre inversée — absolue elle aussi"],
    ["javascript:alert(1)", "schéma exécutable"],
    ["/login", "boucle sur elle-même"],
    ["/login?next=/x", "la même boucle, déguisée"],
  ])("refuse %s (%s)", (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it("refuse une injection d'en-tête", () => {
    expect(safeNextPath("/clients\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeNextPath("/clients\nX: y")).toBeNull();
  });

  it("retombe sur le tableau de bord plutôt que sur rien", () => {
    expect(afterLoginPath(null)).toBe("/dashboard");
    expect(afterLoginPath("https://evil.example")).toBe("/dashboard");
  });
});

describe("le manifeste rend l'application installable", () => {
  const m = manifest();

  it("déclare le mode autonome — sans quoi iOS n'expose PAS l'API Push", () => {
    expect(m.display).toBe("standalone");
    expect(m.scope).toBe("/");
  });

  it("épingle un identifiant distinct du point de départ", () => {
    // Sans `id`, changer `start_url` un jour ferait apparaître une SECONDE
    // icône sur les téléphones déjà équipés.
    expect(m.id).toBeTruthy();
    expect(m.id).not.toBe(m.start_url);
  });

  it("ne démarre pas sur la page vitrine", () => {
    // « / » est publique et montre du marketing : ouvrir son outil de travail
    // là-dessus est le premier signal qu'on a installé un site, pas une app.
    expect(m.start_url).toContain("/dashboard");
  });

  it("porte les deux tailles exigées et une icône masquable", () => {
    const icons = m.icons ?? [];
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("accorde sa couleur de thème avec celle du document", () => {
    // Android peint l'une dans le sélecteur de tâches et l'autre dans la barre
    // d'adresse : deux teintes différentes se voient immédiatement.
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain(String(m.theme_color));
  });
});

describe("le document se comporte comme une application", () => {
  const layout = read("src/app/layout.tsx");

  it("déclare viewport-fit=cover", () => {
    // SANS lui, toutes les valeurs env(safe-area-inset-*) valent zéro — et
    // .pb-safe / .h-bottom-nav (globals.css, gelé) sont du code mort.
    expect(layout).toMatch(/viewportFit:\s*"cover"/);
  });

  it("ne bloque plus le zoom", () => {
    // maximum-scale=1 est un échec WCAG 1.4.4 ; en plein écran, sans barre de
    // navigateur, c'est la seule façon d'agrandir un numéro de téléphone.
    // On cherche l'AFFECTATION, pas le mot : le commentaire qui explique le
    // retrait le nomme forcément, et un test qui interdit d'en parler pousse à
    // supprimer l'explication plutôt que la faute.
    expect(layout).not.toMatch(/^\s*maximumScale\s*:/m);
    expect(layout).not.toMatch(/userScalable\s*:\s*false/);
  });

  it("laisse le clavier repousser le contenu", () => {
    expect(layout).toMatch(/interactiveWidget:\s*"resizes-content"/);
  });

  it("déclare le manifeste et l'icône que iOS lit vraiment", () => {
    expect(layout).toContain("/manifest.webmanifest");
    // iOS ignore le tableau `icons` du manifeste et prend apple-touch-icon.
    expect(layout).toContain("/apple-touch-icon.png");
    expect(layout).toContain("appleWebApp");
  });

  it("coupe le chaînage du geste de rechargement", () => {
    expect(layout).toContain("overscroll-y-contain");
  });
});

describe("le service worker ne peut pas se taire ni trop parler", () => {
  const sw = read("public/sw.js");

  it("affiche TOUJOURS une notification, y compris quand la charge est illisible", () => {
    // WebKit RÉVOQUE l'abonnement d'une application dont le gestionnaire
    // `push` n'affiche rien. La panne est invisible : les notifications
    // s'arrêtent, sans erreur nulle part.
    expect(sw).toContain("showNotification");
    expect(sw).toMatch(/payload\s*&&\s*payload\.title\s*\)\s*\|\||\|\|\s*"Groupe Nexus"/);
  });

  it("réclame une étiquette avec renotify", () => {
    // `renotify: true` LÈVE si `tag` est absent.
    expect(sw).toContain("renotify");
    expect(sw).toContain("tag");
  });

  it("ne met en cache que des navigations", () => {
    // /api/telephony/config rend un mot de passe SIP déchiffré : une stratégie
    // de cache naïve le déposerait en clair sur l'appareil.
    expect(sw).toContain('request.mode !== "navigate"');
    expect(sw).not.toMatch(/caches\.put\(/);
  });

  it("reprend la fenêtre existante au lieu d'en ouvrir une seconde", () => {
    // Sur iOS, une deuxième fenêtre serait un onglet Safari — donc hors de
    // l'application installée, donc hors de sa session.
    expect(sw).toContain("matchAll");
    expect(sw).toContain("focus()");
  });

  it("se ré-abonne quand le navigateur fait tourner ses clés", () => {
    expect(sw).toContain("pushsubscriptionchange");
    expect(sw).toContain("/api/push/subscribe");
  });
});

describe("le service worker est servi comme un service worker", () => {
  const config = read("next.config.ts");

  it("porte Service-Worker-Allowed et interdit son cache", () => {
    expect(config).toContain("Service-Worker-Allowed");
    expect(config).toContain("no-store");
  });
});
