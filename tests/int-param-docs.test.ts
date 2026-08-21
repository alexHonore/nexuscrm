/**
 * Intégration — surcouche administrateur de la documentation.
 *
 * La garantie à tenir : la base ne peut PAS inventer un paramètre. Elle ne fait
 * que réécrire le texte d'un chemin que le registre de code connaît déjà.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { paramDocs } from "@/db/schema-sms";
import { getParamDoc } from "@/lib/docs/params";

vi.mock("server-only", () => ({}));

const { getParamDocs, getParamDocFor, saveParamDoc, resetParamDoc, staleOverrides } = await import(
  "@/lib/docs-server"
);

let adminId: string;

beforeEach(async () => {
  await resetDb();
  adminId = (await makeUser({ role: "admin" })).id;
});

afterAll(async () => {
  await closeDb();
});

describe("documentation — surcouche", () => {
  it("sans surcouche, le texte vient du registre", async () => {
    const view = await getParamDocFor("approach.persistence");
    expect(view?.overridden).toBe(false);
    expect(view?.whyFr).toBe(getParamDoc("approach.persistence")!.whyFr);
  });

  it("une réécriture remplace le texte et se signale comme telle", async () => {
    await saveParamDoc({
      path: "approach.persistence",
      whyFr: "Texte maison de l'équipe.",
      updatedById: adminId,
    });

    const view = await getParamDocFor("approach.persistence");
    expect(view?.overridden).toBe(true);
    expect(view?.whyFr).toBe("Texte maison de l'équipe.");
    // Les champs laissés vides gardent le texte d'origine.
    expect(view?.whatFr).toBe(getParamDoc("approach.persistence")!.whatFr);
  });

  it("réécrire deux fois le même chemin met à jour la ligne au lieu d'en créer une", async () => {
    await saveParamDoc({ path: "model.model", whatFr: "Un", updatedById: adminId });
    await saveParamDoc({ path: "model.model", whatFr: "Deux", updatedById: adminId });

    const rows = await testDb.select().from(paramDocs);
    expect(rows).toHaveLength(1);
    expect(rows[0].whatFr).toBe("Deux");
  });

  it("un chemin inconnu du registre est REFUSÉ", async () => {
    await expect(
      saveParamDoc({ path: "approach.inventé", whyFr: "…", updatedById: adminId }),
    ).rejects.toThrow(/unknown_param_path/);
    expect(await testDb.select().from(paramDocs)).toHaveLength(0);
  });

  it("la remise à zéro rend le texte d'origine", async () => {
    await saveParamDoc({ path: "model.temperature", whyFr: "X", updatedById: adminId });
    const back = await resetParamDoc("model.temperature");
    expect(back?.overridden).toBe(false);
    expect(back?.whyFr).toBe(getParamDoc("model.temperature")!.whyFr);
    expect(await testDb.select().from(paramDocs)).toHaveLength(0);
  });

  it("une ligne dont le chemin a disparu du registre est ignorée à la lecture et signalée", async () => {
    // Écriture directe : simule un paramètre renommé après une réécriture.
    await testDb.insert(paramDocs).values({ path: "approach.disparu", whyFr: "orphelin" });

    const all = await getParamDocs();
    expect(all.some((d) => d.path === "approach.disparu")).toBe(false);
    expect(await staleOverrides()).toEqual(["approach.disparu"]);
  });

  it("la liste par section ne renvoie que cette section", async () => {
    const model = await getParamDocs("model");
    expect(model.length).toBeGreaterThan(5);
    expect(model.every((d) => d.section === "model")).toBe(true);
  });
});
