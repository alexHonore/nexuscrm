/**
 * Unitaire — le transport Web Push écrit à la main.
 *
 * Ce que ces tests protègent : de la cryptographie faite maison est du code qui
 * ne se plaint JAMAIS quand il se trompe. Une dérivation de clé décalée d'un
 * octet, un sel mal placé, un délimiteur oublié : tout cela produit un corps de
 * la bonne taille, accepté par le service de push, que l'abonné ne saura pas
 * déchiffrer. Aucun 500, aucune trace — juste des notifications qui n'arrivent
 * jamais. D'où deux filets indépendants :
 *
 * 1. Le VECTEUR DE TEST de la RFC 8291 §5, épinglé octet par octet. C'est la
 *    seule preuve qu'on parle bien le protocole des autres, et pas un dialecte
 *    interne cohérent avec lui-même.
 * 2. Un DÉCHIFFREUR indépendant, écrit ici du point de vue du navigateur. Il ne
 *    partage pas une ligne avec `encrypt.ts` : si les deux se trompaient de la
 *    même façon, ce serait deux fois la même faute — d'où le vecteur au-dessus.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { decodeJwt, importJWK, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  encryptPayload,
  encryptPayloadWithFixtures,
  fitsInPush,
} from "@/lib/push/encrypt";
import {
  generateVapidKeys,
  loadVapidKeys,
  padTo32,
  readVapidKeys,
  toBase64Url,
  type VapidKeys,
} from "@/lib/push/keys";
import { VAPID_MAX_LIFETIME_MS, vapidAuthorization, vapidJwk } from "@/lib/push/vapid";
import {
  DEFAULT_TTL_SECONDS,
  isGone,
  sendPush,
  sendPushBatch,
  type PushSubscription,
} from "@/lib/push/send";

const b64 = (value: string): Buffer => Buffer.from(value, "base64url");

/**
 * RFC 8291 §5 — « Push Message Encryption Example ».
 *
 * Les clés sont recopiées telles quelles ; le test `cohérence` ci-dessous
 * vérifie que chaque publique dérive bien de sa privée, de sorte qu'une faute
 * de frappe dans ce bloc se voie comme une faute de frappe et non comme une
 * panne de chiffrement.
 */
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  /** Corps `aes128gcm` complet attendu : en-tête de 86 octets + enregistrement. */
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocIn" +
    "mYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNW" +
    "QexSgSxsj_Qulcy4a-fN",
  /** Valeurs intermédiaires publiées par la RFC — le déchiffreur doit les retrouver. */
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
} as const;

// ── Le navigateur, écrit ici : déchiffrement indépendant ─────────────────────

type Unsealed = { plaintext: string; cek: string; nonce: string };

/**
 * Ce que fait le service worker en recevant le corps : relire l'en-tête, refaire
 * l'ECDH depuis SA clé privée, dériver, ouvrir le GCM, retirer le délimiteur.
 *
 * Écrit du point de vue opposé à `encrypt.ts` (c'est la clé privée de l'ABONNÉ
 * qui entre ici) et volontairement sans facteur commun avec lui.
 */
