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
  body?: {
    name: string;
    type: string;
    required?: boolean;
    requiredIf?: string;
    requiredUnless?: string;
    description?: string;
    note?: string;
  }[];
  note?: string;
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

function isPage(value: unknown): value is { offset: number; items: unknown[] } {
  const page = value as { offset?: unknown; items?: unknown } | null;
  return !!page && typeof page.offset === "number" && Array.isArray(page.items);
}

// The main list of a raw API answer: the answer itself, data, or data.documents.
function listOf(value: any): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.data?.documents)) return value.data.documents;
  return undefined;
}

function withList(value: any, items: unknown[], total: number): unknown {
  const shortened = { shown: items.length, total, hint: "Fetch the rest with the page and limit (or perPage) parameters." };
  if (Array.isArray(value)) return { shortened, items };
  if (Array.isArray(value.data)) return { shortened, ...value, data: items };
  return { shortened, ...value, data: { ...value.data, documents: items } };
}

function reply(data: unknown) {
  let value: any = prune(data) ?? null;
  let text = JSON.stringify(value, null, 1);
  if (text.length > MAX_RESPONSE_CHARS && isPage(value)) {
    // A page of this server drops whole items from the end, so count and nextOffset stay exact.
    while (text.length > MAX_RESPONSE_CHARS && value.items.length > 1) {
      const keep = Math.max(1, Math.floor((value.items.length * MAX_RESPONSE_CHARS) / text.length) - 1);
      const items = value.items.slice(0, keep);
      value = { ...value, count: items.length, nextOffset: value.offset + items.length, items, shortened: true };
      text = JSON.stringify(value, null, 1);
    }
  } else if (text.length > MAX_RESPONSE_CHARS && listOf(value)) {
    // A raw API list drops whole entries from the end and says how many are shown.
    const all = listOf(value) ?? [];
    let keep = all.length;
    while (text.length > MAX_RESPONSE_CHARS && keep > 1) {
      keep = Math.max(1, Math.floor((keep * MAX_RESPONSE_CHARS) / text.length) - 1);
      text = JSON.stringify(withList(value, all.slice(0, keep), all.length), null, 1);
    }
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n… cut off after ${MAX_RESPONSE_CHARS} of ${text.length} characters, so the JSON above is incomplete. Request fewer entries or a single record.`;
  }
  return { content: [{ type: "text" as const, text }] };
}

// Today's date in Switzerland as YYYY-MM-DD: AbaNinja due dates are Swiss calendar dates.
function swissToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
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
  const next = offset + slice.length;
  return {
    total: items.length,
    offset,
    count: slice.length,
    nextOffset: next < items.length ? next : undefined,
    items: slice,
  };
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

const normalize = (text: string) => text.normalize("NFC").toLowerCase();

// Phone numbers starting with +, 00 or 0, written with spaces, dots, dashes, slashes or brackets.
const PHONE = /(?:\+|\b0)\d[\d\s()/.-]{5,}\d/g;

// A phone number as international digits: "+41 44 123 45 67" and "044 123 45 67" both give "41441234567".
function phoneKey(text: string): string {
  const digits = text.replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return `41${digits.slice(1)}`;
  return digits;
}

// Splits a search query into words without surrounding punctuation; phone numbers become one key.
function queryWords(query: string): string[] {
  const text = normalize(query);
  const phones = (text.match(PHONE) ?? []).map(phoneKey);
  const words = text
    .replace(PHONE, " ")
    .split(/[\s,;]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}@+]+|[^\p{L}\p{N}]+$/gu, ""));
  return [...words, ...phones].filter(Boolean);
}

function searchText(row: Row): string {
  const contacts: Row[] = [
    ...(row.contacts ?? []),
    ...(row.contact_persons ?? []).flatMap((p: Row) => p.contacts ?? []),
  ];
  const parts: unknown[] = [
    row.company_name, row.first_name, row.last_name, row.customer_number, row.id_number, row.vat_number,
    ...(row.tags ?? []),
    ...contacts.map((c) => c.value),
    ...contacts.filter((c) => /phone|mobile|fax/i.test(String(c.type))).map((c) => phoneKey(String(c.value))),
    ...(row.addresses ?? []).flatMap((a: Row) => [
      a.address, a.street_number, a.extension, a.additional_field, a.zip_code, a.city,
    ]),
    ...(row.contact_persons ?? []).flatMap((p: Row) => [p.first_name, p.last_name]),
  ];
  return normalize(parts.filter(Boolean).join(" "));
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
        "Show the parameters and request body fields of one endpoint from the catalog. Path as listed by abaninja_list_endpoints (with {accountUuid}). Fields with required are always needed; requiredIf names the variant that needs them (e.g. type=company), requiredUnless the alternative that replaces them (e.g. isTemplate=true). Nested fields use dots, list items [].",
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
        path: z
          .string()
          .describe("Plain path as listed in the catalog, e.g. /accounts/{accountUuid}/documents/v2/invoices. No query string."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe("Query parameters; lists repeat the key, e.g. {\"tags[]\": [\"VIP\", \"A\"]}"),
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
        const words = queryWords(query ?? "");
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
        "Open invoices (openAmount > 0, not cancelled, no templates; drafts only with include_drafts) with amount, due date and dunning level, sorted by due date. Totals are given per currency (CHF and EUR are never added up). Optionally only for one customer: pass the company or person uuid from abaninja_search_addresses. The API has no customer filter, so invoices are loaded and filtered locally.",
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
        const today = swissToday();
        const isOverdue = (i: Row) => !!i.dueDate && String(i.dueDate).slice(0, 10) < today;
        const open = invoices
          .filter((i) => Number(i.openAmount) > 0 && !i.isCancelled && !i.isTemplate)
          .filter((i) => include_drafts || i.status !== "draft")
          .filter((i) => !company_uuid || i.receiver?.companyUuid === company_uuid)
          .filter((i) => !person_uuid || i.receiver?.personUuid === person_uuid)
          .filter((i) => !overdue_only || isOverdue(i))
          .sort((a, b) => String(a.dueDate ?? "").localeCompare(String(b.dueDate ?? "")));
        // Amounts are summed per currency: CHF and EUR must never be added up.
        const totals: Record<string, number> = {};
        for (const i of open) {
          const currency = i.currencyCode ?? "unknown";
          totals[currency] = (totals[currency] ?? 0) + Number(i.openAmount);
        }
        for (const currency of Object.keys(totals)) {
          totals[currency] = Math.round(totals[currency] * 100) / 100;
        }
        const result = paged(open, offset, limit);
        return reply({
          total: result.total,
          totalOpenAmountByCurrency: totals,
          offset: result.offset,
          count: result.count,
          nextOffset: result.nextOffset,
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
            overdue: i.dueDate ? isOverdue(i) : undefined,
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
