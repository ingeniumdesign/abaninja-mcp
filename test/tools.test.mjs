// Offline tests for the MCP tools with made-up data. No network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AbaNinjaClient } from "../dist/abaninja.js";
import { registerTools } from "../dist/tools.js";

const day = (offset) => new Date(Date.now() + offset * 864e5).toLocaleDateString("sv-SE");

const sampleInvoices = [
  { uuid: "i1", invoiceNumber: "R-1", status: "due", currencyCode: "CHF", openAmount: 100.5, dueDate: day(-3), receiver: { companyUuid: "c1", name: "Muster AG" } },
  { uuid: "i2", invoiceNumber: "R-2", status: "sent", currencyCode: "EUR", openAmount: 50, dueDate: day(5), receiver: { companyUuid: "c2", name: "Beispiel GmbH" } },
  { uuid: "i3", status: "draft", currencyCode: "CHF", openAmount: 999, dueDate: day(-1), receiver: { companyUuid: "c1" } },
  { uuid: "i4", status: "paid", currencyCode: "CHF", openAmount: 0, dueDate: day(-10), receiver: { companyUuid: "c1" } },
  { uuid: "i5", status: "due", currencyCode: "CHF", openAmount: 20, dueDate: day(-2), isCancelled: true, receiver: { companyUuid: "c1" } },
];
const companies = [
  {
    uuid: "c1",
    customer_number: "M0001",
    company_name: "Muster AG",
    addresses: [{ uuid: "a1", address: "Seestrasse", street_number: "17", zip_code: "8000", city: "Zürich", country_code: "CH" }],
    contacts: [
      { type: "email", value: "info@muster.example", is_primary: true },
      { type: "phone", value: "+41 44 123 45 67", is_primary: false },
    ],
  },
  {
    uuid: "c2",
    customer_number: "01234567",
    company_name: "Nullstelle GmbH",
    addresses: [{ uuid: "a2", address: "Bahnhofplatz", street_number: "1", zip_code: "3011", city: "Bern", country_code: "CH" }],
    contacts: [{ type: "phone", value: "+41 (0)31 765 43 21", is_primary: true }],
  },
];

let invoices = sampleInvoices;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname.endsWith("/documents/v2/invoices")) {
    return json({ status: 200, message: "", data: { documents: url.searchParams.get("page") === "1" ? invoices : [] } });
  }
  if (url.pathname.endsWith("/addresses/v2/companies")) return json({ data: companies, meta: { total: companies.length } });
  if (url.pathname.endsWith("/addresses/v2/persons")) return json({ data: [], meta: { total: 0 } });
  return new Response("not found", { status: 404 });
};

async function connect() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, new AbaNinjaClient({ token: "test-token", accountUuid: "00000000-0000-4000-8000-000000000000", mode: "read" }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!result.isError, text, json };
  };
}

test("open invoices are summed per currency and skip drafts, paid and cancelled ones", async () => {
  invoices = sampleInvoices;
  const call = await connect();
  const all = await call("abaninja_open_invoices", {});
  assert.equal(all.json.total, 2);
  assert.deepEqual(all.json.totalOpenAmountByCurrency, { CHF: 100.5, EUR: 50 });
  const overdue = await call("abaninja_open_invoices", { overdue_only: true });
  assert.deepEqual(overdue.json.items.map((i) => i.uuid), ["i1"]);
  const withDrafts = await call("abaninja_open_invoices", { include_drafts: true });
  assert.equal(withDrafts.json.total, 3);
  const perCustomer = await call("abaninja_open_invoices", { company_uuid: "c2" });
  assert.deepEqual(perCustomer.json.items.map((i) => i.uuid), ["i2"]);
});

test("long pages drop whole items and report the next offset", async () => {
  invoices = Array.from({ length: 300 }, (_, n) => ({
    uuid: `x${n}`,
    invoiceNumber: `R-${n}`,
    title: "Lorem ipsum dolor sit amet ".repeat(12),
    status: "due",
    currencyCode: "CHF",
    openAmount: 1,
    dueDate: day(1),
    receiver: { companyUuid: "c1", name: "Muster AG" },
  }));
  const call = await connect();
  const page = await call("abaninja_open_invoices", { limit: 200 });
  assert.ok(page.json, "response is valid JSON");
  assert.ok(page.text.length <= 50_000);
  assert.equal(page.json.shortened, true);
  assert.equal(page.json.count, page.json.items.length);
  assert.equal(page.json.nextOffset, page.json.count);
  assert.deepEqual(page.json.totalOpenAmountByCurrency, { CHF: 300 });
  invoices = sampleInvoices;
});

test("address search finds street, customer number, punctuated names and phone numbers in any format", async () => {
  const call = await connect();
  const total = async (query) => (await call("abaninja_search_addresses", { query })).json.total;
  assert.equal(await total("seestrasse 17"), 1);
  assert.equal(await total("M0001"), 1);
  assert.equal(await total("Muster AG, Zürich"), 1);
  assert.equal(await total("Zürich"), 1);
  assert.equal(await total("044 123 45 67"), 1);
  assert.equal(await total("+41441234567"), 1);
  assert.equal(await total("0041 44 123 45 67"), 1);
  assert.equal(await total("01234567"), 1);
  assert.equal(await total("031 765 43 21"), 1);
  assert.equal(await total("+41 (0)31 765 43 21"), 1);
  assert.equal(await total("+41 (0)44 123 45 67"), 1);
  assert.equal(await total("nobody"), 0);
  assert.equal(await total("044 999 99 99"), 0);
});

test("a long raw API list drops whole entries and stays valid JSON", async () => {
  invoices = Array.from({ length: 120 }, (_, n) => ({
    uuid: `y${n}`,
    title: "Lorem ipsum dolor sit amet ".repeat(30),
    status: "due",
    currencyCode: "CHF",
    openAmount: 1,
  }));
  const call = await connect();
  const result = await call("abaninja_request", {
    method: "GET",
    path: "/accounts/{accountUuid}/documents/v2/invoices",
    query: { limit: 400, page: 1 },
  });
  assert.ok(result.json, "response is valid JSON");
  assert.ok(result.text.length <= 50_000);
  assert.equal(result.json.shortened.entriesOnPage, 120);
  assert.equal(result.json.shortened.shown, result.json.data.documents.length);
  assert.ok(result.json.shortened.shown < 120);
  invoices = sampleInvoices;
});

test("the request tool rejects a path that would leave api.abaninja.ch", async () => {
  const call = await connect();
  const result = await call("abaninja_request", { method: "GET", path: "/\t/evil.example/collect" });
  assert.equal(result.isError, true);
});
