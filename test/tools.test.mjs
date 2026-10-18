// Offline tests for the MCP tools with made-up data. No network access.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AbaNinjaClient } from "../dist/abaninja.js";
import { registerTools } from "../dist/tools.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000000";
const day = (offset) => new Date(Date.now() + offset * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });

const sampleInvoices = [
  { uuid: "i1", invoiceNumber: "RE-2026-001", status: "due", currencyCode: "CHF", openAmount: 100.5, dueDate: day(-3), receiver: { companyUuid: "c1", name: "Müller AG" } },
  { uuid: "i2", invoiceNumber: "RE-2026-002", status: "sent", currencyCode: "EUR", openAmount: 50, dueDate: day(5), receiver: { companyUuid: "c2", name: "Nullstelle GmbH" } },
  { uuid: "i3", invoiceNumber: "RE-2026-003", status: "draft", currencyCode: "CHF", openAmount: 999, dueDate: day(-1), receiver: { companyUuid: "c1" } },
  { uuid: "i4", invoiceNumber: "RE-2026-004", status: "paid", currencyCode: "CHF", openAmount: 0, dueDate: day(-10), receiver: { companyUuid: "c1" } },
  { uuid: "i5", invoiceNumber: "RE-2026-005", status: "due", currencyCode: "CHF", openAmount: 20, dueDate: day(-2), isCancelled: true, receiver: { companyUuid: "c1" } },
  { uuid: "i6", invoiceNumber: "RE-2026-006", status: "due", currencyCode: "CHF", openAmount: 30, receiver: { personUuid: "p1", name: "René Egger" } },
];
const quotes = [
  { uuid: "q1", quoteNumber: "O0182", title: "Website Relaunch, replaces O0183", status: "sent", currencyCode: "CHF", documentTotal: 5000, receiver: { companyUuid: "c1", name: "Müller AG" } },
  { uuid: "q2", quoteNumber: "O0183", title: "Hosting", status: "draft", currencyCode: "CHF", documentTotal: 240, receiver: { companyUuid: "c2", name: "Nullstelle GmbH" } },
];
const companies = [
  {
    uuid: "c1",
    customer_number: "M0001",
    company_name: "Müller AG",
    addresses: [{ uuid: "a1", address: "Seestrasse", street_number: "17", zip_code: "8000", city: "Zürich", country_code: "CH" }],
    contacts: [{ type: "email", value: "info@mueller.example", is_primary: true }, { type: "phone", value: "+41 44 123 45 67", is_primary: false }],
    contact_persons: [{ uuid: "cp1", first_name: "Anna", last_name: "Beispiel", salutation: "Ms" }],
  },
  {
    uuid: "c2",
    customer_number: "01234567",
    company_name: "Nullstelle GmbH",
    addresses: [{ uuid: "a2", address: "Bahnhofplatz", street_number: "1", zip_code: "3011", city: "Bern", country_code: "CH" }],
    contacts: [{ type: "phone", value: "+41 (0)31 765 43 21", is_primary: true }],
  },
  {
    uuid: "c3",
    customer_number: "M0002",
    company_name: "Seestrasse Immobilien P0001",
    addresses: [{ uuid: "a3", address: "Seeweg", street_number: "2", zip_code: "6300", city: "Zug", country_code: "CH" }],
  },
  {
    uuid: "c4",
    customer_number: "B0001",
    company_name: "Bäckerei Mueller AG",
    addresses: [{ uuid: "a4", address: "Hauptstrasse", street_number: "5", zip_code: "8001", city: "Zuerich", country_code: "CH" }],
  },
];
const persons = [{ uuid: "p1", customer_number: "P0001", first_name: "René", last_name: "Egger", addresses: [] }];
const creditNotes = [{ uuid: "g1", creditNoteNumber: "G0001", creditNoteDate: "2026-09-30", status: "sent", currencyCode: "CHF", documentTotal: 50, receiver: { companyUuid: "c1", name: "Müller AG" } }];
const receipts = [{ uuid: "b1", receiptNumber: "B-77", invoiceDate: "2026-09-01", currencyCode: "CHF", documentTotal: 89, receiver: { companyUuid: "s1", receiverInformation: { name: "Swisscom AG", customerNumber: "L0001" } } }];

// Tests may replace the invoices; each test starts with the samples.
let invoices;
beforeEach(() => {
  invoices = sampleInvoices;
});

