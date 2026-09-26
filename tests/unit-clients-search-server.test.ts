/**
 * Unitaire — recherche de clients : l'EXÉCUTION (§3.4), sans base.
 *
 * L'exécuteur et le robinet sont injectés : on vérifie QUI est appelé, et
 * combien de fois. Ce que ces tests protègent : une recherche profonde trop
 * lente ou trop nombreuse se rabat sur la fiche seule au lieu d'épuiser le
 * pool (voir `src/db/index.ts`), une frappe abandonnée ne coûte rien, et la
 * relance « faute de frappe » n'a lieu qu'une fois, jamais en identité.
 */
import { DrizzleQueryError, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { allGrants } from "@/lib/permissions/catalog";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/permissions/server", () => ({
  holderGrants: async () => Object.assign(() => allGrants(), { holders: [] as string[] }),
  holderGrantScope: async () => ({ kind: "all" }),
  withVisibility: async (_actor: unknown, where: unknown) => where,
  holderScopeCondition: (s: { kind: string }) => (s.kind === "all" ? undefined : sql`false`),
}));

const { searchClients, listSearchResponse, isStatementTimeout } = await import("@/lib/clients-search-server/search");
const { createLimiter } = await import("@/lib/clients-search-server/limiter");
type SearchDeps = import("@/lib/clients-search-server/search").SearchDeps;
type SearchInput = import("@/lib/clients-search-server/search").SearchInput;
type SearchRow = import("@/lib/clients-search-server/statement").SearchRow;
type Actor = import("@/lib/permissions/server").Actor;

