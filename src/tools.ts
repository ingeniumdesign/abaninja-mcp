import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AbaNinjaClient } from "./abaninja.js";

// Registers the MCP tools:
// - abaninja_list_endpoints     find endpoints by area or keyword (from catalog/)
// - abaninja_describe_endpoint  parameters and fields of one endpoint
// - abaninja_request            call any endpoint within the configured mode
// - abaninja_search_addresses   search companies and persons (the API has no search)
// - abaninja_open_invoices      open invoices, optionally per customer (the API has no customer filter)

interface Endpoint {
  area: string;
  method: string;
  path: string;
  summary: string;
  tag?: string;
  params?: { name: string; in: string; type: string; required?: boolean; description?: string }[];
  body?: { name: string; type: string; required?: boolean; description?: string }[];
}

type Row = Record<string, any>;

const MAX_RESPONSE_CHARS = 50_000;
const PAGE_SIZE = 400;
const CACHE_MS = 60_000;

let catalog: Endpoint[] | undefined;
function loadCatalog(): Endpoint[] {
  catalog ??= JSON.parse(
    readFileSync(new URL("../catalog/endpoints.json", import.meta.url), "utf8"),
  ) as Endpoint[];
  return catalog;
}

// Drops null, empty strings, empty arrays and empty objects to keep answers short.
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, prune(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null || value === "" ? undefined : value;
}