function decryptPushBody(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Unsealed {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  expect(recordSize).toBe(4096);
  expect(idLength).toBe(65);
  const asPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey(null, "uncompressed");
  const shared = ecdh.computeSecret(asPublic);

  const mac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();
  const expand = (prk: Buffer, info: Buffer, length: number): Buffer =>
    mac(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);

  const ikm = expand(
    mac(authSecret, shared),
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const prk = mac(salt, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);

  const tag = sealed.subarray(sealed.length - 16);
  // `authTagLength` est explicite : Node avertit (DEP0182) quand on déchiffre
  // en GCM sans l'annoncer, et un avertissement qui traîne dans la sortie des
  // tests apprend à ne plus lire les avertissements.
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);

  // Dernier enregistrement : le délimiteur vaut 0x02 (0x01 signifierait « il en
  // reste »), et il est le DERNIER octet — pas un remplissage à gauche.
  expect(padded[padded.length - 1]).toBe(0x02);
  return {
    plaintext: padded.subarray(0, padded.length - 1).toString("utf8"),
    cek: cek.toString("base64url"),
    nonce: nonce.toString("base64url"),
  };
}

describe("RFC 8291 — vecteur de test §5", () => {
  it("les clés du vecteur sont cohérentes entre elles", () => {
    for (const [priv, pub] of [
      [RFC8291.asPrivate, RFC8291.asPublic],
      [RFC8291.uaPrivate, RFC8291.uaPublic],
    ]) {
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(b64(priv));
      expect(ecdh.getPublicKey(null, "uncompressed").toString("base64url")).toBe(pub);
    }
  });

  it("produit EXACTEMENT le corps chiffré publié par la RFC", () => {
    const body = encryptPayloadWithFixtures({
      payload: RFC8291.plaintext,
      p256dh: RFC8291.uaPublic,
      auth: RFC8291.authSecret,
      salt: RFC8291.salt,
      serverKeys: { privateKey: RFC8291.asPrivate, publicKey: RFC8291.asPublic },
    });
    expect(body.toString("base64url")).toBe(RFC8291.body);
    // 86 d'en-tête + 41 de texte + 1 de délimiteur + 16 d'étiquette.
    expect(body.length).toBe(144);
  });

  it("dérive les CEK et NONCE que la RFC documente", () => {
    const unsealed = decryptPushBody(b64(RFC8291.body), b64(RFC8291.uaPrivate), b64(RFC8291.authSecret));
    expect(unsealed.cek).toBe(RFC8291.cek);
    expect(unsealed.nonce).toBe(RFC8291.nonce);
    expect(unsealed.plaintext).toBe(RFC8291.plaintext);
  });

  it("refuse une paire serveur dépareillée", () => {
    expect(() =>
      encryptPayloadWithFixtures({
        payload: "peu importe",
        p256dh: RFC8291.uaPublic,
        auth: RFC8291.authSecret,
        salt: RFC8291.salt,
        serverKeys: { privateKey: RFC8291.asPrivate, publicKey: RFC8291.uaPublic },
      }),
    ).toThrow(/publique/);
  });
});

describe("Chiffrement — aller-retour", () => {
  /** Un abonné neuf : c'est le navigateur qui fabrique cette paire. */
  function newSubscriber() {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return {
      p256dh: ecdh.getPublicKey(null, "uncompressed"),
      privateKey: padTo32(ecdh.getPrivateKey()),
      auth: randomBytes(16),
    };
  }

  it("un message accentué revient intact chez l'abonné", () => {
    const ua = newSubscriber();
    const payload = JSON.stringify({
      title: "Nouveau lead — Côte-des-Neiges",
      body: "Rappel à faire d'ici 15 h : dépôt reçu, à rappeler « aujourd'hui ».",
    });
    const body = encryptPayload({
      payload,
      p256dh: toBase64Url(ua.p256dh),
      auth: toBase64Url(ua.auth),
    });
    expect(decryptPushBody(body, ua.privateKey, ua.auth).plaintext).toBe(payload);
  });

  it("deux envois du MÊME texte donnent deux corps différents", () => {
    const ua = newSubscriber();
    const input = { payload: "idem", p256dh: toBase64Url(ua.p256dh), auth: toBase64Url(ua.auth) };
    const first = encryptPayload(input);
    const second = encryptPayload(input);
    // Sel et paire éphémère tirés à chaque fois : réutiliser l'un des deux
    // avec la même clé casserait AES-GCM.
    expect(first.equals(second)).toBe(false);
    expect(decryptPushBody(second, ua.privateKey, ua.auth).plaintext).toBe("idem");
  });

  it("l'abonné voisin ne déchiffre rien", () => {
    const ua = newSubscriber();
    const autre = newSubscriber();
    const body = encryptPayload({
      payload: "confidentiel",
      p256dh: toBase64Url(ua.p256dh),
      auth: toBase64Url(ua.auth),
    });
    expect(() => decryptPushBody(body, autre.privateKey, autre.auth)).toThrow();
  });

  it("refuse une charge utile trop grosse et des clés d'abonnement invalides", () => {
    const ua = newSubscriber();
    const p256dh = toBase64Url(ua.p256dh);
    const auth = toBase64Url(ua.auth);
    expect(() => encryptPayload({ payload: "x".repeat(MAX_PAYLOAD_BYTES + 1), p256dh, auth })).toThrow(
      /octets/,
    );
    expect(() => encryptPayload({ payload: "x", p256dh: toBase64Url(Buffer.alloc(65)), auth })).toThrow(
      /p256dh/,
    );
    expect(() => encryptPayload({ payload: "x", p256dh, auth: toBase64Url(Buffer.alloc(8)) })).toThrow(
      /auth/,
    );
  });
});

describe("Taille de la charge utile", () => {
  it("le plafond est celui de la RFC 8188, enveloppe déduite", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(4096 - 86 - 1 - 16);
    expect(MAX_PAYLOAD_BYTES).toBe(3993);
  });

  it("se mesure en OCTETS et non en caractères", () => {
    // « é » coûte DEUX octets en UTF-8. 1997 caractères accentués, c'est
    // 3994 octets : le message déborde alors qu'il fait moitié moins de
    // caractères que la limite. Compter des caractères laisserait passer un
    // 413 en production, sur les seules fiches dont le nom prend un accent.
    const accents = "é".repeat(1997);
    expect(accents.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(accents, "utf8")).toBe(MAX_PAYLOAD_BYTES + 1);
    expect(fitsInPush(accents)).toBe(false);

    // Pile sur la limite : 1996 accents (3992 octets) + un octet ASCII.
    const pileALaLimite = `${"é".repeat(1996)}a`;
    expect(Buffer.byteLength(pileALaLimite, "utf8")).toBe(MAX_PAYLOAD_BYTES);
    expect(fitsInPush(pileALaLimite)).toBe(true);

    expect(fitsInPush("a".repeat(MAX_PAYLOAD_BYTES))).toBe(true);
    expect(fitsInPush("a".repeat(MAX_PAYLOAD_BYTES + 1))).toBe(false);
  });
});

