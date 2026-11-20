// Shared outbound HTTP: deadline-bound fetch. Ported from paas lib so the
// transport's call discipline matches the rest of the fleet.
export async function fetchWithTimeout(url, init = {}, { timeoutMs = 15_000, fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error(`request timed out after ${timeoutMs}ms: ${url}`);
      e.code = "ETIMEDOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
