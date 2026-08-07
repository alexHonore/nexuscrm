import { NextResponse, type NextRequest } from "next/server";

/**
 * Garde légère de routage : redirige vers /login si aucun cookie de session.
 * La vraie vérification (JWT + isActive + tokenVersion) se fait côté serveur
 * dans src/lib/auth/guards.ts — appelée par chaque layout et route API.
 */
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
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/icons/");

  if (!isPublic && !request.cookies.has("nexus_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
