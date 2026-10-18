// Offline tests for the API client: path checks, mode rules, accounts and errors. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbaNinjaClient, checkAllowed, loadConfig } from "../dist/abaninja.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000000";
const OTHER_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const calls = [];
let respond = () => json({ ok: true });
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init.method, body: init.body });
  return respond(String(url), init);
};
const client = (mode, accountUuid = ACCOUNT) => new AbaNinjaClient({ token: "test-token", accountUuid, mode });
const reset = () => {
  calls.length = 0;
  respond = () => json({ ok: true });
};

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
    reset();
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

test("write mode blocks sending, deleting, dunning, bulk actions, bank details and webhook changes", () => {
  const doc = "/accounts/x/documents/v2/invoices/u";
  const blocked = [
    ...["email", "plannedMail", "sendAbaNet", "sendPaymentConfirmation", "delete", "cancel", "cancelPermanently",
      "dunningSent", "dunningPrint", "dunningDate", "setDunningAmounts"].map((action) => ["PATCH", `${doc}/actions/${action}`]),
    ["PATCH", "/accounts/x/documents/v2/invoices/bulk-actions/massSent"],
    ["PATCH", "/accounts/x/documents/v2/invoices/settings/dunnings"],
    ["PATCH", "/accounts/x/documents/v2/invoices/settings/dunnings/dunning-level-1"],
    ["POST", "/accounts/x/webhooks/v2/outgoing-webhooks"],
    ["PATCH", "/accounts/x/webhooks/v2/outgoing-webhooks/u"],
    ["POST", "/accounts/x/webhooks/v2/outgoing-webhooks/u/send-test"],
    ["POST", "/accounts/x/finances/v2/bank-accounts"],
    ["PATCH", "/accounts/x/finances/v2/bank-accounts/u"],
    ["DELETE", "/accounts/x/addresses/v2/companies/u"],
  ];
  for (const [method, path] of blocked) {
    assert.notEqual(checkAllowed("write", method, path), null, `${method} ${path}`);
    assert.equal(checkAllowed("full", method, path), null, `${method} ${path} in full mode`);
  }
  assert.equal(checkAllowed("write", "POST", "/accounts/x/addresses/v2/addresses"), null);
  assert.equal(checkAllowed("write", "PATCH", `${doc}/actions/markSent`), null);
  assert.equal(checkAllowed("write", "GET", "/accounts/x/documents/v2/invoices/bulk-actions"), null);
  assert.equal(checkAllowed("write", "GET", "/accounts/x/finances/v2/bank-accounts"), null);
});

test("write mode refuses body fields that send, dun or fetch from another address, at any depth", () => {
  const cases = [
    ["POST", "/accounts/x/finances/v2/payments", { processing: { type: "receipt", sendPaymentConfirmation: true } }],
    ["POST", "/accounts/x/addresses/v2/addresses", { type: "company", name: "x", automatic_dunning: true }],
    ["PATCH", "/accounts/x/addresses/v2/companies/u", { automatic_dunning: "1" }],
    ["POST", "/accounts/x/documents/v2/invoices/import", { documents: [{ documentUrl: "https://evil.example/x.pdf" }] }],
    ["POST", "/accounts/x/documents/v2/supplier-credit-notes", { documents: [{ documentUrl: "https://evil.example/x.pdf" }] }],
  ];
  for (const [method, path, body] of cases) {
    assert.match(checkAllowed("write", method, path, body), /full mode/, JSON.stringify(body));
    assert.equal(checkAllowed("full", method, path, body), null);
  }
  for (const flag of [1, "1", "true", "on", "yes"]) {
    assert.notEqual(checkAllowed("write", "POST", "/accounts/x/finances/v2/payments", { processing: { sendPaymentConfirmation: flag } }), null);
  }
  for (const flag of [false, 0, "0", "false"]) {
    assert.equal(checkAllowed("write", "POST", "/accounts/x/finances/v2/payments", { processing: { sendPaymentConfirmation: flag } }), null);
  }
  assert.equal(checkAllowed("write", "PATCH", "/accounts/x/addresses/v2/companies/u", { automatic_dunning: false }), null);
});

test("query names of changing calls must be plain, so data cannot be smuggled past the body checks", () => {
  const payments = "/accounts/x/finances/v2/payments";
  assert.notEqual(checkAllowed("write", "POST", payments, {}, { "processing[sendPaymentConfirmation]": "1" }), null);
  assert.notEqual(checkAllowed("write", "POST", payments, {}, { processing: "x" }), null);
  assert.notEqual(checkAllowed("write", "POST", "/accounts/x/documents/v2/invoices/import", {}, { "documents[0][documentUrl]": "https://x" }), null);
  assert.equal(checkAllowed("write", "POST", "/accounts/x/addresses/v2/addresses", { type: "company", name: "x" }, { force: false }), null);
});

test("a _method override or a control character in a query name cannot change the call", () => {
  const company = "/accounts/x/addresses/v2/companies/u";
  for (const query of [{ _method: "DELETE" }, { ".method": "DELETE" }, { " _method": "DELETE" }, { _METHOD: "delete" },
    { "_method[]": "DELETE" }, { "_method\u0000": "DELETE" }, { "_method\u0000junk": "DELETE" }, { "x\u0001": "1" }]) {
    assert.notEqual(checkAllowed("write", "POST", company, {}, query), null, JSON.stringify(query));
  }
  assert.match(checkAllowed("write", "POST", company, { _method: "DELETE" }), /_method/);
  assert.match(checkAllowed("read", "GET", company, undefined, { _method: "DELETE" }), /_method/);
  assert.equal(checkAllowed("full", "POST", company, { _method: "DELETE" }), null);
});

