// Credential encryption at rest. This is the only test that covers the path a
// real database dump would expose, so it asserts the property that matters:
// the stored blob does not contain the plaintext.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encryptCredentials, decryptCredentials } from "../src/credentials.js";

const KEY = "test-credential-key-0123456789";

test("ciphertext round-trips and does not contain the plaintext", () => {
  const creds = { botId: "bot-123", secret: "super-secret-value" };
  const blob = encryptCredentials(KEY, creds);
  assert.ok(!blob.includes("super-secret-value"), "the blob must not leak the plaintext");
  assert.ok(!blob.includes("bot-123"));
  assert.deepEqual(decryptCredentials(KEY, blob), creds);
});

test("the same plaintext encrypts differently each time (random IV)", () => {
  const a = encryptCredentials(KEY, { secret: "same" });
  const b = encryptCredentials(KEY, { secret: "same" });
  assert.notEqual(a, b);
});

test("a wrong key fails loudly instead of returning garbage", () => {
  const blob = encryptCredentials(KEY, { secret: "x" });
  assert.throws(() => decryptCredentials("a-different-key-0123456789", blob));
});

test("a tampered blob is rejected by the auth tag", () => {
  const blob = encryptCredentials(KEY, { secret: "x" });
  const parts = blob.split(":");
  // Flip one byte of the ciphertext body.
  const body = Buffer.from(parts[3], "base64");
  body[0] ^= 0xff;
  parts[3] = body.toString("base64");
  assert.throws(() => decryptCredentials(KEY, parts.join(":")));
});

test("a malformed blob is a clean refusal", () => {
  assert.throws(() => decryptCredentials(KEY, "not-a-blob"), /unreadable/);
  assert.throws(() => decryptCredentials(KEY, ""), /unreadable/);
});

test("random keys from the documented recipe are long enough", () => {
  const key = crypto.randomBytes(32).toString("base64url");
  assert.ok(key.length >= 16);
  assert.deepEqual(decryptCredentials(key, encryptCredentials(key, { a: 1 })), { a: 1 });
});