// A fake API serving the lists above on page 1, in the shapes AbaNinja uses for addresses and documents.
let addressLoads = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  if (init.method !== "GET") return json({ data: { uuid: "new" } });
  const list = { companies, persons, invoices, quotes, "credit-notes": creditNotes, receipts }[url.pathname.split("/").pop()];
  if (!list) return new Response("not found", { status: 404 });
  if (list === companies) addressLoads++;
  const page = url.searchParams.get("page") === "1" ? list : [];
  return json(url.pathname.includes("/documents/") ? { data: { documents: page } } : { data: page });
};

async function connect(mode = "read") {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, new AbaNinjaClient({ token: "test-token", accountUuid: ACCOUNT, mode }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  // Successful answers must be valid JSON, so they are parsed here.
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return { isError: !!result.isError, text, json: result.isError ? undefined : JSON.parse(text) };
  };
  return Object.assign(call, { listTools: () => client.listTools() });
}

test("open invoices are summed per currency and skip drafts, paid and cancelled ones", async () => {
  const call = await connect();
  const all = await call("abaninja_open_invoices", {});
  assert.equal(all.json.total, 3);
  assert.deepEqual(all.json.totalOpenAmountByCurrency, { CHF: 130.5, EUR: 50 });
  assert.equal(all.json.items.at(-1).uuid, "i6", "an invoice without due date comes last");
  const overdue = await call("abaninja_open_invoices", { overdue_only: true });
  assert.deepEqual(overdue.json.items.map((i) => i.uuid), ["i1"]);
  assert.equal((await call("abaninja_open_invoices", { include_drafts: true })).json.total, 4);
  assert.deepEqual((await call("abaninja_open_invoices", { customer_uuid: "c2" })).json.items.map((i) => i.uuid), ["i2"]);
  assert.deepEqual((await call("abaninja_open_invoices", { customer_uuid: "p1" })).json.items.map((i) => i.uuid), ["i6"]);
  assert.equal((await call("abaninja_open_invoices", { customer_uuid: "nobody" })).json.total, 0);
});

test("misnamed arguments are refused instead of silently ignored", async () => {
  const call = await connect();
  for (const [tool, args] of [
    ["abaninja_open_invoices", { company_uuid: "c2" }],
    ["abaninja_search_addresses", { name: "Müller" }],
    ["abaninja_request", { method: "GET", path: "/accounts/{accountUuid}/addresses/v2/companies", params: { limit: 1 } }],
    ["abaninja_list_endpoints", { area: "invoices" }],
  ]) {
    assert.equal((await call(tool, args)).isError, true, `${tool} ${JSON.stringify(args)}`);
  }
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
  assert.ok(page.text.length <= 50_000);
  assert.equal(page.json.shortened, true);
  assert.equal(page.json.count, page.json.items.length);
  assert.equal(page.json.nextOffset, page.json.count);
  assert.deepEqual(page.json.totalOpenAmountByCurrency, { CHF: 300 });
});

test("a long raw API list drops whole entries and stays valid JSON", async () => {
  invoices = Array.from({ length: 120 }, (_, n) => ({ uuid: `y${n}`, title: "Lorem ipsum dolor sit amet ".repeat(30), status: "due", currencyCode: "CHF", openAmount: 1 }));
  const call = await connect();
  const result = await call("abaninja_request", { method: "GET", path: "/accounts/{accountUuid}/documents/v2/invoices", query: { limit: 400, page: 1 } });
  assert.ok(result.text.length <= 50_000);
  assert.equal(result.json.shortened.entriesOnPage, 120);
  assert.equal(result.json.shortened.shown, result.json.data.documents.length);
  assert.ok(result.json.shortened.shown < 120);
});

test("an empty raw list stays a list", async () => {
  const call = await connect();
  const result = await call("abaninja_request", { method: "GET", path: "/accounts/{accountUuid}/documents/v2/quotes", query: { page: 2 } });
  assert.deepEqual(result.json.data.documents, []);
});

test("address search folds accents both ways, finds streets, numbers and phones in any format, exact customer numbers first", async () => {
  const call = await connect();
  const search = async (query) => (await call("abaninja_search_addresses", { query })).json.items.map((i) => i.uuid);
  // c1 is stored as Müller AG in Zürich, c4 as Bäckerei Mueller AG in Zuerich.
  for (const query of ["Müller", "Muller", "Mueller", "Zürich", "Zurich", "Zuerich"]) {
    const uuids = await search(query);
    assert.ok(uuids.includes("c1") && uuids.includes("c4"), query);
  }
  for (const query of ["Rene Egger", "René Egger", "seestrasse 17", "Müller AG, Zürich"]) {
    assert.ok((await search(query)).length >= 1, query);
  }
  for (const [query, expected] of [
    ["01234567", ["c2"]],
    ["031 765 43 21", ["c2"]],
    ["+41 (0)31 765 43 21", ["c2"]],
    ["044 123 45 67", ["c1"]],
    ["044 123 45 67 8000", ["c1"]], // a postcode after the phone number is its own word
    ["nobody", []],
    ["044 999 99 99", []],
    ["M0001", ["c1"]],
    ["P0001", ["p1", "c3"]], // the exact customer number first, although companies are listed before persons
  ]) {
    assert.deepEqual(await search(query), expected, query);
  }
  assert.equal((await call("abaninja_search_addresses", { query: "M0001" })).json.items[0].contactPersons[0].uuid, "cp1");
});