describe("Clés VAPID", () => {
  it("padTo32 complète par la GAUCHE et refuse de tronquer", () => {
    const court = Buffer.alloc(31, 0xab);
    const complété = padTo32(court);
    expect(complété.length).toBe(32);
    expect(complété[0]).toBe(0x00);
    expect(complété.subarray(1).equals(court)).toBe(true);
    // Un scalaire est un entier : ajouter des zéros de tête ne le change pas.
    expect(BigInt(`0x${complété.toString("hex")}`)).toBe(BigInt(`0x${court.toString("hex")}`));

    expect(padTo32(Buffer.alloc(32, 1)).length).toBe(32);
    expect(() => padTo32(Buffer.alloc(33))).toThrow(/32/);
  });

  it("la génération rend toujours 32 et 65 octets", () => {
    for (let i = 0; i < 200; i += 1) {
      const { publicKey, privateKey } = generateVapidKeys();
      expect(b64(privateKey).length).toBe(32);
      expect(b64(publicKey).length).toBe(65);
      expect(b64(publicKey)[0]).toBe(0x04);
    }
  });

  it("charge une configuration valide et rejette chaque défaut", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const env = {
      VAPID_PUBLIC_KEY: publicKey,
      VAPID_PRIVATE_KEY: privateKey,
      VAPID_SUBJECT: "mailto:courtier@exemple.com",
    };
    expect(readVapidKeys(env)).toEqual({ ok: true, keys: { publicKey, privateKey, subject: env.VAPID_SUBJECT } });

    expect(readVapidKeys({}).ok).toBe(false);
    expect(readVapidKeys({})).toEqual({ ok: false, problem: "missing" });

    // Le défaut qui coûte des 403 des semaines plus tard : une privée amputée
    // de son zéro de tête. Elle doit être refusée, pas complétée en douce.
    const amputée = toBase64Url(b64(privateKey).subarray(1));
    expect(readVapidKeys({ ...env, VAPID_PRIVATE_KEY: amputée })).toEqual({
      ok: false,
      problem: "private_length",
    });

    expect(readVapidKeys({ ...env, VAPID_PUBLIC_KEY: RFC8291.asPublic })).toEqual({
      ok: false,
      problem: "mismatched_pair",
    });
    expect(readVapidKeys({ ...env, VAPID_PUBLIC_KEY: toBase64Url(Buffer.alloc(64)) })).toEqual({
      ok: false,
      problem: "public_length",
    });
    expect(readVapidKeys({ ...env, VAPID_PUBLIC_KEY: toBase64Url(Buffer.alloc(65)) })).toEqual({
      ok: false,
      problem: "public_format",
    });
    expect(readVapidKeys({ ...env, VAPID_SUBJECT: "courtier@exemple.com" })).toEqual({
      ok: false,
      problem: "subject",
    });
  });

  it("loadVapidKeys rend null au lieu de lever — l'app dégrade, elle ne tombe pas", () => {
    expect(loadVapidKeys({})).toBeNull();
    expect(loadVapidKeys({ VAPID_PUBLIC_KEY: "@@@", VAPID_PRIVATE_KEY: "@@@", VAPID_SUBJECT: "@@@" })).toBeNull();
  });
});

