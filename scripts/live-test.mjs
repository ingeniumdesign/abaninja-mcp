// Live test against a real AbaNinja account, driven through MCP the way an assistant uses the server.
//
//   node scripts/live-test.mjs            read only: every GET endpoint without path parameters, plus the tools
//   node scripts/live-test.mjs --write    also creates test records, changes them and deletes them again
//   node scripts/live-test.mjs --cleanup  deletes test records left over from an interrupted run
//
// Existing data is only read. Writes touch nothing but records this script creates, named
// "ZZ-Test abaninja-mcp" and tracked in .live-test-state.json until they are deleted: a company, a person,
// a product and a draft quote and draft invoice for the test company. Draft documents take the next number
// of their number range, so deleting them leaves a gap there. Blocked calls are tried with made-up uuids.
// Needs a build (npm run build). Reads ABANINJA_API_TOKEN from the environment or ../../.env. Never prints it.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const options = new Set(process.argv.slice(2));
const TEST_NAME = "ZZ-Test abaninja-mcp";
const FAKE_UUID = "00000000-0000-4000-8000-000000000000";
const ACCOUNT = "/accounts/{accountUuid}";
const STATE_FILE = new URL("../.live-test-state.json", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("../catalog/endpoints.json", import.meta.url), "utf8"));

