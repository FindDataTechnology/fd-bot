// Send-failure classification.
//
// `ip-not-allowed` and `reply-window-closed` are not "the service is broken" —
// they are the PLATFORM's verdict, and they need different operator actions:
//   ip-not-allowed      → change the egress, or move outbound to a URL-keyed leg
//   reply-window-closed → wait for the next inbound, or move to a leg that can
//                         send unprompted
// Answering 5xx for them would make a generic retry layer hammer a call that
// can never succeed. So they travel as `200 {ok:false, failure}`.
//
// Classification is NOT a substring match on vendor prose ("not allow to access
// from your ip" is a sentence WeCom can reword any day). Two sources are
// trusted: the stable error our own adapter throws, and the numeric platform
// codes that are part of the API contract.

export const FAILURES = ["ip-not-allowed", "reply-window-closed", "other"];

// WeCom / WeChat IP + frequency families, plus the passive-window code.
const IP_GATED_CODES = new Set([60020, 40164, 45009]);
const WINDOW_CODES = new Set([45015, 60140]); // 45015 response timeout, 60140 invalid/used response code

export function classifyFailure(err) {
  const text = String(err?.message ?? err ?? "");
  // Our own adapters throw these literal signals — the stable half of the contract.
  if (/no live response_url|reply-window-closed/i.test(text)) return "reply-window-closed";
  if (/ip-not-allowed/i.test(text)) return "ip-not-allowed";
  if (err?.failure && FAILURES.includes(err.failure)) return err.failure;
  for (const m of text.matchAll(/\b(\d{4,5})\b/g)) {
    const code = Number(m[1]);
    if (IP_GATED_CODES.has(code)) return "ip-not-allowed";
    if (WINDOW_CODES.has(code)) return "reply-window-closed";
  }
  return "other";
}

/** Rendered once, next to the classification that produces it. */
export function describeFailure(failure, fallbackDetail = "") {
  switch (failure) {
    case "ip-not-allowed":
      return "出口地址不被平台接受（企业可信 IP）——换出口或改用不受出口约束的出流通道";
    case "reply-window-closed":
      return "被动回复窗口已关闭——等群里再说一句，或改用可主动发送的出流通道";
    default:
      return fallbackDetail || "发送失败";
  }
}