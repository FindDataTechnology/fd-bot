// Adapter registry and capability validation.
//
// This module owns the ONE piece of semantics fd-bot is allowed to have:
// `outbound:{mode,inbound}`. It lives here — beside the adapters, validated at
// startup — because the exact failure this service exists to prevent is the
// contract, the implementation and the gate drifting into three places. See
// `openspec/changes/adopt-fd-bot-transport/design.md` D4.
//
// `add-mattermost-channel` measured the alternative: Slack landed one day after
// the capability contract, declared nothing, and `outboundCapabilityFor("slack")`
// answered `{mode:"none"}` while the adapter could clearly `chat.postMessage`.
// The panel told the operator "cannot send back" and the binding PUT refused.

export const OUTBOUND_MODES = ["url-keyed", "proactive-ip-gated", "passive-window", "none"];

/**
 * Validate one adapter module export. Returns a list of human-readable problems.
 * Empty list = registrable.
 */
export function adapterProblems(adapter) {
  const out = [];
  const name = adapter?.platform || "<unnamed>";
  if (!adapter?.platform) out.push(`${name}: missing "platform"`);
  if (!adapter || typeof adapter.createTransport !== "function") {
    out.push(`${name}: missing createTransport(binding)`);
  }
  const ob = adapter?.outbound;
  if (!ob || typeof ob !== "object") {
    // Not a warning: an adapter that does not state its outbound shape is how
    // "can receive, cannot send" hides behind a healthy-looking panel.
    out.push(`${name}: missing "outbound" — every adapter MUST state {mode, inbound}`);
  } else {
    if (!OUTBOUND_MODES.includes(ob.mode)) {
      out.push(`${name}: outbound.mode "${ob.mode}" is not one of ${OUTBOUND_MODES.join(" / ")}`);
    }
    if (typeof ob.inbound !== "boolean") {
      out.push(`${name}: outbound.inbound must be a boolean`);
    }
  }
  // The two declarations must agree: a push-only leg cannot receive, and a leg
  // with no outbound path is not automatically inbound-only.
  if (ob && ob.mode === "none" && ob.inbound !== false) {
    out.push(`${name}: outbound.mode "none" requires inbound:false (nothing can be sent anyway)`);
  }
  if (adapter?.inboundModes && !Array.isArray(adapter.inboundModes)) {
    out.push(`${name}: inboundModes must be an array when present`);
  }
  return out;
}

export function createRegistry(adapters = []) {
  const byName = new Map();
  for (const a of adapters) {
    const problems = adapterProblems(a);
    if (problems.length) {
      const err = new Error(`invalid adapter(s):\n  ${problems.join("\n  ")}`);
      err.code = "INVALID_ADAPTER";
      throw err;
    }
    if (byName.has(a.platform)) {
      const err = new Error(`duplicate adapter for platform "${a.platform}"`);
      err.code = "DUPLICATE_ADAPTER";
      throw err;
    }
    byName.set(a.platform, a);
  }
  return {
    get: (platform) => byName.get(platform) ?? null,
    all: () => [...byName.values()],
    /** The browser/consumer-facing capability list. One source, no hand copies. */
    capabilities: () =>
      [...byName.values()].map((a) => ({
        platform: a.platform,
        outbound: { mode: a.outbound.mode, inbound: a.outbound.inbound },
        inboundModes: a.inboundModes ?? ["callback"],
      })),
  };
}
