// Credential encryption at rest.
//
// Binding credentials (bot secrets, encoding keys, app secrets) are the most
// dangerous thing this service holds. They are encrypted with AES-256-GCM under
// a key derived from FD_BOT_CREDENTIAL_KEY, so a database dump alone does not
// yield a working platform credential.
//
// The key is NOT stored beside the data; rotating it requires re-entering
// credentials (documented in the README). That is the honest trade: a key
// stored with the ciphertext protects against nothing.
import crypto from "node:crypto";

const derive = (secret) => crypto.createHash("sha256").update(String(secret)).digest();

export function encryptCredentials(secret, obj) {
  const key = derive(secret);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function decryptCredentials(secret, blob) {
  const [v, ivB64, tagB64, bodyB64] = String(blob ?? "").split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !bodyB64) throw new Error("unreadable credential blob");
  const d = crypto.createDecipheriv("aes-256-gcm", derive(secret), Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  const out = Buffer.concat([d.update(Buffer.from(bodyB64, "base64")), d.final()]);
  return JSON.parse(out.toString("utf8"));
}