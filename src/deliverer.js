// Subscriber delivery: envelope → subscriberUrl, with confirmation and backoff.
//
// The caller's 2xx is the ONLY confirmation. A subscriber that answers non-2xx
// or times out means "not delivered" — retried with exponential backoff, then
// marked failed with a stable note so the record stays inspectable.
//
// A delivery must never block the platform's callback: the callback path only
// persists and acks. Everything here runs after that ack.

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function createDeliverer({ timeoutMs = 10_000, maxAttempts = 8, fetchImpl = globalThis.fetch, log = console, timers = null } = {}) {
  const sleep = (ms) => new Promise((r) => (timers?.setTimeout ?? setTimeout)(r, ms));
  const inflight = new Set();

  /**
   * Deliver one envelope. Resolves `{ ok, status, attempts }`.
   * Throws only on programmer error (missing subscriberUrl) — transport
   * failures are outcomes, not exceptions, because the caller must record them.
   */
  async function deliver({ envelope, subscriberUrl, deliveryToken, onAttempt = null }) {
    if (!subscriberUrl) throw new Error("subscriberUrl is required");
    let lastFailure = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let ctrl = null;
      try {
        ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(subscriberUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${deliveryToken}`,
            },
            body: JSON.stringify(envelope),
            signal: ctrl.signal,
          });
          // Drain the body: an unread response keeps the socket unusable and the
          // NEXT call fails with a transport error instead of the real one.
          const text = await res.text().catch(() => "");
          if (res.ok) {
            onAttempt?.({ attempt, ok: true, status: res.status });
            return { ok: true, status: res.status, attempts: attempt };
          }
          lastFailure = { status: res.status, detail: text.slice(0, 200) };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastFailure = { status: 0, detail: err?.name === "AbortError" ? "timeout" : err.message };
      }
      onAttempt?.({ attempt, ok: false, ...lastFailure });
      if (attempt < maxAttempts) {
        await sleep(Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS));
      }
    }
    log.warn(`[deliver] giving up after ${maxAttempts} attempts: ${lastFailure?.status} ${lastFailure?.detail}`);
    return { ok: false, status: lastFailure?.status ?? 0, attempts: maxAttempts, detail: lastFailure?.detail };
  }

  /** Fire-and-forget variant used by the drain loop; tracks in-flight promises. */
  function deliverInBackground(args) {
    const p = deliver(args).finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  }

  async function drain() {
    await Promise.allSettled([...inflight]);
  }

  return { deliver, deliverInBackground, drain };
}
