// AbaNinja REST API client: configuration, path, account and mode checks, and requests.

export const API_BASE = "https://api.abaninja.ch";

export type Mode = "read" | "write" | "full";

export interface Config {
  token: string;
  accountUuid?: string;
  mode: Mode;
}

export type Query = Record<string, string | number | boolean | (string | number)[]>;
type RequestOptions = { query?: Query; body?: Record<string, unknown> | unknown[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ABANINJA_API_TOKEN?.trim();
  if (!token) throw new Error("ABANINJA_API_TOKEN is not set.");
  // A line break or control character would end up in error messages together with the token.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("ABANINJA_API_TOKEN contains spaces, line breaks or other invalid characters.");
  }
  // The Claude Desktop extension sets two switches instead of ABANINJA_MODE.
  const switches = env.ABANINJA_ALLOW_ALL === "true" ? "full" : env.ABANINJA_ALLOW_WRITE === "true" ? "write" : "read";
  const mode = env.ABANINJA_MODE?.trim() || switches;
  if (mode !== "read" && mode !== "write" && mode !== "full") {
    throw new Error(`ABANINJA_MODE must be read, write or full, got "${mode}".`);
  }
  const accountUuid = env.ABANINJA_ACCOUNT_UUID?.trim() || undefined;
  if (accountUuid && !UUID.test(accountUuid)) {
    throw new Error("ABANINJA_ACCOUNT_UUID must be a uuid like 00000000-0000-4000-8000-000000000000.");
  }
  return { token, accountUuid, mode };
}

// Only plain API paths: segments of letters, digits, "-", "_" and placeholders like {accountUuid}.
// No query string, fragment, dots, percent escapes, whitespace or empty segments, so the path that
// is checked below is exactly the path that is sent, and the request cannot leave api.abaninja.ch.
export const PATH_PATTERN = /^(\/[A-Za-z0-9{}_-]+)+$/;

// Calls that "write" mode refuses and "full" mode allows, with the reason the assistant is told.
const BLOCKED_PATHS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\/actions\/(email|plannedMail|sendAbaNet|sendPaymentConfirmation)$/i, reason: "sends a document" },
  { pattern: /\/actions\/(delete|cancel|cancelPermanently)$/i, reason: "deletes or cancels a document" },
  { pattern: /\/actions\/(dunningSent|dunningPrint|dunningDate|setDunningAmounts)$/i, reason: "dunns or schedules dunning" },
  { pattern: /\/bulk-actions(\/|$)/i, reason: "is a bulk action" },
  { pattern: /\/settings\/dunnings(\/|$)/i, reason: "changes the dunning setup or its e-mail texts" },
  { pattern: /\/webhooks\/v2\/outgoing-webhooks(\/|$)/i, reason: "changes outgoing webhooks" },
  { pattern: /\/finances\/v2\/bank-accounts(\/|$)/i, reason: "changes bank details" },
];

// Fields that "write" mode refuses when they are set, wherever they appear in the body or query.
const BLOCKED_FIELDS: Record<string, string> = {
  sendPaymentConfirmation: "e-mails a payment confirmation to the customer",
  automatic_dunning: "switches on automatic dunning",
  documentUrl: "makes AbaNinja download a file from another address",
  iban: "sets the bank account customers pay to",
  qrIban: "sets the bank account customers pay to",
};

const PAYMENTS = /\/finances\/v2\/payments(\/[^/]+)?$/i;

// The name PHP gives a parameter: it stops at a NUL byte, drops leading spaces, turns " " and "." into "_"
// and starts array syntax at "[". So "_method\0x", " .method" and "_method[]" all arrive as "_method".
function phpKey(key: string): string {
  return key.split("\0")[0].replace(/^\s+/, "").replace(/[ .]/g, "_").split("[")[0];
}

// A value counts as set unless it is missing or clearly false.
const isSet = (value: unknown) => value != null && ![false, 0, "0", "false", ""].includes(value as never);

// The first blocked field that is set, looking through nested objects and lists.
function blockedField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const field = Object.keys(BLOCKED_FIELDS).find((name) => name.toLowerCase() === key.toLowerCase());
    if (field && isSet(item)) return `${field} ${BLOCKED_FIELDS[field]}`;
    const found = blockedField(item);
    if (found) return found;
  }
}

// Returns why a call is not allowed in the given mode, or null when it is allowed.
export function checkAllowed(mode: Mode, method: string, path: string, body?: unknown, query: Query = {}): string | null {
  if (mode === "full") return null;
  const verb = method.toUpperCase();
  const keys = Object.keys(query);
  if (keys.some((key) => /[\x00-\x1f\x7f]/.test(key))) {
    return "Query parameter names must not contain control characters.";
  }
  // The backend honours a method override ("_method=DELETE" on a POST), which would turn an allowed
  // POST into a blocked DELETE.
  if ([...keys, ...Object.keys(body ?? {})].some((key) => /^_*method$/i.test(phpKey(key)))) {
    return "A _method parameter would change the HTTP method. It is only allowed in full mode.";
  }
  if (verb === "GET") return null;
  if (mode === "read") return `${verb} is not allowed in read mode. The user can allow changes with ABANINJA_MODE or the Claude Desktop extension settings.`;
  if (!["POST", "PATCH", "PUT"].includes(verb)) return `${verb} is only allowed in full mode.`;
  const blockedPath = BLOCKED_PATHS.find((rule) => rule.pattern.test(path));
  if (blockedPath) return `This call ${blockedPath.reason}. It is only allowed in full mode.`;
  // Data of a changing call belongs in the body; the backend would also read nested query names.
  if (keys.some((key) => !/^[A-Za-z0-9_-]+$/.test(key))) {
    return "Query parameter names of changing calls must be plain names. Put data into the body.";
  }
  const field = blockedField(body) ?? blockedField(query);
  if (field) return `${field}. It is only allowed in full mode.`;
  if (PAYMENTS.test(path) && keys.some((key) => key.toLowerCase().startsWith("processing"))) {
    return "Payment processing data belongs in the body.";
  }
  return null;
}

