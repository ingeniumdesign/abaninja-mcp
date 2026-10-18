// Offline tests for the API client: path checks, mode rules and token handling. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbaNinjaClient, checkAllowed, loadConfig } from "../dist/abaninja.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000000";
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init.method, body: init.body });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};
const client = (mode) => new AbaNinjaClient({ token: "test-token", accountUuid: ACCOUNT, mode });

test("paths that could leave api.abaninja.ch or dodge the mode check are rejected before any request", async () => {
  const bad = [
    "/\t/evil.example/collect",
    "/\n/evil.example/collect",
    "/\r/evil.example/collect",
    "//evil.example/collect",
    "https://evil.example/collect",
    "/accounts/{accountUuid}/documents/v2/invoices?limit=1",
    "/accounts/{accountUuid}/documents/v2/invoices/u/actions/email#x",
    "/accounts/{accountUuid}/documents/v2/invoices/u/actions/./email",
    "/accounts/{accountUuid}/documents/v2/invoices/u/actions/x/../email",
    "/accounts/{accountUuid}/documents/v2/invoices/u/actions/%65mail",
    "/accounts/{accountUuid}/documents/v2/invoices/u/actions/email/",
    "/accounts/{accountUuid}/documents/v2/invoices/u/actions/delete\t",
    "/accounts/{accountUuid}/documents v2",
    "accounts/{accountUuid}/documents/v2/invoices",
  ];
  for (const path of bad) {
    calls.length = 0;
    await assert.rejects(client("full").request("GET", path), /plain API path/, JSON.stringify(path));
    assert.equal(calls.length, 0, JSON.stringify(path));
  }
});

test("read mode allows only GET", () => {
  assert.equal(checkAllowed("read", "GET", "/x"), null);
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
    assert.match(checkAllowed("read", method, "/x"), /read mode/);
  }
});

test("write mode blocks sending, deleting, dunning, bulk actions and webhook changes", () => {
  const doc = "/accounts/x/documents/v2/invoices/u";
  const blocked = [
    ...["email", "plannedMail", "sendAbaNet", "sendPaymentConfirmation", "delete", "cancel", "cancelPermanently",
      "dunningSent", "dunningPrint", "setDunningAmounts"].map((action) => ["PATCH", `${doc}/actions/${action}`]),
    ["PATCH", "/accounts/x/documents/v2/invoices/bulk-actions/massSent"],
    ["POST", "/accounts/x/webhooks/v2/outgoing-webhooks"],
    ["PATCH", "/accounts/x/webhooks/v2/outgoing-webhooks/u"],
    ["POST", "/accounts/x/webhooks/v2/outgoing-webhooks/u/send-test"],
    ["DELETE", "/accounts/x/addresses/v2/companies/u"],
  ];
  for (const [method, path] of blocked) {
    assert.notEqual(checkAllowed("write", method, path), null, `${method} ${path}`);
    assert.equal(checkAllowed("full", method, path), null, `${method} ${path} in full mode`);
  }
  assert.equal(checkAllowed("write", "POST", "/accounts/x/addresses/v2/addresses"), null);
  assert.equal(checkAllowed("write", "PATCH", `${doc}/actions/markSent`), null);
  assert.equal(checkAllowed("write", "GET", "/accounts/x/documents/v2/invoices/bulk-actions"), null);
  assert.equal(checkAllowed("write", "GET", "/accounts/x/webhooks/v2/outgoing-webhooks"), null);
});

test("write mode blocks payment confirmation e-mails", () => {
  const payments = "/accounts/x/finances/v2/payments";
  const send = { processing: { type: "receipt", sendPaymentConfirmation: true } };
  assert.match(checkAllowed("write", "POST", payments, send), /full mode/);
  assert.match(checkAllowed("write", "PATCH", `${payments}/u`, send), /full mode/);
  assert.equal(checkAllowed("write", "POST", payments, { processing: { sendPaymentConfirmation: false } }), null);
  assert.equal(checkAllowed("full", "POST", payments, send), null);
});

test("a _method override cannot turn an allowed call into a blocked one", () => {
  const company = "/accounts/x/addresses/v2/companies/u";
  for (const query of [{ _method: "DELETE" }, { ".method": "DELETE" }, { " _method": "DELETE" }, { _METHOD: "delete" }]) {
    assert.match(checkAllowed("write", "POST", company, undefined, query), /_method/, JSON.stringify(query));
  }
  assert.match(checkAllowed("write", "POST", company, { _method: "DELETE" }), /_method/);
  assert.match(checkAllowed("write", "PATCH", company, { _method: "DELETE", company_name: "x" }), /_method/);
  assert.match(checkAllowed("read", "GET", company, undefined, { _method: "DELETE" }), /_method/);
  assert.equal(checkAllowed("full", "POST", company, { _method: "DELETE" }), null);
  assert.equal(
    checkAllowed("write", "POST", "/accounts/x/addresses/v2/addresses", { type: "company", name: "Muster AG" }, { force: false }),
    null,
  );
});

test("tokens with line breaks, spaces or control characters are rejected without echoing them", () => {
  for (const token of ["SECRET\nabc", "SECRET\rabc", "SECRET abc", "SECRET\u0000abc"]) {
    assert.throws(() => loadConfig({ ABANINJA_API_TOKEN: token }), (error) => !error.message.includes("SECRET"));
  }
  assert.equal(loadConfig({ ABANINJA_API_TOKEN: " abc.def-123 " }).token, "abc.def-123");
  assert.equal(loadConfig({ ABANINJA_API_TOKEN: "abc" }).mode, "read");
  assert.throws(() => loadConfig({ ABANINJA_API_TOKEN: "abc", ABANINJA_MODE: "admin" }), /read, write or full/);
});

test("requests go to api.abaninja.ch with the account filled in and list values repeated", async () => {
  calls.length = 0;
  await client("read").request("GET", "/accounts/{accountUuid}/addresses/v2/companies", {
    query: { "tags[]": ["VIP", "A"], limit: 5 },
  });
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://api.abaninja.ch");
  assert.equal(url.pathname, `/accounts/${ACCOUNT}/addresses/v2/companies`);
  assert.deepEqual(url.searchParams.getAll("tags[]"), ["VIP", "A"]);
  assert.equal(url.searchParams.get("limit"), "5");
});

test("binary responses are described, not decoded", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(1234), { status: 200, headers: { "content-type": "application/pdf" } });
  try {
    const result = await client("read").request("GET", "/accounts/{accountUuid}/documents/v2/invoices/u/files/f");
    assert.deepEqual(result, { contentType: "application/pdf", bytes: 1234, note: "Binary content is not shown." });
  } finally {
    globalThis.fetch = saved;
  }
});
