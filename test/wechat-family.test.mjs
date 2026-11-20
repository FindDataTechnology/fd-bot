// The three WeChat-family legs: protocols ported verbatim, plus the one thing a
// port must not get wrong — the 32-byte padding block and the GET handshake.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import wecom, { encrypt as wecomEncrypt, decrypt as wecomDecrypt, signature as wecomSignature } from "../src/adapters/wecom.js";
import wechatOa from "../src/adapters/wechat-oa.js";
import wecomWebhook, { isValidWebhookUrl, webhookFingerprint } from "../src/adapters/wecom-webhook.js";

const AES_KEY = crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43);
const CORP = "wx5823bf96d3bd56c7";
const wecomCred = { token: "QDG6eK", encodingAesKey: AES_KEY, corpId: CORP, corpSecret: "s", agentId: "1" };
const signed = (ciphertext) => ({
  msg_signature: wecomSignature(wecomCred.token, "1409659813", "1372623149", ciphertext),
  timestamp: "1409659813",
  nonce: "1372623149",
});

// ── wecom ───────────────────────────────────────────────────────────────────

test("wecom: the URL echo-verify handshake decrypts echostr", () => {
  const echostr = wecomEncrypt(AES_KEY, "1616140317555161061", CORP);
  const out = wecom.parseCallback({
    method: "GET",
    query: { ...signed(echostr), echostr },
    credentials: wecomCred,
  });
  assert.equal(out.handshake, "1616140317555161061");
});

test("wecom: a signed text message decrypts into our shape", () => {
  const inner =
    "<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName>" +
    "<FromUserName><![CDATA[mycreate]]></FromUserName><CreateTime>1409659813</CreateTime>" +
    "<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>4561255354251345929</MsgId></xml>";
  const ciphertext = wecomEncrypt(AES_KEY, inner, CORP);
  const out = wecom.parseCallback({
    method: "POST",
    query: signed(ciphertext),
    raw: Buffer.from(`<xml><ToUserName><![CDATA[wx]]></ToUserName><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`),
    credentials: wecomCred,
  });
  assert.equal(out.message.chatKey, "mycreate");
  assert.equal(out.message.text, "你好");
  assert.equal(out.message.platformMessageId, "4561255354251345929");
});

test("wecom: a tampered signature is refused before decrypt", () => {
  const ciphertext = wecomEncrypt(AES_KEY, "<xml/>", CORP);
  assert.throws(
    () =>
      wecom.parseCallback({
        method: "POST",
        query: { ...signed(ciphertext), msg_signature: "deadbeef" },
        raw: Buffer.from(`<xml><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`),
        credentials: wecomCred,
      }),
    /bad msg_signature/,
  );
});

test("wecom: the AES envelope uses a 32-byte padding block (not 16)", () => {
  // The classic way this integration produces garbage: padding to 16. A payload
  // whose length is not a multiple of 32 only round-trips under the right block.
  for (const len of [1, 15, 16, 17, 31, 32, 33, 100]) {
    const message = "x".repeat(len);
    const enc = wecomEncrypt(AES_KEY, message, CORP);
    assert.equal(wecomDecrypt(AES_KEY, enc).message, message, `length ${len}`);
  }
});

test("wecom: a non-text message is handed back as null, not silently dropped", () => {
  const inner = "<xml><FromUserName><![CDATA[u]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[msg_audit_approved]]></Event></xml>";
  const ciphertext = wecomEncrypt(AES_KEY, inner, CORP);
  const out = wecom.parseCallback({
    method: "POST",
    query: signed(ciphertext),
    raw: Buffer.from(`<xml><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`),
    credentials: wecomCred,
  });
  assert.equal(out.message, null);
  assert.match(out.eventXml, /msg_audit_approved/, "the event XML is handed up so a consumer can decide");
});