test("the address list is loaded again after a change made through the server", async () => {
  const call = await connect("write");
  const before = addressLoads;
  await call("abaninja_search_addresses", { query: "Müller" });
  await call("abaninja_search_addresses", { query: "Bern" });
  assert.equal(addressLoads, before + 1, "kept between searches");
  await call("abaninja_request", { method: "PATCH", path: "/accounts/{accountUuid}/addresses/v2/companies/c1", body: { private_notes: "x" } });
  await call("abaninja_search_addresses", { query: "Müller" });
  assert.equal(addressLoads, before + 2, "loaded again after the change");
});

test("find_documents: by number (exact first), text, customer and status, with dates and customers for every type", async () => {
  const call = await connect();
  const find = async (args) => (await call("abaninja_find_documents", args)).json.items;
  assert.deepEqual((await find({ type: "quotes", query: "O0183" })).map((d) => [d.uuid, d.number]), [["q2", "O0183"], ["q1", "O0182"]]);
  assert.deepEqual((await find({ type: "quotes", query: "website" })).map((d) => d.uuid), ["q1"]);
  assert.deepEqual((await find({ type: "quotes", customer_uuid: "c2" })).map((d) => d.uuid), ["q2"]);
  assert.deepEqual((await find({ type: "invoices", query: "RE-2026-004" })).map((d) => d.uuid), ["i4"]);
  assert.deepEqual((await find({ type: "invoices", status: "paid" })).map((d) => d.uuid), ["i4"]);
  assert.equal((await find({ type: "credit-notes", query: "G0001" }))[0].date, "2026-09-30");
  assert.equal((await find({ type: "receipts", query: "swisscom" }))[0].customer, "Swisscom AG");
  assert.equal((await call("abaninja_find_documents", { type: "receipts", status: "paid" })).isError, true, "receipts have no status");
  invoices = Array.from({ length: 450 }, (_, n) => ({ uuid: `n${n + 1}`, invoiceNumber: String(n + 1).padStart(8, "0"), status: "paid", currencyCode: "CHF", openAmount: 0 }));
  const byNumber = await find({ type: "invoices", query: "00000042" });
  assert.deepEqual(byNumber.map((d) => d.number), ["00000042"], "no phone-number spellings");
});

test("the request tool tells the assistant its mode and rejects paths that would leave api.abaninja.ch", async () => {
  for (const [mode, readOnly, destructive] of [["read", true, false], ["write", false, true], ["full", false, true]]) {
    const call = await connect(mode);
    const tool = (await call.listTools()).tools.find((t) => t.name === "abaninja_request");
    assert.match(tool.description, new RegExp(`${mode} mode`));
    assert.equal(tool.annotations.readOnlyHint, readOnly, mode);
    assert.equal(tool.annotations.destructiveHint, destructive, mode);
  }
  const call = await connect();
  assert.equal((await call("abaninja_request", { method: "GET", path: "/\t/evil.example/collect" })).isError, true);
  assert.equal((await call("abaninja_request", { method: "POST", path: "/accounts/{accountUuid}/addresses/v2/addresses", body: "{}" })).isError, true);
});

test("describe_endpoint accepts placeholders or real values and prefers literal segments", async () => {
  const call = await connect();
  const describe = async (method, path) => (await call("abaninja_describe_endpoint", { method, path })).json.path;
  const company = "/accounts/{accountUuid}/addresses/v2/companies/{companyUuid}";
  assert.equal(await describe("PATCH", company), company);
  assert.equal(await describe("PATCH", `/accounts/${ACCOUNT}/addresses/v2/companies/c1`), company);
  // Both also match .../{invoiceUuid}/dunnings and .../contracts/{contractUuid}.
  assert.equal(await describe("GET", `/accounts/${ACCOUNT}/documents/v2/invoices/settings/dunnings`), "/accounts/{accountUuid}/documents/v2/invoices/settings/dunnings");
  assert.equal(await describe("GET", `/accounts/${ACCOUNT}/time/v2/employees/e1/contracts/last-contract`), "/accounts/{accountUuid}/time/v2/employees/{employeeUuid}/contracts/last-contract");
});
