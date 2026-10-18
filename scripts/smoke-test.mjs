// Read-only smoke test: starts the built server over stdio and calls all five tools.
// Reads ABANINJA_API_TOKEN from ../.env (or the environment). Never prints the token.
// Usage: npm run build && node scripts/smoke-test.mjs
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = { ...process.env };
const envFile = new URL("../../.env", import.meta.url);
if (!env.ABANINJA_API_TOKEN && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...env, ABANINJA_MODE: "read" },
    stderr: "inherit",
  }),
);

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " – " + detail : ""}`);
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  let json;
  try { json = JSON.parse(text); } catch { /* plain text error */ }
  return { isError: !!result.isError, text, json };
}

const tools = (await client.listTools()).tools;
check("5 tools registered", tools.length === 5, tools.map((t) => t.name).join(", "));

let r = await call("abaninja_list_endpoints", { area: "documents", query: "invoice", method: "GET", limit: 5 });
check("list_endpoints", !r.isError && r.json.total > 0, `${r.json?.total} hits`);

r = await call("abaninja_describe_endpoint", { method: "POST", path: "/accounts/{accountUuid}/documents/v2/invoices" });
check("describe_endpoint", !r.isError && r.json.body?.length > 0, `${r.json?.body?.length} body fields`);

r = await call("abaninja_describe_endpoint", { method: "GET", path: "/nope" });
check("describe_endpoint unknown path is an error", r.isError);

r = await call("abaninja_request", { method: "GET", path: "/accounts/{accountUuid}/addresses/v2/companies", query: { limit: 1 } });
check("request GET", !r.isError && r.json.data?.length === 1);

r = await call("abaninja_request", { method: "POST", path: "/accounts/{accountUuid}/addresses/v2/addresses", body: {} });
check("request POST blocked in read mode", r.isError && /not allowed in read mode/.test(r.text), r.text.slice(0, 80));

r = await call("abaninja_request", { method: "GET", path: "https://example.com/x" });
check("request rejects full URLs", r.isError && /not a URL/.test(r.text));

r = await call("abaninja_search_addresses", { limit: 3 });
check("search_addresses list", !r.isError && r.json.total > 0, `${r.json?.total} addresses`);
const first = r.json?.items?.[0];
const word = first?.name?.split(/\s+/)[0];
r = await call("abaninja_search_addresses", { query: word, limit: 5 });
check("search_addresses by name", !r.isError && r.json.total > 0, `${r.json?.total} hits`);
r = await call("abaninja_search_addresses", { query: first?.customerNumber, limit: 5 });
check("search_addresses by customer number", !r.isError && r.json.total > 0);

r = await call("abaninja_open_invoices", { limit: 3 });
check("open_invoices", !r.isError && typeof r.json.totalOpenAmount === "number", `${r.json?.total} open, sum ${r.json?.totalOpenAmount}`);
const inv = r.json?.items?.[0];
if (inv) {
  const key = inv.companyUuid ? { company_uuid: inv.companyUuid } : { person_uuid: inv.personUuid };
  const per = await call("abaninja_open_invoices", key);
  check("open_invoices per customer", !per.isError && per.json.total >= 1 && per.json.total <= r.json.total, `${per.json?.total} open`);
}

await client.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
