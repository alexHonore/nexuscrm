/**
 * Références d'enregistrement voip.ms.
 *
 * Constaté en production le 2026-08-07 : `getCallRecordings` ne renvoie AUCUNE
 * URL — seulement `{ callrecording, call_id, account, … }`. L'audio doit donc
 * être retéléchargé à l'écoute, et la référence stockée dans
 * `calls.recording_url` doit survivre à l'aller-retour.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  recordingRef,
  parseRecordingRef,
  extractRecordingAudio,
  extractRecordingUrl,
  sniffAudioType,
} = await import("@/lib/voipms");

describe("références d'enregistrement", () => {
  it("fait l'aller-retour compte + identifiant", () => {
    const ref = recordingRef("551013_alex", "4242");
    expect(ref).toBe("voipms:551013_alex:4242");
    expect(parseRecordingRef(ref)).toEqual({ account: "551013_alex", callrecording: "4242" });
  });

  it("gère un nom de compte contenant « : » (dernier séparateur)", () => {
    expect(parseRecordingRef("voipms:a:b:99")).toEqual({ account: "a:b", callrecording: "99" });
  });

  it("ignore ce qui n'est pas une référence interne", () => {
    expect(parseRecordingRef("https://voip.ms/rec/1.wav")).toBeNull();
    expect(parseRecordingRef("voipms:")).toBeNull();
    expect(parseRecordingRef("voipms:sans-id:")).toBeNull();
  });
});

describe("extraction de l'audio", () => {
  it("préfère une URL directe si voip.ms en fournit une", () => {
    const out = extractRecordingAudio({ status: "success", url: "https://voip.ms/r/1.wav" });
    expect(out).toEqual({ url: "https://voip.ms/r/1.wav" });
  });

  it("reconnaît un contenu base64 quel que soit le nom du champ", () => {
    const base64 = "A".repeat(400) + "==";
    const out = extractRecordingAudio({ status: "success", n_importe_quoi: base64 });
    expect(out).toEqual({ base64 });
  });

  it("ne prend pas un texte court pour de l'audio", () => {
    const out = extractRecordingAudio({ status: "success", message: "ok" });
    expect(out).toHaveProperty("fields");
  });

  it("remonte les NOMS de champs quand le format est inconnu (jamais les valeurs)", () => {
    const out = extractRecordingAudio({ status: "success", secret_token: "abc" });
    expect(out).toEqual({ fields: ["status", "secret_token"] });
  });
});

describe("type MIME de l'audio servi", () => {
  const sniff = (bytes: number[]) => sniffAudioType(Buffer.from(bytes));

  it("reconnaît une trame MP3 — l'en-tête RÉEL renvoyé par voip.ms", () => {
    // Octets relevés en production sur un enregistrement téléchargé.
    expect(sniff([0xff, 0xe3, 0x38, 0xc4])).toBe("audio/mpeg");
  });

  it("reconnaît un en-tête ID3", () => {
    expect(sniff([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0])).toBe("audio/mpeg");
  });

  it("reconnaît un WAV", () => {
    expect(sniff([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])).toBe("audio/wav");
  });

  it("ne prétend rien sur un contenu inconnu", () => {
    expect(sniff([0x00, 0x01, 0x02, 0x03])).toBe("application/octet-stream");
  });
});

describe("extractRecordingUrl", () => {
  it("trouve une URL http(s) dans n'importe quel champ", () => {
    expect(extractRecordingUrl({ lien: "https://x.voip.ms/a.wav" })).toBe("https://x.voip.ms/a.wav");
  });

  it("renvoie undefined quand la charge utile n'a que des identifiants", () => {
    expect(
      extractRecordingUrl({ callrecording: "4242", call_id: "uid-1", account: "551013_alex" }),
    ).toBeUndefined();
  });
});
