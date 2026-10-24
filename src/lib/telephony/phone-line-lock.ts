/** One registered phone per browser origin. Other CRM tabs keep working normally. */
export function acquirePhoneLine(signal: AbortSignal, onWaiting: () => void): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error("canceled"));
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    const hold = () => new Promise<void>((release) => {
      if (signal.aborted) { reject(new Error("canceled")); release(); return; }
      const done = () => {
        signal.removeEventListener("abort", done);
        release();
      };
      signal.addEventListener("abort", done, { once: true });
      resolve(done);
    });
    void locks.request("nexus-phone-line", { ifAvailable: true }, async (lock) => {
      if (signal.aborted) throw new Error("canceled");
      if (lock) return hold();
      onWaiting();
      // Never steal: doing so could tear down another tab's business call.
      return locks.request("nexus-phone-line", { signal }, hold);
    }).catch(reject);
  });
}
