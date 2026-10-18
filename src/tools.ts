import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AbaNinjaClient } from "./abaninja.js";

// Registers the MCP tools:
// - abaninja_list_endpoints     find endpoints by area or keyword (from catalog/)
// - abaninja_describe_endpoint  parameters and fields of one endpoint
// - abaninja_request            call any endpoint within the configured mode
// - abaninja_search_addresses   search companies and persons (the API has no search)
// - abaninja_find_documents     find invoices, quotes and other documents by number, text or customer
// - abaninja_open_invoices      open invoices with totals per currency (the API has no customer filter)

interface Endpoint {
  area: string;
  method: string;
  path: string;
  summary: string;
  tag?: string;
  params?: { name: string; in: string; type: string; required?: boolean; description?: string }[];
  body?: { name: string; type: string; required?: boolean; requiredIf?: string; requiredUnless?: string; description?: string }[];
  note?: string;
}

type Row = Record<string, any>;

const MAX_RESPONSE_CHARS = 50_000;
const PAGE_SIZE = 400;
const MAX_PAGES = 100;
const CACHE_MS = 60_000;
const DOCUMENT_TYPES = [
  "invoices", "quotes", "credit-notes", "delivery-notes", "contract-notes", "receipts", "supplier-credit-notes",
] as const;

const catalog: Endpoint[] = JSON.parse(readFileSync(new URL("../catalog/endpoints.json", import.meta.url), "utf8"));
const AREAS = [...new Set(catalog.map((e) => e.area))].sort() as [string, ...string[]];

// Drops null and empty strings to keep answers short, keeps empty lists (an empty result is information)
// and hides secrets such as webhook signature keys.
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, /^(signatureKey|secret|password)$/i.test(key) && item ? "[hidden]" : prune(item)] as const)
      .filter(([, item]) => item !== undefined);
    return Object.fromEntries(entries);
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

function withList(value: any, items: unknown[], entriesOnPage: number): unknown {
  const shortened = {
    shown: items.length,
    entriesOnPage,
    hint: "Only the first entries of this page fit. Request a smaller limit (or perPage) to see the rest of the page.",
  };
  if (Array.isArray(value)) return { shortened, items };
  if (Array.isArray(value.data)) return { shortened, ...value, data: items };
  return { shortened, ...value, data: { ...value.data, documents: items } };
}

