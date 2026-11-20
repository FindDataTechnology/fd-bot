// Shared outbound HTTP: deadline-bound fetch. Ported from paas lib so the
// transport's call discipline matches the rest of the fleet.
// Platform API calls FROM A CHINA EGRESS take ~11s to slack.com (measured on
// cheap-4, 2026-11-20: three of four attempts timed out at 10s, the fourth took
// 10971ms). The default is therefore 30s for adapter calls — a 10s ceiling is a
// guaranteed failure on this side of the Great Firewall, and the failure reads
// as "the platform is down".
export const PLATFORM_TIMEOUT_MS = 30_000;

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
