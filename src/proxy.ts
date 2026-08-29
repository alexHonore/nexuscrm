import { NextResponse, type NextRequest } from "next/server";

/**
 * Garde légère de routage : redirige vers /login si aucun cookie de session.
 * La vraie vérification (JWT + isActive + tokenVersion) se fait côté serveur
 * dans src/lib/auth/guards.ts — appelée par chaque layout et route API.
 */

/**
 * Les fichiers de l'application INSTALLÉE, que le navigateur va chercher sans
 * jamais présenter de cookie.
 *
 * Ce n'est pas une commodité, c'est une condition d'existence :
 *
 * - le manifeste est demandé SANS identifiants (Next ne pose
 *   `crossorigin="use-credentials"` qu'en pré-production) ; renvoyé vers
 *   /login il devient une page HTML, le navigateur annonce « Manifest: Line 1,
 *   column 1, Unexpected token < » et n'offre plus jamais l'installation ;
 * - un script de service worker dont la requête est REDIRIGÉE fait échouer
 *   `register()` par spécification — et la vérification de mise à jour du
 *   worker se fait hors de toute navigation, donc souvent sans cookie frais ;
 * - /offline est justement l'écran servi quand plus rien ne répond : le mettre
 *   derrière la session en fait un écran qui ne s'affiche jamais.
 *
 * `/icons/` était déjà ouvert plus bas, et les extensions d'images sont déjà
 * hors du `matcher` : les icônes n'ont besoin de rien de plus.
 */
const PWA_PATHS = new Set(["/manifest.webmanifest", "/manifest.json", "/sw.js", "/offline"]);

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublic =
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    // Pages publiques exigées par la vérification Google OAuth.
    pathname === "/" ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    // Référence d'intégration : elle existe pour être lue AVANT d'avoir un
    // compte. La renvoyer vers /login en ferait une documentation réservée à
    // ceux qui n'en ont plus besoin.
    pathname === "/developers" ||
    PWA_PATHS.has(pathname) ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/icons/");

  if (!isPublic && !request.cookies.has("nexus_session")) {
    const url = request.nextUrl.clone();
    // Où l'on allait, gardé de côté. Toute la valeur d'une notification tient
    // dans « CE texto-là, de CE client-là » : le système d'exploitation expulse
    // l'application installée pendant la nuit, la notification du matin arrive
    // sur une session morte, et sans cette ligne la destination était effacée
    // avec la barre d'adresse — le téléphoniste se connectait pour atterrir sur
    // un tableau de bord qui ne dit pas qui l'a écrit.
    const target = `${pathname}${request.nextUrl.search}`;
    url.pathname = "/login";
    url.search = "";
    if (target !== "/dashboard") url.searchParams.set("next", target);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