function reply(data: unknown) {
  let value: any = prune(data) ?? null;
  let text = JSON.stringify(value);
  if (text.length > MAX_RESPONSE_CHARS && isPage(value)) {
    // A page of this server drops whole items from the end, so count and nextOffset stay exact.
    while (text.length > MAX_RESPONSE_CHARS && value.items.length > 1) {
      const keep = Math.max(1, Math.floor((value.items.length * MAX_RESPONSE_CHARS) / text.length) - 1);
      const items = value.items.slice(0, keep);
      value = { ...value, count: items.length, nextOffset: value.offset + items.length, items, shortened: true };
      text = JSON.stringify(value);
    }
  } else if (text.length > MAX_RESPONSE_CHARS && listOf(value)) {
    // A raw API list drops whole entries from the end and says how many are shown.
    const all = listOf(value) ?? [];
    let keep = all.length;
    while (text.length > MAX_RESPONSE_CHARS && keep > 1) {
      keep = Math.max(1, Math.floor((keep * MAX_RESPONSE_CHARS) / text.length) - 1);
      text = JSON.stringify(withList(value, all.slice(0, keep), all.length));
    }
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n… cut off after ${MAX_RESPONSE_CHARS} of ${text.length} characters, so the JSON above is incomplete. Request fewer entries or a single record.`;
  }
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

// Today's date in Switzerland as YYYY-MM-DD: AbaNinja due dates are Swiss calendar dates.
function swissToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
}

// Fetches every page of a list endpoint until a page has fewer than PAGE_SIZE entries.
// complete is false when MAX_PAGES were not enough.
async function fetchAll(
  client: AbaNinjaClient,
  path: string,
  query: Record<string, string | number | boolean>,
  pick: (body: any) => unknown,
): Promise<{ rows: Row[]; complete: boolean }> {
  const rows: Row[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = pick(await client.request("GET", path, { query: { ...query, limit: PAGE_SIZE, page } }));
    if (!Array.isArray(batch)) throw new Error(`Unexpected answer from ${path}: no list found.`);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

const INCOMPLETE = `Only the first ${MAX_PAGES * PAGE_SIZE} entries were loaded, so results and totals are incomplete.`;

function cached<T>(load: () => Promise<T>): { get: () => Promise<T>; clear: () => void } {
  let entry: { at: number; value: Promise<T> } | undefined;
  return {
    get() {
      if (!entry || Date.now() - entry.at > CACHE_MS) {
        const value = load();
        const current = { at: Date.now(), value };
        entry = current;
        value.catch(() => {
          if (entry === current) entry = undefined;
        });
      }
      return entry.value;
    },
    clear() {
      entry = undefined;
    },
  };
}

function paged<T>(items: T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { total: items.length, offset, count: slice.length, nextOffset: next < items.length ? next : undefined, items: slice };
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
      uuid: p.uuid,
      name: [p.first_name, p.last_name].filter(Boolean).join(" "),
      contacts: p.contacts?.map((c: Row) => c.value),
    })),
    tags: row.tags,
    archived: row.isArchived || undefined,
  };
}

// Lower case without accents ("Zürich" -> "zurich"). The German spelling ("zuerich") is indexed as well.
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss");
const germanSpelling = (text: string) =>
  text.normalize("NFC").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
const indexText = (parts: unknown[]) => {
  const text = parts.filter((part) => part !== undefined && part !== null && part !== "").join(" ");
  return `${fold(text)}\n${germanSpelling(text)}`;
};

// Phone numbers starting with +, 00 or 0, written with spaces, dots, dashes, slashes or brackets.
const PHONE = /(?:\+|\b0)\d[\d\s()/.-]{5,}\d/g;

// A phone number as international digits: "+41 44 123 45 67", "+41 (0)44 123 45 67" and "044 123 45 67"
// all give "41441234567".
function phoneKey(text: string): string {
  const digits = text.replace(/\(\s*0\s*\)/g, "").replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return `41${digits.slice(1)}`;
  return digits;
}

// A phone number has at most 13 digits; digit groups after that (e.g. a postcode) are separate words.
function splitPhone(candidate: string): [string, string] {
  const groups = candidate.trim().split(/\s+/);
  let digits = 0;
  let count = 0;
  for (const group of groups) {
    const length = group.replace(/\(\s*0\s*\)/g, "").replace(/\D/g, "").length;
    if (count > 0 && digits + length > 13) break;
    digits += length;
    count++;
  }
  return [groups.slice(0, count).join(" "), groups.slice(count).join(" ")];
}

// Splits a search query into terms. Each term lists the spellings that count as a match: a word without
// surrounding punctuation, and for something that looks like a phone number also its digits and phone key,
// so "01234567" still finds a customer number and "044 123 45 67" finds "+41 44 123 45 67".
function queryTerms(query: string): string[][] {
  const terms: string[][] = [];
  const rest = fold(query).replace(PHONE, (candidate) => {
    const [phone, after] = splitPhone(candidate);
    terms.push([phone, phone.replace(/\D/g, ""), phoneKey(phone)]);
    return ` ${after} `;
  });
  for (const word of rest.split(/[\s,;]+/)) {
    const clean = word.replace(/^[^\p{L}\p{N}@+]+|[^\p{L}\p{N}]+$/gu, "");
    if (clean) terms.push([clean]);
  }
  return terms;
}

const matches = (terms: string[][], text: string) => terms.every((spellings) => spellings.some((s) => text.includes(s)));

function addressText(row: Row): string {
  const contacts: Row[] = [...(row.contacts ?? []), ...(row.contact_persons ?? []).flatMap((p: Row) => p.contacts ?? [])];
  return indexText([
    row.company_name, row.first_name, row.last_name, row.customer_number, row.id_number, row.vat_number,
    ...(row.tags ?? []),
    ...contacts.map((c) => c.value),
    ...contacts.filter((c) => /phone|mobile|fax/i.test(String(c.type))).map((c) => phoneKey(String(c.value))),
    ...(row.addresses ?? []).flatMap((a: Row) => [a.address, a.street_number, a.extension, a.additional_field, a.zip_code, a.city]),
    ...(row.contact_persons ?? []).flatMap((p: Row) => [p.first_name, p.last_name]),
  ]);
}

// The document number, whatever the type calls it (invoiceNumber, quoteNumber, …).
function documentNumber(doc: Row): string | undefined {
  const key = Object.keys(doc).find((k) => /Number$/.test(k) && !/^(customer|imported|system)/i.test(k) && doc[k]);
  return key ? String(doc[key]) : undefined;
}

function documentView(doc: Row) {
  return {
    uuid: doc.uuid,
    number: documentNumber(doc),
    title: doc.title,
    status: doc.status,
    date: doc.invoiceDate ?? doc.quoteDate ?? doc.documentDate ?? doc.receiptDate ?? doc.deliveryDate,
    dueDate: doc.dueDate,
    customer: doc.receiver?.name,
    customerNumber: doc.receiver?.customerNumber,
    companyUuid: doc.receiver?.companyUuid,
    personUuid: doc.receiver?.personUuid,
    currency: doc.currencyCode,
    total: doc.documentTotal,
    openAmount: doc.openAmount,
    archived: doc.isArchived || undefined,
    cancelled: doc.isCancelled || undefined,
  };
}

const isCustomer = (doc: Row, uuid: string) => doc.receiver?.companyUuid === uuid || doc.receiver?.personUuid === uuid;

// Turns "/accounts/{accountUuid}/documents/v2/{type}/{uuid}" into a pattern that also matches real values.
const templatePattern = (path: string) => new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`, "i");

const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const limitSchema = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const offsetSchema = z.number().int().min(0).default(0);
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const MODE_TEXT = {
  read: "This server runs in read mode: only GET is allowed.",
  write:
    "This server runs in write mode: GET, POST, PATCH and PUT are allowed; deleting, sending, dunning, bulk actions, bank details, outgoing webhooks and imports from a URL are refused.",
  full: "This server runs in full mode: every call is allowed, including deleting and sending. Confirm such calls with the user first.",
};

export function registerTools(server: McpServer, client: AbaNinjaClient): void {
  const addresses = cached(async () => {
    const [companies, persons] = await Promise.all([
      fetchAll(client, "/accounts/{accountUuid}/addresses/v2/companies", {}, (b) => b?.data),
      fetchAll(client, "/accounts/{accountUuid}/addresses/v2/persons", {}, (b) => b?.data),
    ]);
    return {
      complete: companies.complete && persons.complete,
      rows: [
        ...companies.rows.map((row) => ({ row, kind: "company" as const })),
        ...persons.rows.map((row) => ({ row, kind: "person" as const })),
      ],
    };
  });
  const loadDocuments = (type: string) =>
    fetchAll(client, `/accounts/{accountUuid}/documents/v2/${type}`, { is_template: false }, (b) => b?.data?.documents);

  server.registerTool(
    "abaninja_list_endpoints",
    {
      title: "List AbaNinja API endpoints",
      description:
        "Find AbaNinja REST API endpoints by area and keywords. Document actions are named like /actions/email, /actions/markSent or /actions/delete. Use abaninja_describe_endpoint for the fields and abaninja_request to call one.",
      inputSchema: z
        .object({
          area: z.enum(AREAS).optional().describe("Only this area"),
          query: z.string().optional().describe("Words that must all appear in method, path or summary, e.g. 'invoice email'"),
          method: methodSchema.optional(),
          limit: limitSchema(200, 40),
          offset: offsetSchema,
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ area, query, method, limit, offset }) => {
      try {
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = catalog.filter((e) => {
          if (area && e.area !== area) return false;
          if (method && e.method !== method) return false;
          const text = `${e.method} ${e.path} ${e.summary} ${e.tag ?? ""}`.toLowerCase();
          return words.every((word) => text.includes(word));
        });
        return reply(paged(hits.map((e) => ({ method: e.method, path: e.path, summary: e.summary })), offset, limit));
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
        "Show the parameters and request body fields of one endpoint, from the official API description. Fields with required are always needed; requiredIf names the case that needs them (e.g. type=company), requiredUnless the alternative that replaces them (e.g. isTemplate=true). Nested fields use dots, list items []. The live API can be stricter than this description (e.g. Swiss addresses need state). A PATCH on a document replaces the whole document, so send all of its fields.",
      inputSchema: z
        .object({
          method: methodSchema,
          path: z.string().describe("Path as listed by abaninja_list_endpoints, placeholders or real values both work"),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ method, path }) => {
      try {
        const wanted = path.replace(/\/$/, "");
        const hit =
          catalog.find((e) => e.method === method && e.path === wanted) ??
          catalog.find((e) => e.method === method && templatePattern(e.path).test(wanted));
        if (!hit) {
          throw new Error(`No ${method} ${path} in the catalog. Use abaninja_list_endpoints to find the path.`);
        }
        return reply(hit);
      } catch (error) {
        return fail(error);
      }
    },
  );

  const changes = client.mode !== "read";
  server.registerTool(
    "abaninja_request",
    {
      title: "Call an AbaNinja API endpoint",
      description:
        `Call any AbaNinja REST API endpoint. ${MODE_TEXT[client.mode]} ` +
        "Put {accountUuid} in the path and it is filled in; fill in all other placeholders yourself. " +
        "Lists take page and limit (up to 400); document lists give no total, so fetch the next page until fewer than limit entries come back. " +
        "POST, PATCH, PUT and DELETE change the real account: confirm them with the user first.",
      inputSchema: z
        .object({
          method: methodSchema,
          path: z.string().describe("Plain path as listed in the catalog, e.g. /accounts/{accountUuid}/documents/v2/invoices. No query string."),
          query: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
            .optional()
            .describe("Query parameters, e.g. {\"page\": 2, \"limit\": 100}; a list is sent as name[]=a&name[]=b"),
          body: z
            .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
            .optional()
            .describe("JSON request body as an object or list"),
        })
        .strict(),
      annotations: {
        readOnlyHint: !changes,
        destructiveHint: client.mode === "full",
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ method, path, query, body }) => {
      try {
        const result = await client.request(method, path, { query, body });
        // A change can affect addresses, so the next search loads them fresh.
        if (method !== "GET") addresses.clear();
        return reply(result);
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
        "Search companies and persons by name, customer number, e-mail, phone, street, city, tag or contact person. Accents and umlauts do not matter (Zurich, Zürich and Zuerich all match). The API has no search, so all addresses are loaded (kept for 60 seconds, refreshed after changes made through this server) and filtered locally. All words must match; an exact customer number comes first. Without a query it lists everything page by page.",
      inputSchema: z
        .object({
          query: z.string().optional().describe("Search words, e.g. 'muster zürich' or '044 123 45 67'"),
          kind: z.enum(["company", "person", "all"]).default("all"),
          tag: z.string().optional().describe("Only addresses with this tag"),
          include_archived: z.boolean().default(false),
          limit: limitSchema(100, 25),
          offset: offsetSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ query, kind, tag, include_archived, limit, offset }) => {
      try {
        const terms = queryTerms(query ?? "");
        const { rows, complete } = await addresses.get();
        const hits = rows.filter(({ row, kind: rowKind }) => {
          if (kind !== "all" && rowKind !== kind) return false;
          if (!include_archived && row.isArchived) return false;
          if (tag && !(row.tags ?? []).some((t: string) => fold(t) === fold(tag))) return false;
          return matches(terms, addressText(row));
        });
        const exact = (row: Row) => (terms.some((spellings) => spellings.includes(fold(String(row.customer_number ?? "")))) ? 0 : 1);
        hits.sort((a, b) => exact(a.row) - exact(b.row));
        const result = paged(hits, offset, limit);
        return reply({
          ...(complete ? {} : { incomplete: INCOMPLETE }),
          ...result,
          items: result.items.map(({ row, kind: rowKind }) => addressView(row, rowKind)),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "abaninja_find_documents",
    {
      title: "Find AbaNinja documents",
      description:
        "Find invoices, quotes, credit notes and other documents by number, title, reference or customer name, optionally only for one customer or one status. The API cannot search, so all documents of the type are loaded and filtered locally. Returns a short summary per document; abaninja_request GET /accounts/{accountUuid}/documents/v2/{type}/{uuid} gives all details.",
      inputSchema: z
        .object({
          type: z.enum(DOCUMENT_TYPES),
          query: z.string().optional().describe("Words that must all match, e.g. a document number or a customer name"),
          customer_uuid: z.string().optional().describe("Company or person uuid from abaninja_search_addresses"),
          status: z.string().optional().describe("e.g. draft, sent, due, reminder, paid"),
          limit: limitSchema(100, 25),
          offset: offsetSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ type, query, customer_uuid, status, limit, offset }) => {
      try {
        const terms = queryTerms(query ?? "");
        const { rows, complete } = await loadDocuments(type);
        const hits = rows.filter((doc) => {
          if (customer_uuid && !isCustomer(doc, customer_uuid)) return false;
          if (status && String(doc.status).toLowerCase() !== status.toLowerCase()) return false;
          const numbers = Object.keys(doc).filter((k) => /Number$/.test(k)).map((k) => doc[k]);
          return matches(terms, indexText([...numbers, doc.title, doc.reference, doc.receiver?.name, doc.status]));
        });
        const result = paged(hits, offset, limit);
        return reply({ ...(complete ? {} : { incomplete: INCOMPLETE }), ...result, items: result.items.map(documentView) });
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
        "Open invoices (openAmount > 0, not cancelled, no templates; drafts only with include_drafts) with amount, due date and dunning level, sorted by due date. Totals are given per currency (CHF and EUR are never added up). Open credit notes are not deducted; find them with abaninja_find_documents type credit-notes. Optionally only for one customer: pass the company or person uuid from abaninja_search_addresses.",
      inputSchema: z
        .object({
          customer_uuid: z.string().optional().describe("Company or person uuid from abaninja_search_addresses"),
          overdue_only: z.boolean().default(false),
          include_drafts: z.boolean().default(false).describe("Drafts have an open amount but are not yet claims"),
          limit: limitSchema(200, 50),
          offset: offsetSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ customer_uuid, overdue_only, include_drafts, limit, offset }) => {
      try {
        const { rows, complete } = await loadDocuments("invoices");
        const today = swissToday();
        const isOverdue = (i: Row) => !!i.dueDate && String(i.dueDate).slice(0, 10) < today;
        const open = rows
          .filter((i) => Number(i.openAmount) > 0 && !i.isCancelled && !i.isTemplate)
          .filter((i) => include_drafts || i.status !== "draft")
          .filter((i) => !customer_uuid || isCustomer(i, customer_uuid))
          .filter((i) => !overdue_only || isOverdue(i))
          // Undated invoices go last.
          .sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")));
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
          ...(complete ? {} : { incomplete: INCOMPLETE }),
          total: result.total,
          totalOpenAmountByCurrency: totals,
          offset: result.offset,
          count: result.count,
          nextOffset: result.nextOffset,
          items: result.items.map((i) => ({
            ...documentView(i),
            overdue: i.dueDate ? isOverdue(i) : undefined,
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
