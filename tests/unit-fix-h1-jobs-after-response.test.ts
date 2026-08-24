/**
 * Unitaire — `runAfterResponse` (src/lib/after-response.ts) n'exécute le
 * travail qu'UNE fois, que `after()` de Next l'accepte ou qu'il lève.
 *
 * Régression : `after(guarded())` démarrait le travail AVANT que `after()`
 * puisse refuser ; hors contexte de requête (tests, scripts) le repli le
 * relançait une seconde fois, en parallèle, et `flushAfterResponse()`
 * n'attendait que la seconde exécution.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Couture sur `after()` : par défaut le VRAI `after` de Next (qui lève hors
 * contexte de requête — c'est le chemin des tests et des scripts) ; un test
 * peut y substituer un `after` qui accepte, comme en production.
 */
const afterSeam = vi.hoisted(() => ({
  impl: undefined as ((task: unknown) => void) | undefined,
}));
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return {
    ...mod,
    after: (task: unknown) =>
      afterSeam.impl ? afterSeam.impl(task) : mod.after(task as Parameters<typeof mod.after>[0]),
  };
});

const { flushAfterResponse, runAfterResponse } = await import("@/lib/after-response");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runAfterResponse", () => {
  afterEach(() => {
    afterSeam.impl = undefined;
  });

  it("hors contexte de requête (after() lève) : le travail tourne UNE fois et flush l'attend", async () => {
    const gate = deferred();
    let started = 0;
    let finished = 0;

    runAfterResponse(async () => {
      started += 1;
      await gate.promise;
      finished += 1;
    });

    // Le travail a démarré une seule fois, et pas deux.
    expect(started).toBe(1);

    let flushed = false;
    const flushing = flushAfterResponse().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    // Tant que le travail n'est pas fini, flush n'a pas rendu la main.
    expect(flushed).toBe(false);
    expect(finished).toBe(0);

    gate.resolve();
    await flushing;
    expect(finished).toBe(1);
    expect(started).toBe(1);
  });

  it("en contexte de requête (after() accepte) : une seule exécution, confiée à after()", async () => {
    const handed: unknown[] = [];
    afterSeam.impl = (task) => {
      handed.push(task);
    };
    let runs = 0;

    runAfterResponse(async () => {
      runs += 1;
    });

    expect(handed).toHaveLength(1);
    // Ce qui est confié à after() est bien la promesse du travail, pas une
    // fonction qui le relancerait.
    expect(typeof (handed[0] as Promise<void>).then).toBe("function");
    await handed[0];
    expect(runs).toBe(1);
    // Rien n'est resté en attente locale : flush rend la main tout de suite.
    await flushAfterResponse();
    expect(runs).toBe(1);
  });

  it("une erreur du travail ne remonte jamais, ni dans un chemin ni dans l'autre", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runAfterResponse(async () => { throw new Error("boum"); })).not.toThrow();
    await flushAfterResponse();

    const handed: unknown[] = [];
    afterSeam.impl = (task) => {
      handed.push(task);
    };
    expect(() => runAfterResponse(async () => { throw new Error("re-boum"); })).not.toThrow();
    await expect(handed[0]).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