describe("Autorisation VAPID (RFC 8292)", () => {
  const keys: VapidKeys = { ...generateVapidKeys(), subject: "mailto:courtier@exemple.com" };
  const endpoint = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH-abonnement-tres-long";
  const now = Date.UTC(2026, 7, 28, 14, 0, 0);

  it("a la forme « vapid t=…,k=… » exigée au caractère près", async () => {
    const header = await vapidAuthorization({ endpoint, keys, nowMs: now });
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+,k=[A-Za-z0-9_-]+$/);
    const [, publicKey] = header.split(",k=");
    expect(publicKey).toBe(keys.publicKey);
  });

  it("adresse le jeton à l'ORIGINE, jamais à l'URL complète", async () => {
    const header = await vapidAuthorization({ endpoint, keys, nowMs: now });
    const claims = decodeJwt(header.slice("vapid t=".length).split(",k=")[0]);
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.aud).not.toContain("/fcm/send");
    expect(claims.sub).toBe(keys.subject);
    expect(claims.exp).toBe(Math.floor(now / 1000) + 12 * 60 * 60);
  });

  it("plafonne la durée de vie à 24 h même si on en demande plus", async () => {
    const header = await vapidAuthorization({
      endpoint,
      keys,
      nowMs: now,
      lifetimeMs: 72 * 60 * 60 * 1000,
    });
    const claims = decodeJwt(header.slice("vapid t=".length).split(",k=")[0]);
    const exp = claims.exp ?? 0;
    expect(exp).toBe(Math.floor((now + VAPID_MAX_LIFETIME_MS) / 1000));
    expect(exp * 1000 - now).toBeLessThanOrEqual(VAPID_MAX_LIFETIME_MS);
  });

  it("la signature se vérifie avec la clé publique annoncée", async () => {
    // Ce que fera le service de push : prendre le `k=`, en refaire un JWK, et
    // vérifier. Si X et Y étaient découpés de travers, ceci échouerait.
    const header = await vapidAuthorization({ endpoint, keys, nowMs: Date.now() });
    const token = header.slice("vapid t=".length).split(",k=")[0];
    const { kty, crv, x, y } = vapidJwk(keys);
    const verifier = await importJWK({ kty, crv, x, y, alg: "ES256" }, "ES256");
    const { payload, protectedHeader } = await jwtVerify(token, verifier, {
      audience: "https://fcm.googleapis.com",
    });
    expect(protectedHeader.alg).toBe("ES256");
    expect(payload.sub).toBe(keys.subject);
  });
});

