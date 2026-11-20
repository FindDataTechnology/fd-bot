// 企业微信 / 微信公众号 shared payload plumbing.
//
// Ported from paas `server/bots/adapter.js`. The WeCom/WeChat payloads are always
// flat `<xml><Tag><![CDATA[value]]></Tag>…</xml>` with no nesting or attributes.
//
// shortcut: a regex extractor, not an XML parser — the platforms' own docs
// specify a flat shape. Swap in a real parser if a nested payload ever appears.

export function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`).exec(String(xml ?? ""));
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}