test("configuration: tokens with control characters, unknown modes and malformed account uuids are refused", () => {
  for (const token of ["SECRET\nabc", "SECRET\rabc", "SECRET abc", "SECRET\u0000abc"]) {
    assert.throws(() => loadConfig({ ABANINJA_API_TOKEN: token }), (error) => !error.message.includes("SECRET"));
  }
  assert.equal(loadConfig({ ABANINJA_API_TOKEN: " abc.def-123 " }).token, "abc.def-123");
  assert.equal(loadConfig({ ABANINJA_API_TOKEN: "abc" }).mode, "read");
  assert.throws(() => loadConfig({ ABANINJA_API_TOKEN: "abc", ABANINJA_MODE: "admin" }), /read, write or full/);
  assert.throws(() => loadConfig({ ABANINJA_API_TOKEN: "abc", ABANINJA_ACCOUNT_UUID: "my-account" }), /must be a uuid/);
});

test("requests go to api.abaninja.ch with the account filled in and lists sent as name[]", async () => {
  reset();
  await client("read").request("GET", "/accounts/{accountUuid}/addresses/v2/companies", {
    query: { "tags[]": ["VIP", "A"], kind: ["x", "y"], limit: 5 },
  });
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://api.abaninja.ch");
  assert.equal(url.pathname, `/accounts/${ACCOUNT}/addresses/v2/companies`);
  assert.deepEqual(url.searchParams.getAll("tags[]"), ["VIP", "A"]);
  assert.deepEqual(url.searchParams.getAll("kind[]"), ["x", "y"]);
  assert.equal(url.searchParams.get("limit"), "5");
});

test("the server stays in its account, needs filled placeholders and a JSON body", async () => {
  reset();
  await assert.rejects(client("read").request("GET", `/accounts/${OTHER_ACCOUNT}/addresses/v2/companies`), /Other accounts/);
  await assert.rejects(client("read").request("GET", "/accounts/{accountUuid}/documents/v2/invoices/{invoiceUuid}"), /Fill in \{invoiceUuid\}/);
  await assert.rejects(client("write").request("POST", "/accounts/{accountUuid}/addresses/v2/addresses", { body: "{\"type\":\"company\"}" }), /JSON object/);
  assert.equal(calls.length, 0);
  await client("read").request("GET", `/accounts/${ACCOUNT}/addresses/v2/companies`);
  assert.equal(calls.length, 1);
});

test("without a configured account the only account is used, several accounts are listed in the error", async () => {
  reset();
  respond = (url) => (url.endsWith("/users/v2/me/accounts") ? json({ data: [{ uuid: ACCOUNT, name: "Muster AG" }] }) : json({ data: [] }));
  const single = client("read", "");
  await Promise.all([single.request("GET", "/accounts/{accountUuid}/addresses/v2/companies"), single.request("GET", "/accounts/{accountUuid}/addresses/v2/persons")]);
  assert.equal(calls.filter((c) => c.url.endsWith("/users/v2/me/accounts")).length, 1, "the lookup is shared");
  respond = () => json({ data: [{ uuid: ACCOUNT, name: "Muster AG" }, { uuid: OTHER_ACCOUNT, name: "Beispiel GmbH" }] });
  await assert.rejects(client("read", "").request("GET", "/accounts/{accountUuid}/addresses/v2/companies"), /Muster AG .*Beispiel GmbH/);
  respond = () => json({ error: "forbidden" }, 403);
  await assert.rejects(client("read", "").request("GET", "/accounts/{accountUuid}/addresses/v2/companies"), /profile/);
});

test("errors keep JSON details, reduce HTML pages to text and explain network failures", async () => {
  reset();
  const details = { message: "Duplicate", duplicates: Array.from({ length: 20 }, (_, n) => ({ uuid: `d${n}`, name: `Muster ${n} AG` })) };
  respond = () => json(details, 409);
  await assert.rejects(client("write").request("POST", "/accounts/{accountUuid}/addresses/v2/addresses", { body: {} }), (error) =>
    error.message.startsWith("AbaNinja API 409") && error.message.includes("Muster 19 AG"));
  respond = () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 500, headers: { "content-type": "text/html" } });
  await assert.rejects(client("read").request("GET", "/accounts/{accountUuid}/addresses/v2/companies"), /^Error: AbaNinja API 500: 502 Bad Gateway$/);
  respond = () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  await assert.rejects(client("read").request("GET", "/accounts/{accountUuid}/addresses/v2/companies"), /Could not reach api\.abaninja\.ch \(ENOTFOUND\)/);
});

test("rate limits are retried, empty answers are reported as success", async () => {
  reset();
  let attempts = 0;
  respond = () => (++attempts === 1 ? json({ message: "slow down" }, 429, { "retry-after": "0" }) : json({ data: [] }));
  assert.deepEqual(await client("read").request("GET", "/accounts/{accountUuid}/addresses/v2/companies"), { data: [] });
  assert.equal(attempts, 2);
  respond = () => new Response(null, { status: 204 });
  assert.deepEqual(await client("full").request("DELETE", "/accounts/{accountUuid}/addresses/v2/companies/u"), { ok: true, status: 204 });
});

test("binary responses are described, not decoded", async () => {
  reset();
  respond = () => new Response(new Uint8Array(1234), { status: 200, headers: { "content-type": "application/pdf" } });
  const result = await client("read").request("GET", "/accounts/{accountUuid}/documents/v2/invoices/u/files/f");
  assert.deepEqual(result, { contentType: "application/pdf", bytes: 1234, note: "Binary content is not shown." });
});