describe("Transport", () => {
  const keys: VapidKeys = { ...generateVapidKeys(), subject: "mailto:courtier@exemple.com" };

  function subscriber(host = "https://fcm.googleapis.com/fcm/send/abc"): PushSubscription {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return {
      endpoint: host,
      keys: {
        p256dh: toBase64Url(ecdh.getPublicKey(null, "uncompressed")),
        auth: toBase64Url(randomBytes(16)),
      },
    };
  }

  it("POSTe le corps chiffré avec les en-têtes du protocole", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
    const subscription = subscriber();
    const result = await sendPush({
      subscription,
      payload: '{"title":"Nouveau lead"}',
      keys,
      topic: "lead-42",
      urgency: "high",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(subscription.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.Authorization.startsWith("vapid t=")).toBe(true);
    expect(headers.TTL).toBe(String(DEFAULT_TTL_SECONDS));
    expect(headers.Urgency).toBe("high");
    expect(headers.Topic).toBe("lead-42");
    const body = init.body as Uint8Array;
    expect(headers["Content-Length"]).toBe(String(body.byteLength));
    expect(body.byteLength).toBeGreaterThan(86);
  });

  it("404 et 410 valent ORDRE DE SUPPRESSION", async () => {
    for (const status of [404, 410]) {
      const result = await sendPush({
        subscription: subscriber(),
        payload: "x",
        keys,
        fetchFn: (async () => new Response(null, { status })) as unknown as typeof fetch,
      });
      expect(result).toEqual({ ok: false, gone: true });
      expect(isGone(result)).toBe(true);
    }
  });

  it("429 rend la temporisation demandée, et une par défaut si l'amont se tait", async () => {
    const withHeader = await sendPush({
      subscription: subscriber(),
      payload: "x",
      keys,
      fetchFn: (async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "120" } })) as unknown as typeof fetch,
    });
    expect(withHeader).toEqual({ ok: false, retryAfterMs: 120_000 });

    const silent = await sendPush({
      subscription: subscriber(),
      payload: "x",
      keys,
      fetchFn: (async () => new Response(null, { status: 429 })) as unknown as typeof fetch,
    });
    expect(silent).toEqual({ ok: false, retryAfterMs: 60_000 });
  });

  it("une charge utile trop grosse ne part même pas sur le réseau", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await sendPush({
      subscription: subscriber(),
      payload: "x".repeat(MAX_PAYLOAD_BYTES + 1),
      keys,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, tooLarge: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sans clés configurées, l'envoi refuse au lieu de lever", async () => {
    // L'environnement est FIXÉ ici plutôt que supposé vide : ce test décrit le
    // cas « push non configuré » que l'application doit savoir afficher, et il
    // ne doit pas changer de sens selon ce qui traîne dans .env.test.
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    vi.stubEnv("VAPID_SUBJECT", "");
    try {
      expect(await sendPush({ subscription: subscriber(), payload: "x" })).toEqual({
        ok: false,
        error: "vapid_not_configured",
      });
      const batch = await sendPushBatch([subscriber(), subscriber()], "x");
      expect(batch.map((entry) => entry.result)).toEqual([
        { ok: false, error: "vapid_not_configured" },
        { ok: false, error: "vapid_not_configured" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("un appareil mort ne prive pas les autres de leur notification", async () => {
    const subs = [subscriber("https://a.example.com/p/1"), subscriber("https://b.example.com/p/2"), subscriber("https://a.example.com/p/3")];
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/p/2")) throw new Error("socket hors service");
      if (url.endsWith("/p/3")) return new Response(null, { status: 410 });
      return new Response(null, { status: 201 });
    });

    const results = await sendPushBatch(subs, '{"title":"Rappel"}', {
      keys,
      concurrency: 2,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(results.map((r) => r.endpoint)).toEqual(subs.map((s) => s.endpoint));
    expect(results[0].result).toEqual({ ok: true });
    expect(results[1].result).toMatchObject({ ok: false });
    expect(results[2].result).toEqual({ ok: false, gone: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("le lot ne signe qu'un jeton par ORIGINE", async () => {
    const subs = [
      subscriber("https://fcm.googleapis.com/fcm/send/1"),
      subscriber("https://fcm.googleapis.com/fcm/send/2"),
      subscriber("https://updates.push.services.mozilla.com/wpush/v2/3"),
    ];
    // On indexe par ORIGINE et non par rang d'arrivée : le lot travaille sur
    // six voies et `seen` s'écrit dans l'ordre où les réponses REVIENNENT,
    // pas dans celui des abonnés. Un `seen[0] === seen[1]` passait donc la
    // plupart du temps et échouait quand Mozilla répondait avant le second
    // FCM — un test dont l'échec dépend de l'ordonnanceur apprend à relancer
    // la suite au lieu de la croire.
    const seen = new Map<string, Set<string>>();
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const origin = new URL(url).origin;
      const auth = (init.headers as Record<string, string>).Authorization;
      seen.set(origin, (seen.get(origin) ?? new Set()).add(auth));
      return new Response(null, { status: 201 });
    });
    await sendPushBatch(subs, "x", { keys, fetchFn: fetchFn as unknown as typeof fetch });

    // Un jeton par origine : les deux abonnés FCM partagent le leur…
    expect(seen.get("https://fcm.googleapis.com")?.size).toBe(1);
    // …et Mozilla en a un autre, car `aud` vaut l'origine du point de
    // terminaison. Signer un seul jeton pour tout le lot le ferait refuser
    // par tous les services sauf un.
    expect(seen.get("https://updates.push.services.mozilla.com")?.size).toBe(1);
    const all = new Set([...seen.values()].flatMap((set) => [...set]));
    expect(all.size).toBe(2);
  });
});