// Error text for the assistant: JSON errors in full (validation and duplicate details matter),
// HTML error pages reduced to their text, everything bounded.
async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(text)).slice(0, 4000);
    } catch {
      // fall through to plain text
    }
  }
  if (/html/i.test(contentType) || /^\s*</.test(text)) {
    return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return text.slice(0, 1000);
}

export class AbaNinjaClient {
  private account?: Promise<string>;

  constructor(private readonly config: Config) {}

  get mode(): Mode {
    return this.config.mode;
  }

  // The configured account, or the only account the token can access. Looked up once and shared.
  getAccountUuid(): Promise<string> {
    if (this.config.accountUuid) return Promise.resolve(this.config.accountUuid);
    this.account ??= this.findAccount().catch((error) => {
      this.account = undefined;
      throw error;
    });
    return this.account;
  }

  private async findAccount(): Promise<string> {
    let result: { data?: { uuid: string; name?: string }[] };
    try {
      result = (await this.send("GET", "/users/v2/me/accounts")) as typeof result;
    } catch (error) {
      throw new Error(
        `Could not list the token's accounts (${(error as Error).message.slice(0, 80)}). Set ABANINJA_ACCOUNT_UUID (Claude Desktop: Konto-UUID), or give the token the "profile" scope.`,
      );
    }
    const accounts = result.data ?? [];
    if (accounts.length !== 1) {
      const list = accounts.map((a) => `${a.name ?? "?"} (${a.uuid})`).join(", ") || "none";
      throw new Error(`The token can access ${accounts.length} accounts: ${list}. Set ABANINJA_ACCOUNT_UUID (Claude Desktop: Konto-UUID) to one of them.`);
    }
    return accounts[0].uuid;
  }

  // Calls an endpoint within the configured mode and account. "{accountUuid}" is filled in automatically.
  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!PATH_PATTERN.test(path)) {
      throw new Error("path must be a plain API path like /accounts/{accountUuid}/documents/v2/invoices. Put query parameters into query.");
    }
    if (options.body !== undefined && method.toUpperCase() === "GET") throw new Error("GET takes no body. Put parameters into query.");
    const blocked = checkAllowed(this.config.mode, method, path, options.body, options.query);
    if (blocked) throw new Error(blocked);
    const accountsInPath = [...path.matchAll(/\/accounts\/([0-9a-f]{8}-[0-9a-f-]{27})/gi)].map((match) => match[1].toLowerCase());
    if (path.includes("{accountUuid}") || accountsInPath.length) {
      const account = await this.getAccountUuid();
      // The server works for one account only, even if the token can reach more.
      if (accountsInPath.some((uuid) => uuid !== account.toLowerCase())) {
        throw new Error(`This server is set up for account ${account}. Other accounts are not allowed.`);
      }
      path = path.replaceAll("{accountUuid}", account);
    }
    const placeholder = path.match(/\{[^}]*\}/)?.[0];
    if (placeholder) {
      throw new Error(`Fill in ${placeholder} with a real value. abaninja_describe_endpoint lists what each placeholder means.`);
    }
    return this.send(method, path, options);
  }

  private async send(method: string, path: string, { query = {}, body }: RequestOptions = {}): Promise<unknown> {
    const url = new URL(path, API_BASE);
    if (url.origin !== API_BASE) throw new Error("Requests may only go to api.abaninja.ch.");
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        // The backend reads repeated values as a list only with "[]" after the name.
        for (const item of value) url.searchParams.append(key.endsWith("[]") ? key : `${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const verb = method.toUpperCase();
    const hasBody = body !== undefined;
    const init: RequestInit = {
      method: verb,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    };

    let response: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await fetch(url, init);
      } catch (error) {
        const code = (error as { cause?: { code?: string } }).cause?.code;
        throw new Error(`Could not reach api.abaninja.ch${code ? ` (${code})` : ""}. Check the network or proxy settings.`);
      }
      // Rate limits are retried for every call, server errors only for GET, since a write must not run twice.
      const retry = response.status === 429 || (verb === "GET" && [502, 503, 504].includes(response.status));
      if (!retry || attempt === 3) break;
      const seconds = Math.min(Number(response.headers.get("retry-after")) || attempt * 2, 10);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    if (!response.ok) {
      throw new Error(`AbaNinja API ${response.status}: ${await errorText(response)}`);
    }
    // Files (PDF, images, ZIP) are described, not decoded into unreadable text.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/json|^text\/|xml/i.test(contentType)) {
      const bytes = (await response.arrayBuffer()).byteLength;
      return { contentType, bytes, note: "Binary content is not shown." };
    }
    const text = await response.text();
    if (!text) return { ok: true, status: response.status };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
