/**
 * Unit tests for the pure helpers (no network, no credentials).
 * Run with: npm test  (node:test via tsx type-stripping)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimLongArrays } from "../src/garmin/client.js";
import { decodeJwtExp } from "../src/garmin/auth.js";
import { toSearchParams } from "../src/http/impersonate.js";

// --- trimLongArrays ----------------------------------------------------------

test("trimLongArrays truncates arrays longer than max", () => {
  const input = Array.from({ length: 60 }, (_, i) => i);
  const out = trimLongArrays(input, 50) as {
    _truncatedArray: boolean;
    _total: number;
    _shown: number;
    items: number[];
  };
  assert.equal(out._truncatedArray, true);
  assert.equal(out._total, 60);
  assert.equal(out._shown, 50);
  assert.equal(out.items.length, 50);
  assert.deepEqual(out.items.slice(0, 3), [0, 1, 2]);
});

test("trimLongArrays leaves short arrays as arrays", () => {
  assert.deepEqual(trimLongArrays([1, 2, 3], 50), [1, 2, 3]);
});

test("trimLongArrays recurses into nested structures", () => {
  const input = { a: Array.from({ length: 60 }, (_, i) => i), b: { c: [1, 2] } };
  const out = trimLongArrays(input, 50) as {
    a: { _truncatedArray: boolean; _shown: number };
    b: { c: number[] };
  };
  assert.equal(out.a._truncatedArray, true);
  assert.equal(out.a._shown, 50);
  assert.deepEqual(out.b.c, [1, 2]);
});

test("trimLongArrays drops __proto__ and does not pollute Object.prototype", () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"keep":1}');
  const out = trimLongArrays(payload) as Record<string, unknown>;
  assert.equal(out.keep, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("trimLongArrays passes primitives and null through unchanged", () => {
  assert.equal(trimLongArrays(5), 5);
  assert.equal(trimLongArrays("x"), "x");
  assert.equal(trimLongArrays(null), null);
  assert.equal(trimLongArrays(true), true);
});

// --- decodeJwtExp ------------------------------------------------------------

function makeJwt(payload: object): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

test("decodeJwtExp returns the exp claim", () => {
  assert.equal(decodeJwtExp(makeJwt({ exp: 1893456000 })), 1893456000);
});

test("decodeJwtExp returns null when exp is missing", () => {
  assert.equal(decodeJwtExp(makeJwt({ sub: "abc" })), null);
});

test("decodeJwtExp returns null for malformed tokens", () => {
  assert.equal(decodeJwtExp("not-a-jwt"), null);
  assert.equal(decodeJwtExp("a.@@@notbase64@@@.c"), null);
  assert.equal(decodeJwtExp(""), null);
});

// --- toSearchParams ----------------------------------------------------------

test("toSearchParams skips undefined and stringifies scalars, preserving order", () => {
  const qs = toSearchParams({
    a: "1",
    b: 2,
    c: true,
    d: undefined,
  }).toString();
  assert.equal(qs, "a=1&b=2&c=true");
});
