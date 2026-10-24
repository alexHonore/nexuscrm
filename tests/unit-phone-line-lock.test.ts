import { afterEach, describe, expect, it, vi } from "vitest";
import { acquirePhoneLine } from "@/lib/telephony/phone-line-lock";

function browserLocks() {
  let held = false;
  const queue: Array<() => void> = [];
  const request = (_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: object | null) => Promise<void>) => new Promise<void>((resolve, reject) => {
    const run = () => {
      options.signal?.removeEventListener("abort", abort);
      held = true;
      Promise.resolve(callback({})).then(resolve, reject).finally(() => {
        held = false;
        queue.shift()?.();
      });
    };
    const abort = () => {
      const i = queue.indexOf(run);
      if (i >= 0) queue.splice(i, 1);
      reject(new Error("aborted"));
    };
    if (options.signal?.aborted) { reject(new Error("aborted")); return; }
    if (!held) run();
    else if (options.ifAvailable) Promise.resolve(callback(null)).then(resolve, reject);
    else {
      queue.push(run);
      options.signal?.addEventListener("abort", abort, { once: true });
    }
  });
  vi.stubGlobal("navigator", { locks: { request } });
}
afterEach(() => vi.unstubAllGlobals());

describe("one phone registration across browser tabs", () => {
  it("keeps the second tab waiting and gives it the line when the owner leaves", async () => {
    browserLocks();
    const waiting = vi.fn();
    const releaseFirst = await acquirePhoneLine(new AbortController().signal, waiting);
    expect(waiting).not.toHaveBeenCalled();
    const acquired = vi.fn();
    const second = acquirePhoneLine(new AbortController().signal, waiting).then((release) => { acquired(); return release; });
    expect(waiting).toHaveBeenCalledOnce();
    expect(acquired).not.toHaveBeenCalled();
    releaseFirst();
    const releaseSecond = await second;
    expect(acquired).toHaveBeenCalledOnce();
    releaseSecond();
  });

  it("aborts a waiting tab without disturbing the current call owner", async () => {
    browserLocks();
    const release = await acquirePhoneLine(new AbortController().signal, vi.fn());
    const waiting = new AbortController();
    const pending = acquirePhoneLine(waiting.signal, vi.fn()).catch((e) => e.message);
    waiting.abort();
    expect(await pending).toBe("aborted");
    const nextWaiting = vi.fn();
    const next = acquirePhoneLine(new AbortController().signal, nextWaiting);
    expect(nextWaiting).toHaveBeenCalledOnce();
    release();
    (await next)();
  });

  it("releases a held line on unmount, including React's development remount", async () => {
    browserLocks();
    const mounted = new AbortController();
    await acquirePhoneLine(mounted.signal, vi.fn());
    mounted.abort();
    const release = await acquirePhoneLine(new AbortController().signal, vi.fn());
    release();
  });

  it("works on browsers without Web Locks and rejects an already-canceled boot", async () => {
    vi.stubGlobal("navigator", {});
    expect(await acquirePhoneLine(new AbortController().signal, vi.fn())).toBeTypeOf("function");
    const gone = new AbortController();
    gone.abort();
    await expect(acquirePhoneLine(gone.signal, vi.fn())).rejects.toThrow("canceled");
  });
});
