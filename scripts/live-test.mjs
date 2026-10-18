// Live test against a real AbaNinja account, driven through MCP the way an assistant uses the server.
//
//   node scripts/live-test.mjs            read only: every GET endpoint without path parameters, plus the tools
//   node scripts/live-test.mjs --write    also creates test records, changes them and deletes them again
//   node scripts/live-test.mjs --cleanup  deletes test records left over from an interrupted run
//
// Existing data is only read. Writes touch nothing but records this script creates, named
// "ZZ-Test abaninja-mcp" and tracked in .live-test-state.json until they are deleted: a company, a person,
// a product and a draft quote and draft invoice for the test company. Draft documents take the next number
// of their number range, so deleting them leaves a gap there.
// Reads ABANINJA_API_TOKEN from the environment or .env. Never prints it.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_NAME = "ZZ-Test abaninja-mcp";
const ACCOUNT = "/accounts/{accountUuid}";
const STATE_FILE = new URL("../.live-test-state.json", import.meta.url);
const ENV_FILE = new URL("../.env", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("../catalog/endpoints.json", import.meta.url), "utf8"));

if (!process.env.ABANINJA_API_TOKEN && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
if (!process.env.ABANINJA_API_TOKEN) throw new Error("ABANINJA_API_TOKEN is not set.");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` – ${detail}` : ""}`);
}
// A tool call must succeed and ok must hold; a failed call shows its error.
const checkCall = (name, result, ok = true, detail = "") =>
  check(name, !result.isError && ok, result.isError ? result.text.slice(0, 300) : detail);

// The tracked test records: paths below /accounts/{accountUuid}, in the order they were created.
function loadState() {
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : [];
  if (!Array.isArray(state)) {
    throw new Error("Unknown format of .live-test-state.json. Check AbaNinja for ZZ-Test records by hand, then delete the file.");
  }
  return state;
}
const saveState = (state) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n");

async function connect(mode) {
  const client = new Client({ name: "live-test", version: "0.0.0" });
  const env = { ...process.env, ABANINJA_MODE: mode };
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, stderr: "ignore" }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { isError: !!result.isError, text, json };
  };
  // abaninja_request for a path below /accounts/{accountUuid}.
  const api = (method, path, extra) => call("abaninja_request", { method, path: ACCOUNT + path, ...extra });
  return { call, api, close: () => client.close() };
}

// The record inside an AbaNinja answer: data, data.documents[0] or the answer itself.
const record = (json) => json?.data?.documents?.[0] ?? json?.data ?? json;

async function readTest() {
  console.log("\n== Read: tools");
  const { call, close } = await connect("read");
  const listed = await call("abaninja_list_endpoints", { limit: 1 });
  checkCall("list_endpoints", listed, listed.json?.total > 500, `${listed.json?.total} endpoints`);
  const addresses = await call("abaninja_search_addresses", { limit: 2 });
  checkCall("search_addresses", addresses, addresses.json?.total > 0, `${addresses.json?.total} addresses`);
  const customerNumber = addresses.json?.items?.[0]?.customerNumber;
  if (customerNumber) {
    check("search by customer number", (await call("abaninja_search_addresses", { query: customerNumber })).json?.total >= 1);
  }
  const open = await call("abaninja_open_invoices", { limit: 3 });
  checkCall("open_invoices", open, typeof open.json?.totalOpenAmountByCurrency === "object",
    `${open.json?.total} open, ${JSON.stringify(open.json?.totalOpenAmountByCurrency)}`);
  const overdue = await call("abaninja_open_invoices", { overdue_only: true, limit: 1 });
  checkCall("open_invoices overdue_only", overdue, overdue.json?.total <= open.json?.total);

  console.log("\n== Read: every GET endpoint without path parameters");
  const requiredQuery = { "/addresses/v2/check-customer-number": { customerNumber: "ZZTEST0" }, "/holidays/v2/holidays": { countryCode: "CH" } };
  const endpoints = catalog.filter(
    (e) => e.method === "GET" && !/\{(?!accountUuid\})[^}]+\}/.test(e.path) && !/export|download|pdf|print|preview|zip/i.test(`${e.path} ${e.summary}`),
  );
  const unavailable = [];
  const broken = [];
  for (const e of endpoints) {
    const query = { ...requiredQuery[e.path.replace(ACCOUNT, "")] };
    for (const p of e.params ?? []) if (p.in === "query" && /^(limit|perPage)$/.test(p.name)) query[p.name] = 5;
    const r = await call("abaninja_request", { method: "GET", path: e.path, query });
    if (!r.isError) continue;
    const status = Number(r.text.match(/^AbaNinja API (\d+)/)?.[1]);
    if ([403, 404, 405, 422].includes(status)) unavailable.push(`${e.path} (${status})`);
    else broken.push(`${e.path}: ${r.text.slice(0, 120)}`);
  }
  const answered = endpoints.length - unavailable.length - broken.length;
  check(`GET sweep: ${answered} of ${endpoints.length} answered`, broken.length === 0,
    `${unavailable.length} not available for this account${broken.length ? `, ${broken.length} broken` : ""}`);
  for (const line of [...unavailable, ...broken]) console.log(`     ${line.replace(ACCOUNT, "")}`);
  await close();
}

async function writeTest(state) {
  console.log("\n== Write: test records only");
  const { call, api, close } = await connect("write");
  // Tracks a created record before anything else happens, so a later cleanup finds it.
  const track = (result, base) => {
    const uuid = record(result.json)?.uuid;
    if (uuid) {
      state.push(`${base}/${uuid}`);
      saveState(state);
    }
    return uuid;
  };
  const address = { address: "Teststrasse", street_number: "1", zip_code: "8000", city: "Zürich", state: "ZH", country_code: "CH" };

  const company = await api("POST", "/addresses/v2/addresses", {
    body: {
      type: "company",
      name: TEST_NAME,
      language: "de",
      private_notes: "Live test of abaninja-mcp. Safe to delete.",
      addresses: [address],
      contacts: [{ type: "phone", value: "+41 44 000 00 00", primary: true }],
    },
  });
  const companyUuid = track(company, "/addresses/v2/companies");
  checkCall("create company", company, !!companyUuid);
  let addressUuid;
  if (companyUuid) {
    const path = `/addresses/v2/companies/${companyUuid}`;
    const patched = await api("PATCH", path, { body: { contact_persons: [{ first_name: "Testa", last_name: "Muster", salutation: "Ms" }] } });
    const back = record((await api("GET", path)).json);
    checkCall("update company (contact person)", patched, back?.contact_persons?.[0]?.last_name === "Muster");
    addressUuid = back?.addresses?.[0]?.uuid;
  }

  const personBody = {
    type: "person",
    first_name: "ZZ-Testperson",
    last_name: "abaninja-mcp",
    salutation: "Mr",
    language: "de",
    addresses: [{ ...address, street_number: "2", zip_code: "8001" }],
  };
  let person = await api("POST", "/addresses/v2/addresses", { body: personBody });
  // AbaNinja's duplicate check is fuzzy and reports the similar test company; force=true creates the person anyway.
  if (/^AbaNinja API 409/.test(person.text)) {
    check("duplicate check reports the similar test company", person.text.includes(TEST_NAME));
    person = await api("POST", "/addresses/v2/addresses", { body: personBody, query: { force: true } });
  }
  const personUuid = track(person, "/addresses/v2/persons");
  checkCall("create person", person, !!personUuid);
  if (personUuid) {
    const body = { private_notes: "Live test of abaninja-mcp (changed). Safe to delete." };
    checkCall("update person", await api("PATCH", `/addresses/v2/persons/${personUuid}`, { body }));
  }

  const units = (await api("GET", "/units/v2/units")).json?.data ?? [];
  const unit = units.find((u) => /C62/i.test(JSON.stringify(u))) ?? units[0];
  const product = await api("POST", "/products/v2/products", {
    body: {
      productKey: "ZZ-TEST-ABANINJA-MCP",
      isService: true,
      unitUuid: unit?.uuid,
      cost: 1,
      translations: { de: { productName: TEST_NAME, productDescription: "Live test, safe to delete." } },
    },
  });
  const productUuid = track(product, "/products/v2/products");
  checkCall("create product", product, !!productUuid);
  if (productUuid) checkCall("update product", await api("PATCH", `/products/v2/products/${productUuid}`, { body: { cost: 2 } }));

  const position = { kind: "product", productDescription: "Live test position", singlePrice: 100, quantity: 2 };
  const positions = [...(productUuid ? [{ kind: "product", productUuid, quantity: 1 }] : []), position];
  const receiver = { companyUuid, addressUuid };
  for (const type of ["quotes", "invoices"]) {
    const calc = await api("POST", `/documents/v2/${type}/calculate`, { body: { currencyCode: "CHF", positions: [position] } });
    checkCall(`calculate ${type} (stores nothing)`, calc, true, calc.text.replace(/\s+/g, " ").slice(0, 120));
    if (!addressUuid) continue;
    const draft = await api("POST", `/documents/v2/${type}`, { body: { documents: [{ title: `${TEST_NAME} (${type})`, receiver, positions }] } });
    const uuid = track(draft, `/documents/v2/${type}`);
    const created = record(draft.json);
    checkCall(`create draft ${type}`, draft, created?.status === "draft",
      `${created?.quoteNumber ?? created?.invoiceNumber ?? ""} total ${created?.documentTotal}`);
    if (!uuid) continue;
    // A PATCH replaces the whole document, so the body repeats dates, currency, receiver and positions.
    const path = `/documents/v2/${type}/${uuid}`;
    const current = record((await api("GET", path)).json);
    const dates = type === "quotes"
      ? { quoteDate: current?.quoteDate }
      : { invoiceDate: current?.invoiceDate, paymentInstructions: { bankAccountUuid: current?.paymentInstructions?.bankAccountUuid } };
    const changed = {
      ...dates,
      pricesIncludeVat: current?.pricesIncludeVat ?? false,
      currencyCode: current?.currencyCode ?? "CHF",
      receiver,
      positions,
      title: `${TEST_NAME} (${type}, changed)`,
    };
    const patched = await api("PATCH", path, { body: { documents: [changed] } });
    const back = record((await api("GET", path)).json);
    checkCall(`update draft ${type}`, patched, /changed/.test(back?.title ?? ""));
  }
  if (state.some((path) => path.startsWith("/documents/v2/invoices/"))) {
    const withDrafts = await call("abaninja_open_invoices", { customer_uuid: companyUuid, include_drafts: true });
    const withoutDrafts = await call("abaninja_open_invoices", { customer_uuid: companyUuid });
    check("open_invoices shows the draft only with include_drafts", withDrafts.json?.total === 1 && withoutDrafts.json?.total === 0,
      `${withDrafts.json?.total} with, ${withoutDrafts.json?.total} without`);
  }

  const found = await call("abaninja_search_addresses", { query: TEST_NAME });
  check("search finds the test company and person", found.json?.total === 2, `${found.json?.total} hits`);
  const phone = await call("abaninja_search_addresses", { query: "044 000 00 00" });
  check("search by phone in national format", phone.json?.total >= 1);

  // The real server refuses these before any request; the made-up uuid keeps them harmless even if not.
  console.log("\n== Write mode refuses");
  const fake = "00000000-0000-4000-8000-000000000000";
  const refused = [
    ["e-mail a quote", "PATCH", `/documents/v2/quotes/${fake}/actions/email`, { body: {} }],
    ["dun an invoice", "PATCH", `/documents/v2/invoices/${fake}/actions/dunningSent`, { body: {} }],
    ["bulk send", "PATCH", "/documents/v2/invoices/bulk-actions/massSent", { body: { documentUuids: [fake] } }],
    ["DELETE", "DELETE", `/addresses/v2/companies/${fake}`],
    ["_method override", "POST", `/addresses/v2/companies/${fake}`, { query: { _method: "DELETE" } }],
    ["outgoing webhook change", "PATCH", `/webhooks/v2/outgoing-webhooks/${fake}`, { body: {} }],
    ["payment confirmation e-mail", "POST", "/finances/v2/payments", { body: { processing: { documentUuid: fake, sendPaymentConfirmation: "1" } } }],
    ["IBAN in an invoice", "POST", "/documents/v2/invoices", { body: { documents: [{ paymentInstructions: { iban: "CH9300762011623852957" } }] } }],
  ];
  for (const [label, method, path, extra] of refused) {
    const result = await api(method, path, extra);
    check(`refused: ${label}`, result.isError && !/^AbaNinja API/.test(result.text), result.text.slice(0, 90));
  }
  const away = await call("abaninja_request", { method: "GET", path: "/\t/example.com/x" });
  check("refused: path leaving api.abaninja.ch", away.isError && !/^AbaNinja API/.test(away.text));
  await close();
}

async function cleanup(state = loadState()) {
  if (state.length) {
    console.log("\n== Cleanup: delete the test records (full mode, own records only)");
    const { api, close } = await connect("full");
    // Newest first, so documents go before the product and company they refer to.
    for (const path of [...state].reverse()) {
      const del = path.startsWith("/documents/") ? await api("PATCH", `${path}/actions/delete`, { body: {} }) : await api("DELETE", path);
      const gone = /^AbaNinja API 404/.test((await api("GET", path)).text);
      check(`delete test record ${path}`, gone, del.isError ? del.text.slice(0, 160) : "");
      if (gone) {
        state.splice(state.indexOf(path), 1);
        saveState(state);
      }
    }
    await close();
  }
  // Test-named records that are not tracked are only reported, never deleted.
  const { call, close } = await connect("read");
  const left = await call("abaninja_search_addresses", { query: TEST_NAME, include_archived: true });
  const found = (left.json?.items ?? []).map((item) => `${item.name} (${item.uuid})`).join(", ");
  check("no test addresses left", left.json?.total === 0, found ? `check by hand: ${found}` : "");
  await close();
  if (state.length === 0) rmSync(STATE_FILE, { force: true });
  else console.log(`Left over, see .live-test-state.json: ${JSON.stringify(state)}`);
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
} else {
  await readTest();
  if (process.argv.includes("--write")) {
    // Records of an interrupted earlier run are deleted first.
    const state = loadState();
    if (state.length) await cleanup(state);
    if (state.length) throw new Error("Test records of an earlier run are left, see .live-test-state.json.");
    try {
      await writeTest(state);
    } finally {
      await cleanup(state);
    }
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