test("wecom: group ids and member ids go to different APIs", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("gettoken")) {
      return new Response(JSON.stringify({ access_token: "T", expires_in: 7200 }), { status: 200 });
    }
    urls.push(String(url));
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  const t = wecom.createTransport({ credentials: wecomCred }, { fetchImpl });
  await t.sendText("wrAbCdEf123456", "to the group");
  await t.sendText("zhangsan", "to the member");
  assert.match(urls[0], /appchat\/send/);
  assert.match(urls[1], /message\/send/);
});

test("wecom: declares a proactive but IP-gated outbound path", () => {
  assert.deepEqual(wecom.outbound, { mode: "proactive-ip-gated", inbound: true });
});

// ── wechat-oa ───────────────────────────────────────────────────────────────

const oaQuery = (extra = {}) => {
  const q = { timestamp: "1409659813", nonce: "1372623149", ...extra };
  q.signature = crypto.createHash("sha1").update(["weixin", q.timestamp, q.nonce].sort().join("")).digest("hex");
  return q;
};
const oaCred = { token: "weixin", appId: "a", appSecret: "s" };

test("wechat-oa: the GET handshake echoes echostr verbatim", () => {
  const out = wechatOa.parseCallback({ method: "GET", query: oaQuery({ echostr: "ech-1" }), credentials: oaCred });
  assert.equal(out.handshake, "ech-1");
});

test("wechat-oa: a text message parses; an image does not", () => {
  const raw = Buffer.from(
    "<xml><ToUserName><![CDATA[toUser]]></ToUserName><FromUserName><![CDATA[fromUser]]></FromUserName>" +
      "<CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType>" +
      "<Content><![CDATA[this is a test]]></Content><MsgId>1234567890123456</MsgId></xml>",
  );
  const out = wechatOa.parseCallback({ method: "POST", query: oaQuery(), raw, credentials: oaCred });
  assert.equal(out.message.chatKey, "fromUser");
  assert.equal(out.message.text, "this is a test");
  assert.equal(out.message.platformMessageId, "1234567890123456");

  const image = Buffer.from(raw.toString().replace("text", "image"));
  assert.equal(wechatOa.parseCallback({ method: "POST", query: oaQuery(), raw: image, credentials: oaCred }).message, null);
});

test("wechat-oa: a forged signature is refused", () => {
  const raw = Buffer.from("<xml/>");
  assert.throws(
    () => wechatOa.parseCallback({ method: "POST", query: { ...oaQuery(), signature: "bad" }, raw, credentials: oaCred }),
    /bad signature/,
  );
});

// ── wecom-webhook ───────────────────────────────────────────────────────────

test("wecom-webhook: the credential boundary refuses anything but the official URL", () => {
  assert.ok(isValidWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd-efgh"));
  // Anything that could redirect the credential is refused.
  assert.ok(!isValidWebhookUrl("https://evil.example/cgi-bin/webhook/send?key=12345678-abcd"));
  assert.ok(!isValidWebhookUrl("http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd"));
  assert.ok(!isValidWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send"));
});

test("wecom-webhook: the fingerprint exposes only the last 4 chars", () => {
  assert.equal(webhookFingerprint("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd-efgh"), "…efgh");
  assert.equal(webhookFingerprint("nonsense"), null);
});

test("wecom-webhook: a push-only leg declares exactly that", () => {
  assert.deepEqual(wecomWebhook.outbound, { mode: "url-keyed", inbound: false });
  assert.deepEqual(wecomWebhook.inboundModes, []);
  // Reaching an inbound parser is a routing bug and must say so.
  assert.throws(() => wecomWebhook.parseCallback({}), /no inbound path/);
});

test("wecom-webhook: a valid URL posts markdown; an invalid one refuses to send", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  const t = wecomWebhook.createTransport(
    { credentials: { groupWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh-1234" } },
    { fetchImpl },
  );
  await t.sendText("ignored", "**hi**");
  assert.equal(calls[0].body.msgtype, "markdown");

  const bad = wecomWebhook.createTransport({ credentials: { groupWebhookUrl: "https://evil.example/x" } }, { fetchImpl });
  await assert.rejects(() => bad.sendText("c", "x"), /not a valid group-robot webhook/);
});
