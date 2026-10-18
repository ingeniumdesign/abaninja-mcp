// Checks the generated endpoint catalog against facts known from the official specs. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../catalog/endpoints.json", import.meta.url), "utf8"));
const endpoint = (method, path) => catalog.find((e) => e.method === method && e.path === path);
const field = (entry, name) => entry?.body?.find((f) => f.name === name);

test("every catalog path is a plain path that abaninja_request accepts", () => {
  for (const entry of catalog) {
    assert.match(entry.path, /^(\/[A-Za-z0-9{}_-]+)+$/, entry.path);
  }
});

test("creating an address shows type as required and the other fields per variant", () => {
  const entry = endpoint("POST", "/accounts/{accountUuid}/addresses/v2/addresses");
  assert.equal(field(entry, "type").required, true);
  assert.equal(field(entry, "name").requiredIf, "type=company");
  assert.equal(field(entry, "first_name").requiredIf, "type=person");
});

test("creating an invoice shows the position kinds and the receiver rules", () => {
  const entry = endpoint("POST", "/accounts/{accountUuid}/documents/v2/invoices");
  const kind = field(entry, "documents[].positions[].kind");
  assert.equal(kind.required, true);
  assert.match(kind.type, /"product"/);
  assert.equal(field(entry, "documents[].receiver").requiredUnless, "isTemplate=true");
  assert.equal(field(entry, "documents[].isTemplate").required, undefined);
});

test("payments expose the e-mail flag that write mode blocks and combine nested conditions with and", () => {
  const entry = endpoint("POST", "/accounts/{accountUuid}/finances/v2/payments");
  assert.ok(field(entry, "processing.sendPaymentConfirmation"));
  assert.match(field(entry, "paymentDirection").type, /"IN"/);
  assert.equal(field(entry, "bankAccountIban").requiredIf, "paymentDirection=IN and paymentType=BANK");
  assert.equal(field(entry, "debitBankAccountIban").requiredIf, "paymentDirection=OUT and paymentType=BANK");
  assert.match(field(entry, "processing.exchangeCurrencyAmount").requiredIf, /^type=receipt and exchangeRate/);
});

test("quotes keep signee types required and the receiver rule of non-templates", () => {
  const entry = endpoint("POST", "/accounts/{accountUuid}/documents/v2/quotes");
  assert.equal(field(entry, "documents[].signees[].type").required, true);
  assert.equal(field(entry, "documents[].receiver").requiredUnless, "isTemplate=true");
  assert.equal(field(entry, "documents[].receiver").requiredIf, undefined);
});
