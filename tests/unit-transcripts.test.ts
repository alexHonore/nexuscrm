import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildNoteBody,
  buildTranscriptSystem,
  buildTranscriptUserText,
  parseTranscriptOutput,
  SUMMARY_MAX_CHARS,
  type TranscriptPromptInput,
} from "@/lib/transcripts/prompt";
import { generateFromAudio } from "@/lib/transcripts/audio-llm";
import { transcriptsSettingsSchema } from "@/lib/settings";

const CALL: TranscriptPromptInput["call"] = {
  direction: "outbound",
  durationSec: 252,
  // 14 h 03 à Toronto (EDT, UTC-4) le 27 août 2026.
  startedAt: new Date("2026-08-27T18:03:00Z"),
  agentName: "Marie Tremblay",
  clientName: "Jean Untel",
  clientCity: "Sainte-Foy",
  clientAddress: "123 rue du Campanile",
};

function input(overrides: Partial<TranscriptPromptInput> = {}): TranscriptPromptInput {
  return { language: "fr", detail: "standard", keepTranscript: true, call: CALL, ...overrides };
}

describe("réglage transcripts", () => {
  it("est éteint par défaut, avec des gardes de coût raisonnables", () => {
    const cfg = transcriptsSettingsSchema.parse({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.language).toBe("fr");
    expect(cfg.detail).toBe("standard");
    expect(cfg.minSeconds).toBeGreaterThan(0);
    expect(cfg.maxMinutes).toBeGreaterThan(0);
    expect(cfg.model).toContain("/"); // identifiant routeur, ex. google/gemini-2.5-flash
  });

  it("accepte le niveau exhaustif", () => {
    const cfg = transcriptsSettingsSchema.parse({ detail: "exhaustive" });
    expect(cfg.detail).toBe("exhaustive");
  });
});

describe("buildTranscriptSystem", () => {
  it("suit la langue et le niveau de détail du RÉGLAGE, pas de l'écran", () => {
    const fr = buildTranscriptSystem(input());
    expect(fr).toContain("courtier immobilier québécois");
    expect(fr).toContain('"transcript"');
    const en = buildTranscriptSystem(input({ language: "en", detail: "detailed" }));
    expect(en).toContain("Québec real-estate broker");
    expect(en).toContain("COMPLETE");
  });

  it("ne demande pas le verbatim quand keepTranscript est faux", () => {
    const sys = buildTranscriptSystem(input({ keepTranscript: false }));
    expect(sys).not.toContain('"transcript"');
    expect(sys).toContain('"summary"');
  });

  it("arme l'oreille : audio téléphone, noms propres, [inaudible] plutôt qu'inventer", () => {
    const sys = buildTranscriptSystem(input());
    expect(sys).toContain("TÉLÉPHONIQUE");
    expect(sys).toContain("noms propres");
    expect(sys).toContain("[inaudible]");
    const en = buildTranscriptSystem(input({ language: "en" }));
    expect(en).toContain("[inaudible]");
    expect(en).toContain("proper nouns");
  });

  it("niveau exhaustif : chronologie horodatée où même l'accessoire est consigné", () => {
    const sys = buildTranscriptSystem(input({ detail: "exhaustive" }));
    expect(sys).toContain("EXHAUSTIVE");
    expect(sys).toContain("[mm:ss]");
    expect(sys).toContain("même ceux qui semblent sans importance");
    const en = buildTranscriptSystem(input({ detail: "exhaustive", language: "en" }));
    expect(en).toContain("[mm:ss]");
    expect(en).toContain("even those that seem unimportant");
  });
});

describe("buildTranscriptUserText", () => {
  it("donne les faits de l'appel en heure de Toronto", () => {
    const text = buildTranscriptUserText(input());
    expect(text).toContain("sortant");
    expect(text).toContain("27 août 2026");
    expect(text).toContain("14 h 03");
    expect(text).toContain("4 min 12 s");
    expect(text).toContain("Marie Tremblay");
    expect(text).toContain("Jean Untel");
  });

  it("donne la ville et l'adresse de la fiche comme repères d'orthographe, avec le garde-fou", () => {
    const text = buildTranscriptUserText(input());
    // Le cas mesuré : « Sainte-Foy » transcrit « cinq fois » sans repère.
    expect(text).toContain("Sainte-Foy");
    expect(text).toContain("123 rue du Campanile");
    expect(text).toContain("ne les mets PAS dans la note");
  });

  it("sans ville ni adresse sur la fiche : aucun bloc de repères", () => {
    const text = buildTranscriptUserText(
      input({ call: { ...CALL, clientCity: null, clientAddress: null } }),
    );
    expect(text).not.toContain("Repères");
  });
});

describe("parseTranscriptOutput", () => {
  it("lit un JSON propre", () => {
    const out = parseTranscriptOutput('{"transcript": "T: Bonjour", "summary": "Client intéressé."}');
    expect(out.summary).toBe("Client intéressé.");
    expect(out.transcript).toBe("T: Bonjour");
  });

  it("tolère les clôtures de code et la prose autour", () => {
    const out = parseTranscriptOutput('```json\n{"summary": "RV pris."}\n```');
    expect(out.summary).toBe("RV pris.");
    expect(out.transcript).toBeNull();
  });

  it("se replie sur le texte entier quand le modèle répond en PROSE", () => {
    const out = parseTranscriptOutput("Le client veut rappeler en janvier.");
    expect(out.summary).toBe("Le client veut rappeler en janvier.");
    expect(out.transcript).toBeNull();
    expect(out.failure).toBeNull();
  });

  // ── Le cas de la production du 2026-09-15 ────────────────────────────────
  // 8 notes sur 52 : le modèle transcrivait tout l'appel puis s'arrêtait sans
  // refermer sa chaîne ni écrire `summary`. Le repli « tout le texte est la
  // note » collait alors `{ "transcript": "Allô…` sur la fiche du client.
  describe("réponse JSON ratée", () => {
    const TRONQUÉ =
      '{\n  "transcript": "Allô. Allô. Monsieur Larbi, est-ce que vous m\'entendez ?' +
      " Oui, je vous entends. … Bonne soirée, merci.";

    it("ne pousse JAMAIS un débris de JSON comme note", () => {
      const out = parseTranscriptOutput(TRONQUÉ);
      expect(out.summary).toBe("");
      expect(out.failure).toBe("malformed");
      expect(out.summary).not.toContain("transcript");
    });

    it("sauve le verbatim entier — l'audio a été écouté et payé", () => {
      const out = parseTranscriptOutput(TRONQUÉ);
      expect(out.transcript).toContain("Monsieur Larbi");
      expect(out.transcript).toContain("Bonne soirée, merci.");
      expect(out.transcript?.startsWith("{")).toBe(false);
    });

    it("rend les échappements du verbatim sauvé, jamais leur écriture brute", () => {
      const out = parseTranscriptOutput('{"transcript": "Téléphoniste : Allô ?\\nClient : Oui');
      expect(out.transcript).toBe("Téléphoniste : Allô ?\nClient : Oui");
      expect(out.failure).toBe("malformed");
    });

    it("deux objets à la suite : on retrouve la note et le verbatim, pas les accolades", () => {
      const out = parseTranscriptOutput(
        '{"transcript":"T: allo"}\n{"summary":"Client rappelle."}',
      );
      expect(out.summary).toBe("Client rappelle.");
      expect(out.transcript).toBe("T: allo");
      expect(out.failure).toBeNull();
    });

    it("un raisonnement en clair suivi du JSON ne part pas sur la fiche", () => {
      const out = parseTranscriptOutput(
        'Je dois transcrire {le fichier} puis résumer.\n{"summary":"Client rappelle."}',
      );
      expect(out.summary).toBe("Client rappelle.");
      expect(out.summary).not.toContain("Je dois transcrire");
    });

    /**
     * Le prompt demande désormais la note AVANT le verbatim, exprès : une
     * coupure mange la fin. Quand le verbatim est là, c'est que la note l'a
     * précédé et qu'elle est entière — on la récupère au lieu de tout perdre.
     */
    it("note écrite AVANT le verbatim : une coupure ne coûte plus la note", () => {
      const out = parseTranscriptOutput(
        '{"summary": "Client veut acheter d\'ici la fin de l\'année, budget 400-500k.",' +
          ' "transcript": "Allô. Allô. Monsieur Larbi… Bonne soirée, merci.',
      );
      expect(out.summary).toContain("budget 400-500k");
      expect(out.transcript).toContain("Bonne soirée, merci.");
      expect(out.failure).toBeNull();
    });

    it("mais une note elle-même coupée n'est JAMAIS écrite sur la fiche", () => {
      // Sans verbatim derrière, rien ne dit que la note est entière.
      const out = parseTranscriptOutput('{"summary": "Client veut acheter d\'ici la fin de l\'an');
      expect(out.summary).toBe("");
      expect(out.failure).toBe("malformed");
    });

    it("virgule finale : échec, pas le JSON entier en note", () => {
      const out = parseTranscriptOutput('{"transcript":"T: allo","summary":"RV pris.",}');
      expect(out.failure).toBe("malformed");
      expect(out.summary).toBe("");
    });
  });

  // ── Le défaut symétrique ─────────────────────────────────────────────────
  // Une note en prose qui cite un objet ne doit pas être prise pour un JSON
  // sans note et jetée : c'est exactement la réponse que le prompt DEMANDE
  // pour une boîte vocale.
  describe("prose contenant des accolades", () => {
    it("garde une note qui cite un objet", () => {
      const out = parseTranscriptOutput(
        'Le client a donné son code {"postal": "G1V 2M3"} puis a raccroché.',
      );
      expect(out.summary).toContain("G1V 2M3");
      expect(out.failure).toBeNull();
    });

    it("garde la note « boîte vocale » que le prompt réclame", () => {
      const out = parseTranscriptOutput("Boîte vocale : message type {} laissé, aucun échange.");
      expect(out.summary).toContain("Boîte vocale");
      expect(out.failure).toBeNull();
    });
  });

  it("borne la note — le modèle peut déborder ses consignes", () => {
    const out = parseTranscriptOutput(JSON.stringify({ summary: "x".repeat(10_000) }));
    expect(out.summary.length).toBe(SUMMARY_MAX_CHARS);
  });

  it("rend une note vide pour une réponse vide (le cœur la classe en échec)", () => {
    expect(parseTranscriptOutput("").summary).toBe("");
    expect(parseTranscriptOutput("").failure).toBe("empty");
    expect(parseTranscriptOutput('{"summary": ""}').summary).toBe("");
    // Format LU, contenu absent : ce n'est pas le même reproche qu'un JSON raté.
    expect(parseTranscriptOutput('{"summary": ""}').failure).toBe("empty");
  });

  // La propriété qui compte, quoi qu'écrive le modèle : rien qui ressemble à
  // du JSON ne doit pouvoir atterrir dans le corps d'un commentaire de fiche.
  it("aucune entrée ne produit une note qui commence par une accolade", () => {
    const entrées = [
      '{"transcript": "T: allo',
      "{",
      '```json\n{"summary": "A"}\n```\n```json\n{"summary": "B"}\n```',
      '[{"summary":"A"}]',
      "{ }",
      'Je dois transcrire {le fichier} puis résumer.\n{"summary":"Client rappelle."}',
    ];
    for (const entrée of entrées) {
      const out = parseTranscriptOutput(entrée);
      if (out.summary === "") continue; // classé en échec : rien n'est poussé
      expect(buildNoteBody({ language: "fr", call: CALL, summary: out.summary })).not.toContain("{");
    }
  });
});

describe("buildNoteBody", () => {
  it("signe la machine (🤖) et date l'appel en heure de Toronto", () => {
    const body = buildNoteBody({ language: "fr", call: CALL, summary: "Client intéressé." });
    expect(body).toMatch(/^🤖 Notes d'appel \(IA\)/);
    expect(body).toContain("sortant");
    expect(body).toContain("27 août 2026");
    expect(body).toContain("(4 min 12 s)");
    expect(body.endsWith("Client intéressé.")).toBe(true);
  });

  it("suit la langue du réglage", () => {
    const body = buildNoteBody({
      language: "en",
      call: { ...CALL, direction: "inbound" },
      summary: "Interested client.",
    });
    expect(body).toMatch(/^🤖 AI call notes/);
    expect(body).toContain("inbound");
    expect(body).toContain("August 27, 2026");
  });
});

describe("generateFromAudio", () => {
  it("envoie l'audio en input_audio avec le routage deny + ZDR et usage.include", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchFn: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "google/gemini-2.5-flash",
          choices: [{ message: { content: '{"summary": "ok"}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0123 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await generateFromAudio({
      apiKey: "sk-test",
      model: "google/gemini-2.5-flash",
      system: "sys",
      userText: "facts",
      audio: { base64: "QUJD", format: "mp3" },
      maxTokens: 100,
      temperature: 0.2,
      fetchFn,
    });

    expect(captured).not.toBeNull();
    const body = captured as unknown as {
      messages: Array<{ role: string; content: unknown }>;
      provider: Record<string, unknown>;
      usage: Record<string, unknown>;
    };
    const user = body.messages.find((m) => m.role === "user");
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === "input_audio")).toBe(true);
    const audioPart = parts.find((p) => p.type === "input_audio") as {
      input_audio: { data: string; format: string };
    };
    expect(audioPart.input_audio).toEqual({ data: "QUJD", format: "mp3" });
    // Loi 25 : les deux contrôles, et pas de reroutage silencieux.
    expect(body.provider).toMatchObject({
      data_collection: "deny",
      zdr: true,
      allow_fallbacks: false,
    });
    // Sans usage.include, OpenRouter omet usage.cost et la page de
    // consommation sous-compte (constat du 2026-08-26).
    expect(body.usage).toEqual({ include: true });

    expect(result.text).toBe('{"summary": "ok"}');
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 50, costUsd: 0.0123 });
  });
});