const env = { ...process.env };
const envFile = new URL("../../.env", import.meta.url);
if (!env.ABANINJA_API_TOKEN && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` – ${detail}` : ""}`);
}

const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const saveState = (state) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n");

async function connect(mode) {
  const client = new Client({ name: "live-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...env, ABANINJA_MODE: mode }, stderr: "ignore" }),
  );
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content[0].text;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: !!result.isError, text, json };
    },
    close: () => client.close(),
  };
}

// The record inside an AbaNinja answer: data, data.documents[0] or the answer itself.
const record = (json) => json?.data?.documents?.[0] ?? json?.data ?? json;

async function readTest() {
  console.log("\n== Read: tools");
  const server = await connect("read");
  const listed = (await server.call("abaninja_list_endpoints", { limit: 1 })).json;
  check("list_endpoints", listed?.total > 500, `${listed?.total} endpoints in the catalog`);
  const described = await server.call("abaninja_describe_endpoint", { method: "POST", path: `${ACCOUNT}/addresses/v2/addresses` });
  check("describe_endpoint", described.json?.body?.some((f) => f.name === "name" && f.requiredIf === "type=company"));
  const addresses = await server.call("abaninja_search_addresses", { limit: 2 });
  check("search_addresses", !addresses.isError && addresses.json.total > 0, `${addresses.json?.total} addresses`);
  const first = addresses.json?.items?.[0];
  if (first?.customerNumber) {
    const byNumber = await server.call("abaninja_search_addresses", { query: first.customerNumber });
    check("search by customer number", byNumber.json?.total >= 1);
  }
  const open = await server.call("abaninja_open_invoices", { limit: 3 });
  check("open_invoices", !open.isError && typeof open.json.totalOpenAmountByCurrency === "object",
    `${open.json?.total} open, ${JSON.stringify(open.json?.totalOpenAmountByCurrency)}`);
  const overdue = await server.call("abaninja_open_invoices", { overdue_only: true, limit: 1 });
  check("open_invoices overdue_only", !overdue.isError && overdue.json.total <= open.json.total);

  console.log("\n== Read: every GET endpoint without path parameters");
  const requiredQuery = { "/addresses/v2/check-customer-number": { customerNumber: "ZZTEST0" }, "/holidays/v2/holidays": { countryCode: "CH" } };
  const endpoints = catalog.filter(
    (e) => e.method === "GET" && !/\{(?!accountUuid\})[^}]+\}/.test(e.path) && !/export|download|pdf|print|preview|zip/i.test(`${e.path} ${e.summary}`),
  );
  const answered = [];
  const unavailable = [];
  const broken = [];
  for (const e of endpoints) {
    const query = {};
    for (const p of e.params ?? []) {
      if (p.in === "query" && (p.name === "limit" || p.name === "perPage")) query[p.name] = 5;
    }
    Object.assign(query, requiredQuery[e.path.replace(ACCOUNT, "")] ?? {});
    const r = await server.call("abaninja_request", { method: "GET", path: e.path, query });
    const status = Number(r.text.match(/^AbaNinja API (\d+)/)?.[1] ?? 0);
    if (!r.isError) answered.push(e.path);
    else if ([403, 404, 405, 422].includes(status)) unavailable.push(`${e.path} (${status})`);
    else broken.push(`${e.path}: ${r.text.slice(0, 120)}`);
  }
  check(`GET sweep: ${answered.length} of ${endpoints.length} answered`, broken.length === 0,
    `${unavailable.length} not available for this account${broken.length ? `, ${broken.length} broken` : ""}`);
  for (const line of [...unavailable, ...broken]) console.log(`     ${line.replace(ACCOUNT, "")}`);
  await server.close();
}

async function writeTest(state) {
  console.log("\n== Write: test records only");
  const server = await connect("write");
  const address = { address: "Teststrasse", street_number: "1", zip_code: "8000", city: "Zürich", state: "ZH", country_code: "CH" };

  const company = await server.call("abaninja_request", {
    method: "POST",
    path: `${ACCOUNT}/addresses/v2/addresses`,
    body: {
      type: "company",
      name: TEST_NAME,
      language: "de",
      private_notes: "Live test of abaninja-mcp. Safe to delete.",
      addresses: [address],
      contacts: [{ type: "phone", value: "+41 44 000 00 00", primary: true }],
    },
  });
  state.companyUuid = record(company.json)?.uuid;
  saveState(state);
  check("create company", !company.isError && !!state.companyUuid, company.isError ? company.text.slice(0, 200) : "");

  if (state.companyUuid) {
    const patched = await server.call("abaninja_request", {
      method: "PATCH",
      path: `${ACCOUNT}/addresses/v2/companies/${state.companyUuid}`,
      body: { contact_persons: [{ first_name: "Testa", last_name: "Muster", salutation: "Ms" }] },
    });
    const back = record((await server.call("abaninja_request", { method: "GET", path: `${ACCOUNT}/addresses/v2/companies/${state.companyUuid}` })).json);
    check("update company (contact person)", !patched.isError && back?.contact_persons?.[0]?.last_name === "Muster",
      patched.isError ? patched.text.slice(0, 200) : "");
  }

  const personRequest = {
    method: "POST",
    path: `${ACCOUNT}/addresses/v2/addresses`,
    body: {
      type: "person",
      first_name: "ZZ-Testperson",
      last_name: "abaninja-mcp",
      salutation: "Mr",
      language: "de",
      addresses: [{ ...address, street_number: "2", zip_code: "8001" }],
    },
  };
  let person = await server.call("abaninja_request", personRequest);
  // AbaNinja's duplicate check is fuzzy and reports the similar test company; force=true creates the person anyway.
  if (person.isError && /^AbaNinja API 409/.test(person.text)) {
    check("duplicate check reports the similar test company", person.text.includes(TEST_NAME));
    person = await server.call("abaninja_request", { ...personRequest, query: { force: true } });
  }
  state.personUuid = record(person.json)?.uuid;
  saveState(state);
  check("create person", !person.isError && !!state.personUuid, person.isError ? person.text.slice(0, 200) : "");
  if (state.personUuid) {
    const patched = await server.call("abaninja_request", {
      method: "PATCH",
      path: `${ACCOUNT}/addresses/v2/persons/${state.personUuid}`,
      body: { private_notes: "Live test of abaninja-mcp (changed). Safe to delete." },
    });
    check("update person", !patched.isError, patched.isError ? patched.text.slice(0, 200) : "");
  }

  const units = await server.call("abaninja_request", { method: "GET", path: `${ACCOUNT}/units/v2/units` });
  const unitList = units.json?.data ?? [];
  const unit = unitList.find((u) => /C62/i.test(JSON.stringify(u))) ?? unitList[0];
  const product = await server.call("abaninja_request", {
    method: "POST",
    path: `${ACCOUNT}/products/v2/products`,
    body: {
      productKey: "ZZ-TEST-ABANINJA-MCP",
      isService: true,
      unitUuid: unit?.uuid,
      cost: 1,
      translations: { de: { productName: TEST_NAME, productDescription: "Live test, safe to delete." } },
    },
  });
  state.productUuid = record(product.json)?.uuid;
  saveState(state);
  check("create product", !product.isError && !!state.productUuid, product.isError ? product.text.slice(0, 200) : "");
  if (state.productUuid) {
    const patched = await server.call("abaninja_request", {
      method: "PATCH",
      path: `${ACCOUNT}/products/v2/products/${state.productUuid}`,
      body: { cost: 2 },
    });
    check("update product", !patched.isError, patched.isError ? patched.text.slice(0, 200) : "");
  }

  const positions = [{ kind: "product", productDescription: "Live test position", singlePrice: 100, quantity: 2 }];
  for (const type of ["quotes", "invoices"]) {
    const calc = await server.call("abaninja_request", {
      method: "POST",
      path: `${ACCOUNT}/documents/v2/${type}/calculate`,
      body: { currencyCode: "CHF", positions },
    });
    check(`calculate ${type} (stores nothing)`, !calc.isError, calc.isError ? calc.text.slice(0, 200) : calc.text.replace(/\s+/g, " ").slice(0, 120));
  }

  const companyRecord = state.companyUuid
    ? record((await server.call("abaninja_request", { method: "GET", path: `${ACCOUNT}/addresses/v2/companies/${state.companyUuid}` })).json)
    : undefined;
  const addressUuid = companyRecord?.addresses?.[0]?.uuid;
  state.documents ??= [];
  const draftPositions = [
    ...(state.productUuid ? [{ kind: "product", productUuid: state.productUuid, quantity: 1 }] : []),
    { kind: "product", productDescription: "Live test position", singlePrice: 100, quantity: 2 },
  ];
  for (const type of addressUuid ? ["quotes", "invoices"] : []) {
    const draft = await server.call("abaninja_request", {
      method: "POST",
      path: `${ACCOUNT}/documents/v2/${type}`,
      body: {
        documents: [{
          title: `${TEST_NAME} (${type})`,
          receiver: { companyUuid: state.companyUuid, addressUuid },
          positions: draftPositions,
        }],
      },
    });
    const created = record(draft.json);
    if (created?.uuid) state.documents.push({ type, uuid: created.uuid });
    saveState(state);
    check(`create draft ${type}`, !draft.isError && created?.status === "draft",
      draft.isError ? draft.text.slice(0, 200) : `${created?.quoteNumber ?? created?.invoiceNumber ?? ""} total ${created?.documentTotal}`);
    if (!created?.uuid) continue;
    // A PATCH replaces the whole document, so the body repeats dates, currency, receiver and positions.
    const current = record((await server.call("abaninja_request", { method: "GET", path: `${ACCOUNT}/documents/v2/${type}/${created.uuid}` })).json);
    const dates = type === "quotes"
      ? { quoteDate: current?.quoteDate }
      : { invoiceDate: current?.invoiceDate, paymentInstructions: { bankAccountUuid: current?.paymentInstructions?.bankAccountUuid } };
    const patched = await server.call("abaninja_request", {
      method: "PATCH",
      path: `${ACCOUNT}/documents/v2/${type}/${created.uuid}`,
      body: {
        documents: [{
          ...dates,
          pricesIncludeVat: current?.pricesIncludeVat ?? false,
          currencyCode: current?.currencyCode ?? "CHF",
          receiver: { companyUuid: state.companyUuid, addressUuid },
          positions: draftPositions,
          title: `${TEST_NAME} (${type}, changed)`,
        }],
      },
    });
    if (patched.isError) console.log(`     ${type} fields read back: ${JSON.stringify({ ...dates, pricesIncludeVat: current?.pricesIncludeVat, currencyCode: current?.currencyCode })}`);
    const back = record((await server.call("abaninja_request", { method: "GET", path: `${ACCOUNT}/documents/v2/${type}/${created.uuid}` })).json);
    check(`update draft ${type}`, !patched.isError && /changed/.test(back?.title ?? ""), patched.isError ? patched.text.slice(0, 600) : "");
  }
  if (state.documents.some((d) => d.type === "invoices")) {
    const withDrafts = await server.call("abaninja_open_invoices", { customer_uuid: state.companyUuid, include_drafts: true });
    const withoutDrafts = await server.call("abaninja_open_invoices", { customer_uuid: state.companyUuid });
    check("open_invoices shows the draft only with include_drafts", withDrafts.json?.total === 1 && withoutDrafts.json?.total === 0,
      `${withDrafts.json?.total} with, ${withoutDrafts.json?.total} without`);
  }

  const found = await server.call("abaninja_search_addresses", { query: TEST_NAME });
  check("search finds the test company and person", found.json?.total === 2, `${found.json?.total} hits`);
  const phone = await server.call("abaninja_search_addresses", { query: "044 000 00 00" });
  check("search by phone in national format", phone.json?.total >= 1);

  console.log("\n== Write mode refuses (made-up uuids, nothing reaches AbaNinja)");
  const blocked = [
    ["e-mail a quote", { method: "PATCH", path: `${ACCOUNT}/documents/v2/quotes/${FAKE_UUID}/actions/email`, body: {} }],
    ["dun an invoice", { method: "PATCH", path: `${ACCOUNT}/documents/v2/invoices/${FAKE_UUID}/actions/dunningSent`, body: {} }],
    ["bulk send", { method: "PATCH", path: `${ACCOUNT}/documents/v2/invoices/bulk-actions/massSent`, body: { documentUuids: [FAKE_UUID] } }],
    ["DELETE", { method: "DELETE", path: `${ACCOUNT}/addresses/v2/companies/${FAKE_UUID}` }],
    ["_method override", { method: "POST", path: `${ACCOUNT}/addresses/v2/companies/${FAKE_UUID}`, query: { _method: "DELETE" } }],
    ["NUL in a query name", { method: "POST", path: `${ACCOUNT}/addresses/v2/companies/${FAKE_UUID}`, query: { "_method\u0000": "DELETE" } }],
    ["outgoing webhook change", { method: "PATCH", path: `${ACCOUNT}/webhooks/v2/outgoing-webhooks/${FAKE_UUID}`, body: {} }],
    ["payment confirmation e-mail", { method: "POST", path: `${ACCOUNT}/finances/v2/payments`, body: { processing: { type: "receipt", documentUuid: FAKE_UUID, sendPaymentConfirmation: "1" } } }],
    ["path leaving api.abaninja.ch", { method: "GET", path: "/\t/example.com/x" }],
  ];
  for (const [label, args] of blocked) {
    const r = await server.call("abaninja_request", args);
    check(`refused: ${label}`, r.isError && !/^AbaNinja API/.test(r.text), r.text.slice(0, 90));
  }
  await server.close();
}

const nothingLeft = (state) => !state.companyUuid && !state.personUuid && !state.productUuid && !state.documents?.length;

async function cleanup() {
  const state = loadState();
  if (nothingLeft(state)) return;
  console.log("\n== Cleanup: delete the test records (full mode, own uuids only)");
  const server = await connect("full");
  for (const document of [...(state.documents ?? [])]) {
    const path = `${ACCOUNT}/documents/v2/${document.type}/${document.uuid}`;
    const del = await server.call("abaninja_request", { method: "PATCH", path: `${path}/actions/delete`, body: {} });
    const gone = await server.call("abaninja_request", { method: "GET", path });
    const ok = /^AbaNinja API 404/.test(gone.text);
    check(`delete test draft ${document.type}`, ok, del.isError ? del.text.slice(0, 160) : "");
    if (ok) state.documents = state.documents.filter((d) => d.uuid !== document.uuid);
    saveState(state);
  }
  const targets = [
    ["productUuid", "product", `${ACCOUNT}/products/v2/products/`],
    ["personUuid", "person", `${ACCOUNT}/addresses/v2/persons/`],
    ["companyUuid", "company", `${ACCOUNT}/addresses/v2/companies/`],
  ];
  for (const [key, label, base] of targets) {
    if (!state[key]) continue;
    const del = await server.call("abaninja_request", { method: "DELETE", path: base + state[key] });
    const gone = await server.call("abaninja_request", { method: "GET", path: base + state[key] });
    const ok = /^AbaNinja API 404/.test(gone.text);
    check(`delete test ${label}`, ok, del.isError ? del.text.slice(0, 160) : "");
    if (ok) delete state[key];
    saveState(state);
  }
  const left = await server.call("abaninja_search_addresses", { query: TEST_NAME, include_archived: true });
  check("no test addresses left", left.json?.total === 0, `${left.json?.total ?? "?"} found`);
  await server.close();
  if (nothingLeft(state)) unlinkSync(STATE_FILE);
  else console.log(`Left over, see ${STATE_FILE.pathname}: ${JSON.stringify(state)}`);
}

if (!env.ABANINJA_API_TOKEN) throw new Error("ABANINJA_API_TOKEN is not set.");
if (options.has("--cleanup")) {
  await cleanup();
} else {
  await readTest();
  if (options.has("--write")) {
    const state = loadState();
    try {
      await writeTest(state);
    } finally {
      await cleanup();
    }
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
