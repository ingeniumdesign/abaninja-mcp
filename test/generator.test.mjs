// Offline tests for the catalog generator with small made-up specs. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointsOf, typeOf } from "../scripts/generate-catalog.mjs";

const spec = (schema, extra = {}) => ({
  paths: { "/accounts/{accountUuid}/things": { post: { summary: "Create thing", requestBody: { content: { "application/json": { schema } } } } } },
  ...extra,
});
const fields = (schema, extra) => Object.fromEntries(endpointsOf("test", spec(schema, extra))[0].body.map((f) => [f.name, f]));

test("references are resolved, also nested and cyclic ones", () => {
  const body = fields(
    { $ref: "#/components/schemas/Thing" },
    { components: { schemas: { Thing: { type: "object", required: ["name"], properties: { name: { type: "string" }, parent: { $ref: "#/components/schemas/Thing" } } } } } },
  );
  assert.equal(body.name.required, true);
  assert.ok(body.parent);
});

test("variants with a discriminator give requiredIf, variants without one give requiredUnless", () => {
  const byType = fields({
    oneOf: [
      { type: "object", required: ["type", "name"], properties: { type: { const: "company" }, name: { type: "string" } } },
      { type: "object", required: ["type", "first_name"], properties: { type: { const: "person" }, first_name: { type: "string" } } },
    ],
  });
  assert.equal(byType.type.required, true);
  assert.equal(byType.name.requiredIf, "type=company");
  assert.equal(byType.first_name.requiredIf, "type=person");

  const alternatives = fields({
    type: "object",
    properties: { productUuid: { type: "string" }, productNumber: { type: "string" }, price: { type: "number" } },
    oneOf: [
      { required: ["productUuid"], properties: { productNumber: false } },
      { required: ["price"], properties: { productUuid: false } },
    ],
  });
  assert.equal(alternatives.productUuid.requiredUnless, "price given");
  assert.equal(alternatives.price.requiredUnless, "productUuid given");
  assert.equal(alternatives.productNumber.notWith, "productUuid");
});

test("a null variant does not turn into a condition, if/then conditions are named", () => {
  const body = fields({
    type: "object",
    properties: {
      bank: { oneOf: [{ type: "null" }, { type: "object", required: ["iban"], properties: { iban: { type: "string" } } }] },
      method: { enum: ["cash", "bank"] },
      iban: { type: "string" },
    },
    if: { properties: { method: { const: "bank" } } },
    then: { required: ["iban"] },
  });
  assert.equal(body["bank.iban"].required, true);
  assert.equal(body.iban.requiredIf, "method=bank");
});

test("types show constants, patterns, maps and deprecation", () => {
  assert.equal(typeOf({ const: 1 }), "1");
  assert.equal(typeOf({ const: "product" }), "\"product\"");
  assert.equal(typeOf({ type: "string", pattern: "^\\d{2}:\\d{2}$" }), "string(pattern ^\\d{2}:\\d{2}$)");
  assert.equal(typeOf({ type: "object", additionalProperties: { type: "boolean" }, propertyNames: { enum: ["a", "b"] } }), "map<a|b, boolean>");
  const body = fields({ type: "object", properties: { total: { type: "number", description: "Deprecated: derived from the positions." } } });
  assert.equal(body.total.deprecated, true);
});

test("a null variant with a meaning is kept as nullMeans", () => {
  const body = fields({
    type: "object",
    properties: {
      paymentInstructions: { oneOf: [{ type: "null", title: "No bank account will be used" }, { type: "object", properties: { bankAccountUuid: { type: "string" } } }] },
    },
  });
  assert.equal(body.paymentInstructions.nullMeans, "No bank account will be used");
});
