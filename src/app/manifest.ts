import type { MetadataRoute } from "next";

/**
 * Le manifeste — ce qui transforme un site en application posée sur l'écran
 * d'accueil, et, sur iOS, la seule porte vers les notifications : Safari
 * n'expose l'API Push qu'à une page INSTALLÉE dont le manifeste déclare
 * `display: standalone`.
 *
 * Il est écrit en français en dur, et c'est délibéré. Next ne pose
 * `crossorigin="use-credentials"` sur le lien du manifeste qu'en
 * pré-production : en production le navigateur le demande SANS cookie, donc
 * sans `NEXT_LOCALE`. Un manifeste « traduit » n'aurait fait que rendre la
 * route dynamique pour livrer, invariablement, la langue par défaut. Le nom de
 * l'icône est de toute façon une marque, pas une phrase.
 *
 * `id` est épinglé séparément de `start_url` : c'est lui qui identifie
 * l'application installée. Sans lui, changer `start_url` un jour ferait
 * apparaître une DEUXIÈME icône sur les téléphones déjà équipés, la première
 * continuant de pointer vers l'ancien écran.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/?source=pwa",
    name: "Groupe Nexus — CRM",
    short_name: "Nexus",
    description: "Le CRM de Groupe Nexus : fiches, appels, textos et rendez-vous.",
    lang: "fr-CA",
    dir: "ltr",
    // On démarre sur le tableau de bord, pas sur « / » : la racine est la page
    // vitrine, et ouvrir son application de travail sur une page de marketing
    // est le premier signal qu'on a installé un site et non un outil.
    start_url: "/dashboard?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    // Le bleu de la barre d'état est celui du bandeau latéral (--sidebar), pas
    // une troisième teinte : l'application ouverte doit sembler continuer sous
    // l'horloge du téléphone.
    theme_color: "#102034",
    background_color: "#102034",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Les trois gestes d'un téléphoniste qui sort son téléphone. Android les
    // pose sous l'icône en appui long ; iOS les ignore, ce qui ne coûte rien.
    shortcuts: [
      {
        name: "Mes fiches",
        short_name: "Fiches",
        url: "/clients?source=pwa",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Conversations",
        short_name: "Textos",
        url: "/conversations?source=pwa",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Notifications",
        short_name: "Alertes",
        url: "/notifications?source=pwa",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