const dialect = new PgDialect();
const text = (stmt: SQL) => dialect.sqlToQuery(stmt).sql;
const isDeep = (stmt: SQL) => /\bcm as \(/.test(text(stmt));
const isFuzzy = (stmt: SQL) => dialect.sqlToQuery(stmt).params.some((p) => typeof p === "string" && p.includes("\\S"));

const actor = {
  user: { id: "00000000-0000-4000-8000-000000000001" },
  role: { id: "admin", superAdmin: true },
  can: () => true,
} as unknown as Actor;

function input(q: string, over: Partial<SearchInput> = {}): SearchInput {
  return {
    q,
    filters: undefined,
    mode: "all",
    sort: "relevance",
    dir: "desc",
    page: 1,
    pageSize: 8,
    now: new Date("2026-09-26T12:00:00.000Z"),
    ...over,
  };
}

/** Une page vide (total 0) — la forme exacte de la ligne « hors page ». */
const EMPTY: SearchRow[] = [{ total: 0, n_all: 0, n_contact: 0, n_profile: 0, n_notes: 0, id: null }];
/** Une fiche trouvée par son nom. */
function hitRow(over: Record<string, unknown> = {}): SearchRow {
  return {
    total: "1",
    n_all: "1",
    n_contact: "1",
    n_profile: "0",
    n_notes: "0",
    id: "00000000-0000-4000-8000-00000000aaaa",
    score: "100",
    name_x: "1",
    contact_ok: true,
    history_ok: true,
    thread_ok: true,
    full_name: "Jean Tremblay",
    phone: "+14185551234",
    email: null,
    city: "Lévis",
    assigned_to_id: null,
    category_id: 3,
    category_color: "#ff0000",
    source_id: null,
    do_not_call: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    next_followup_at: null,
    last_contacted_at: null,
    hist_at: null,
    hist_n: 0,
    ...over,
  } as SearchRow;
}

type Script = {
  run?: (stmt: SQL) => SearchRow[] | Promise<SearchRow[]>;
  timeout?: (stmt: SQL) => SearchRow[] | Promise<SearchRow[]>;
  acquire?: () => (() => void) | null;
};

function deps(script: Script) {
  const calls = { run: [] as SQL[], timeout: [] as SQL[], acquire: 0, release: 0 };
  const d: SearchDeps = {
    executor: {
      run: async (stmt) => {
        calls.run.push(stmt);
        return script.run ? script.run(stmt) : EMPTY;
      },
      withTimeout: async (_ms, fn) =>
        fn(async (stmt) => {
          calls.timeout.push(stmt);
          return script.timeout ? script.timeout(stmt) : EMPTY;
        }),
    },
    acquire: async () => {
      calls.acquire++;
      const r = script.acquire ? script.acquire() : () => {};
      return r ? () => { calls.release++; r(); } : null;
    },
  };
  return { d, calls };
}

const timeoutError = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

describe("statement_timeout (57014) → repli « fiche seule »", () => {
  it("erreur brute du pilote", async () => {
    const { d, calls } = deps({ timeout: () => { throw timeoutError(); }, run: () => [hitRow()] });
    const out = await searchClients(actor, input("tremblay"), d);
    expect(out.meta.degraded).toBe("timeout");
    expect(calls.timeout).toHaveLength(1);
    expect(isDeep(calls.timeout[0])).toBe(true);
    expect(calls.run).toHaveLength(1);
    expect(isDeep(calls.run[0])).toBe(false);
    expect(calls.release).toBe(1);
    expect(out.hits.map((h) => h.item.fullName)).toEqual(["Jean Tremblay"]);
  });

  it("erreur enveloppée dans DrizzleQueryError", async () => {
    const wrapped = new DrizzleQueryError("select …", [], timeoutError());
    expect(isStatementTimeout(wrapped)).toBe(true);
    const { d, calls } = deps({ timeout: () => { throw wrapped; } });
    const out = await searchClients(actor, input("tremblay"), d);
    expect(out.meta.degraded).toBe("timeout");
    expect(calls.run).toHaveLength(1);
    expect(isDeep(calls.run[0])).toBe(false);
    expect(calls.release).toBe(1);
  });

  it("une autre erreur remonte telle quelle, et la place est rendue", async () => {
    const { d, calls } = deps({ timeout: () => { throw Object.assign(new Error("boom"), { code: "42703" }); } });
    await expect(searchClients(actor, input("tremblay"), d)).rejects.toThrow("boom");
    expect(calls.release).toBe(1);
    expect(calls.run).toHaveLength(0);
  });
});

describe("robinet saturé → « busy »", () => {
  it("aucune transaction, la fiche seule répond", async () => {
    const { d, calls } = deps({ acquire: () => null, run: () => [hitRow()] });
    const out = await searchClients(actor, input("tremblay"), d);
    expect(out.meta.degraded).toBe("busy");
    expect(calls.timeout).toHaveLength(0);
    expect(calls.run).toHaveLength(1);
    expect(isDeep(calls.run[0])).toBe(false);
    expect(out.total).toBe(1);
  });

  it("pas de relance floue après un repli", async () => {
    const { d, calls } = deps({ acquire: () => null });
    const out = await searchClients(actor, input("trembly"), d);
    expect(out.meta.degraded).toBe("busy");
    expect(out.meta.approximate).toBe(false);
    expect(calls.run).toHaveLength(1);
  });
});

describe("signal annulé, exclusions seules : aucune requête", () => {
  it("signal déjà annulé", async () => {
    const ac = new AbortController();
    ac.abort();
    const { d, calls } = deps({});
    const out = await searchClients(actor, input("tremblay", { signal: ac.signal }), d);
    expect(out.hits).toEqual([]);
    expect(calls.run.length + calls.timeout.length + calls.acquire).toBe(0);
  });

  // L'attente d'une place peut durer 750 ms : la frappe suivante a le temps
  // d'annuler. Une recherche morte ne doit ni tenir la place 3 s, ni la
  // connexion, ni pousser la recherche VIVANTE vers « busy ».
  it("annulé PENDANT l'attente d'une place : aucune requête, place rendue", async () => {
    const ac = new AbortController();
    const { d, calls } = deps({
      acquire: () => {
        ac.abort();
        return () => {};
      },
    });
    const out = await searchClients(actor, input("tremblay", { signal: ac.signal }), d);
    expect(out.hits).toEqual([]);
    expect(out.total).toBe(0);
    expect(calls.acquire).toBe(1);
    expect(calls.timeout).toHaveLength(0);
    expect(calls.run).toHaveLength(0);
    expect(calls.release).toBe(1);
  });

  it("annulé pendant une attente VAINE (robinet saturé) : pas de repli « fiche seule »", async () => {
    const ac = new AbortController();
    const { d, calls } = deps({
      acquire: () => {
        ac.abort();
        return null;
      },
    });
    const out = await searchClients(actor, input("tremblay", { signal: ac.signal }), d);
    expect(out.total).toBe(0);
    expect(calls.run).toHaveLength(0);
    expect(calls.timeout).toHaveLength(0);
  });

  it("annulé pendant une recherche profonde trop lente : pas de repli après le délai", async () => {
    const ac = new AbortController();
    const { d, calls } = deps({
      timeout: () => {
        ac.abort();
        throw timeoutError();
      },
      run: () => [hitRow()],
    });
    const out = await searchClients(actor, input("tremblay", { signal: ac.signal }), d);
    expect(out.total).toBe(0);
    expect(calls.timeout).toHaveLength(1);
    expect(calls.run).toHaveLength(0);
    expect(calls.release).toBe(1);
  });

  it("« -rosemont » seul", async () => {
    const { d, calls } = deps({});
    const out = await listSearchResponse(actor, input("-rosemont"), d);
    expect(out).toMatchObject({ items: [], total: 0, page: 1, pageSize: 8 });
    expect(out.search.onlyExclusions).toBe(true);
    expect(calls.run.length + calls.timeout.length + calls.acquire).toBe(0);
  });
});

describe("relance « faute de frappe »", () => {
  it("0 strict + terme éligible → UNE relance floue, sous la même place, `approximate`", async () => {
    const { d, calls } = deps({ timeout: (stmt) => (isFuzzy(stmt) ? [hitRow({ name_x: 0, name_f: 1, score: 30 })] : EMPTY) });
    const out = await searchClients(actor, input("trembly"), d);
    expect(calls.timeout).toHaveLength(2);
    expect(isFuzzy(calls.timeout[0])).toBe(false);
    expect(isFuzzy(calls.timeout[1])).toBe(true);
    expect(calls.acquire).toBe(1);
    expect(calls.release).toBe(1);
    expect(out.meta.approximate).toBe(true);
    expect(out.plan.fuzzy).toBe(true);
    expect(out.hits[0].item.match.reasons[0]).toMatchObject({ field: "name", level: "fuzzy" });
  });

  it("la relance ne trouve rien non plus → pas d'`approximate`", async () => {
    const { d, calls } = deps({});
    const out = await searchClients(actor, input("trembly"), d);
    expect(calls.timeout).toHaveLength(2);
    expect(out.meta.approximate).toBe(false);
    expect(out.total).toBe(0);
  });

  it("résultat strict non vide → pas de relance", async () => {
    const { d, calls } = deps({ timeout: () => [hitRow()] });
    const out = await searchClients(actor, input("trembly"), d);
    expect(calls.timeout).toHaveLength(1);
    expect(out.meta.approximate).toBe(false);
  });

  it("identity ne relance jamais (et ne prend pas de place au robinet)", async () => {
    const { d, calls } = deps({});
    const out = await searchClients(actor, input("trembly", { mode: "identity" }), d);
    expect(calls.run).toHaveLength(1);
    expect(calls.timeout).toHaveLength(0);
    expect(calls.acquire).toBe(0);
    expect(out.meta.approximate).toBe(false);
  });

  it("sous `dans:notes` → pas de relance (le flou ne lit que nom et ville)", async () => {
    const { d, calls } = deps({});
    await searchClients(actor, input("dans:notes trembly"), d);
    expect(calls.timeout).toHaveLength(1);
  });

  it("terme non éligible (4 lettres) → pas de relance", async () => {
    const { d, calls } = deps({});
    await searchClients(actor, input("trem"), d);
    expect(calls.timeout).toHaveLength(1);
  });

  it("une relance trop lente garde le résultat strict, sans repli", async () => {
    const { d, calls } = deps({
      timeout: (stmt) => {
        if (isFuzzy(stmt)) throw timeoutError();
        return EMPTY;
      },
    });
    const out = await searchClients(actor, input("trembly"), d);
    expect(out.meta.degraded).toBeNull();
    expect(out.meta.approximate).toBe(false);
    expect(calls.run).toHaveLength(0);
    expect(calls.release).toBe(1);
  });
});

describe("relecture des lignes", () => {
  it("forme de la ligne, facettes, `features` hors de la réponse", async () => {
    const { d } = deps({ timeout: () => [hitRow()] });
    const out = await listSearchResponse(actor, input("tremblay"), d);
    expect(out.total).toBe(1);
    expect(out.search.facets).toEqual({ all: 1, contact: 1, profile: 0, notes: 0 });
    const item = out.items[0];
    expect(item).toMatchObject({
      fullName: "Jean Tremblay",
      phone: "+14185551234",
      contactHidden: false,
      categoryId: 3,
      categoryColor: "#ff0000",
      city: "Lévis",
      doNotCall: false,
    });
    expect(item.match.score).toBe(100);
    expect(item.match.nameRanges).toEqual([[5, 13]]);
    expect(item.match.href).toBe(`/clients/${item.id}`);
    expect("features" in item).toBe(false);
    expect(JSON.stringify(out)).not.toContain("features");
  });

  it("la ligne hors page (id null) donne `items: []` et garde le total", async () => {
    const { d } = deps({ timeout: () => [{ ...EMPTY[0], total: 12, n_all: 12 }] });
    const out = await listSearchResponse(actor, input("tremblay", { page: 9 }), d);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(12);
  });
});

describe("createLimiter", () => {
  it("4 places ; la 5e attend puis abandonne ; une place rendue passe au suivant", async () => {
    vi.useFakeTimers();
    try {
      const lim = createLimiter(4);
      const held = await Promise.all([1, 2, 3, 4].map(() => lim.acquire(750)));
      expect(held.every((r) => typeof r === "function")).toBe(true);
      expect(lim.active()).toBe(4);

      const late = lim.acquire(750);
      expect(lim.waiting()).toBe(1);
      await vi.advanceTimersByTimeAsync(751);
      expect(await late).toBeNull();
      expect(lim.waiting()).toBe(0);

      const next = lim.acquire(750);
      held[0]!();
      held[0]!(); // rendre deux fois est sans effet
      const got = await next;
      expect(typeof got).toBe("function");
      expect(lim.active()).toBe(4);
      got!();
      for (const r of held.slice(1)) r!();
      expect(lim.active()).toBe(0);
      expect(await lim.acquire(0)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