function reply(data: unknown) {
  let text = JSON.stringify(prune(data) ?? null, null, 1);
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n… truncated (${text.length} characters). Narrow the request with limit, page or filters.`;
  }
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// Fetches every page of a list endpoint. Stops when a page has fewer than PAGE_SIZE entries.
async function fetchAll(
  client: AbaNinjaClient,
  path: string,
  query: Record<string, string | number | boolean>,
  pick: (body: any) => Row[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; page <= 100; page++) {
    const body = await client.request("GET", path, { query: { ...query, limit: PAGE_SIZE, page } });
    const batch = pick(body);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function cached<T>(load: () => Promise<T>): () => Promise<T> {
  let entry: { at: number; value: Promise<T> } | undefined;
  return () => {
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const value = load();
      const current = { at: Date.now(), value };
      entry = current;
      value.catch(() => {
        if (entry === current) entry = undefined;
      });
    }
    return entry.value;
  };
}

function paged<T>(items: T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  return { total: items.length, offset, count: slice.length, items: slice };
}

function addressView(row: Row, kind: "company" | "person") {
  return {
    kind,
    uuid: row.uuid,
    customerNumber: row.customer_number,
    name: kind === "company" ? row.company_name : [row.first_name, row.last_name].filter(Boolean).join(" "),
    contacts: row.contacts?.map((c: Row) => `${c.type}: ${c.value}`),
    addresses: row.addresses?.map((a: Row) => ({
      uuid: a.uuid,
      address: [a.address, a.street_number].filter(Boolean).join(" "),
      zip: a.zip_code,
      city: a.city,
      country: a.country_code,
    })),
    contactPersons: row.contact_persons?.map((p: Row) => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(" "),
      contacts: p.contacts?.map((c: Row) => c.value),
    })),
    tags: row.tags,
    archived: row.isArchived || undefined,
  };
}

function searchText(row: Row): string {
  const parts: unknown[] = [
    row.company_name, row.first_name, row.last_name, row.customer_number, row.id_number, row.vat_number,
    ...(row.tags ?? []),
    ...(row.contacts ?? []).map((c: Row) => c.value),
    ...(row.addresses ?? []).flatMap((a: Row) => [a.address, a.zip_code, a.city]),
    ...(row.contact_persons ?? []).flatMap((p: Row) => [
      p.first_name, p.last_name, ...(p.contacts ?? []).map((c: Row) => c.value),
    ]),
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function registerTools(server: McpServer, client: AbaNinjaClient): void {
  const loadAddresses = cached(async () => {
    const [companies, persons] = await Promise.all([
      fetchAll(client, "/accounts/{accountUuid}/addresses/v2/companies", {}, (b) => b.data ?? []),
      fetchAll(client, "/accounts/{accountUuid}/addresses/v2/persons", {}, (b) => b.data ?? []),
    ]);
    return [
      ...companies.map((row) => ({ row, kind: "company" as const })),
      ...persons.map((row) => ({ row, kind: "person" as const })),
    ];
  });

  server.registerTool(
    "abaninja_list_endpoints",
    {
      title: "List AbaNinja API endpoints",
      description:
        "Find AbaNinja REST API endpoints by area and/or keywords. Areas: accounting, accounts, addresses, documents, exports, finances, holidays, products, time-tracking, units, warehouse, webhooks. Use abaninja_describe_endpoint for details and abaninja_request to call one.",
      inputSchema: {
        area: z.string().optional().describe("Area name, e.g. documents"),
        query: z.string().optional().describe("Keywords that must all appear in method, path or summary, e.g. 'invoice send'"),
        method: methodSchema.optional(),
        limit: z.number().int().min(1).max(200).default(40),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ area, query, method, limit, offset }) => {
      try {
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = loadCatalog().filter((e) => {
          if (area && e.area !== area.toLowerCase()) return false;
          if (method && e.method !== method) return false;
          const text = `${e.method} ${e.path} ${e.summary} ${e.tag ?? ""}`.toLowerCase();
          return words.every((word) => text.includes(word));
        });
        return reply(
          paged(
            hits.map((e) => ({ method: e.method, path: e.path, summary: e.summary })),
            offset,
            limit,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "abaninja_describe_endpoint",
    {
      title: "Describe an AbaNinja API endpoint",
      description:
        "Show the parameters and request body fields of one endpoint from the catalog. Path as listed by abaninja_list_endpoints (with {accountUuid}).",
      inputSchema: {
        method: methodSchema,
        path: z.string().describe("Endpoint path, e.g. /accounts/{accountUuid}/documents/v2/invoices"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ method, path }) => {
      try {
        const wanted = path.replace(/^\/accounts\/[0-9a-f-]{36}/i, "/accounts/{accountUuid}").replace(/\/$/, "");
        const hit = loadCatalog().find((e) => e.method === method && e.path === wanted);
        if (!hit) {
          throw new Error(`No ${method} ${path} in the catalog. Use abaninja_list_endpoints to find the path.`);
        }
        return reply(hit);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "abaninja_request",
    {
      title: "Call an AbaNinja API endpoint",
      description:
        "Call any AbaNinja REST API endpoint. Put {accountUuid} in the path and it is filled in automatically. Which methods and actions are allowed depends on the server mode (ABANINJA_MODE: read = GET only, write = also create/change, full = everything incl. delete/send/dun). POST, PATCH, PUT and DELETE change data in the real account.",
      inputSchema: {
        method: methodSchema,
        path: z.string().describe("Path starting with /, e.g. /accounts/{accountUuid}/documents/v2/invoices"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters"),
        body: z.unknown().optional().describe("JSON request body"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ method, path, query, body }) => {
      try {
        return reply(await client.request(method, path, { query, body }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "abaninja_search_addresses",
    {
      title: "Search AbaNinja addresses",
      description:
        "Search companies and persons by name, customer number, e-mail, phone, city, tag or contact person. The API has no search, so all addresses are loaded (cached for 60 seconds) and filtered locally. All words in the query must match. Without a query it lists everything page by page.",
      inputSchema: {
        query: z.string().optional().describe("Search words, e.g. 'muster zürich'"),
        kind: z.enum(["company", "person", "all"]).default("all"),
        tag: z.string().optional().describe("Only addresses with this tag"),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, kind, tag, include_archived, limit, offset }) => {
      try {
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = (await loadAddresses()).filter(({ row, kind: rowKind }) => {
          if (kind !== "all" && rowKind !== kind) return false;
          if (!include_archived && row.isArchived) return false;
          if (tag && !(row.tags ?? []).some((t: string) => t.toLowerCase() === tag.toLowerCase())) return false;
          const text = searchText(row);
          return words.every((word) => text.includes(word));
        });
        const result = paged(hits, offset, limit);
        return reply({ ...result, items: result.items.map(({ row, kind: rowKind }) => addressView(row, rowKind)) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "abaninja_open_invoices",
    {
      title: "List open AbaNinja invoices",
      description:
        "Open invoices (openAmount > 0, not cancelled, no templates; drafts only with include_drafts) with amount, due date and dunning level, sorted by due date. Optionally only for one customer: pass the company or person uuid from abaninja_search_addresses. The API has no customer filter, so invoices are loaded and filtered locally.",
      inputSchema: {
        company_uuid: z.string().optional().describe("Customer company uuid (receiver.companyUuid)"),
        person_uuid: z.string().optional().describe("Customer person uuid (receiver.personUuid)"),
        overdue_only: z.boolean().default(false),
        include_drafts: z.boolean().default(false).describe("Drafts have an open amount but are not yet claims"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ company_uuid, person_uuid, overdue_only, include_drafts, limit, offset }) => {
      try {
        const invoices = await fetchAll(
          client,
          "/accounts/{accountUuid}/documents/v2/invoices",
          { is_template: false },
          (b) => b.data?.documents ?? [],
        );
        const today = new Date().toISOString().slice(0, 10);
        const open = invoices
          .filter((i) => Number(i.openAmount) > 0 && !i.isCancelled && !i.isTemplate)
          .filter((i) => include_drafts || i.status !== "draft")
          .filter((i) => !company_uuid || i.receiver?.companyUuid === company_uuid)
          .filter((i) => !person_uuid || i.receiver?.personUuid === person_uuid)
          .filter((i) => !overdue_only || (i.dueDate && i.dueDate < today))
          .sort((a, b) => String(a.dueDate ?? "").localeCompare(String(b.dueDate ?? "")));
        const total = open.reduce((sum, i) => sum + Number(i.openAmount), 0);
        const result = paged(open, offset, limit);
        return reply({
          ...result,
          totalOpenAmount: Math.round(total * 100) / 100,
          items: result.items.map((i) => ({
            uuid: i.uuid,
            invoiceNumber: i.invoiceNumber,
            title: i.title,
            status: i.status,
            customer: i.receiver?.name,
            customerNumber: i.receiver?.customerNumber,
            companyUuid: i.receiver?.companyUuid,
            personUuid: i.receiver?.personUuid,
            invoiceDate: i.invoiceDate,
            dueDate: i.dueDate,
            overdue: i.dueDate ? i.dueDate < today : undefined,
            currency: i.currencyCode,
            documentTotal: i.documentTotal,
            openAmount: i.openAmount,
            dunningLevel: i.dunningLevel,
            nextDunningDate: i.nextDunningDate,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
