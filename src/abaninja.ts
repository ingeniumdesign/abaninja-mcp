// AbaNinja REST API client: configuration, account lookup, mode checks and requests.

export const API_BASE = "https://api.abaninja.ch";

export type Mode = "read" | "write" | "full";

export interface Config {
  token: string;
  accountUuid?: string;
  mode: Mode;
}

export type QueryValue = string | number | boolean | (string | number)[];
export type Query = Record<string, QueryValue>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ABANINJA_API_TOKEN?.trim();
  if (!token) {
    throw new Error("ABANINJA_API_TOKEN is not set.");
  }
  // A line break or control character would end up in error messages together with the token.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("ABANINJA_API_TOKEN contains spaces, line breaks or other invalid characters.");
  }
  const mode = env.ABANINJA_MODE?.trim() || "read";
  if (mode !== "read" && mode !== "write" && mode !== "full") {
    throw new Error(`ABANINJA_MODE must be read, write or full, got "${mode}".`);
  }
  return { token, accountUuid: env.ABANINJA_ACCOUNT_UUID?.trim() || undefined, mode };
}

// Only plain API paths: segments of letters, digits, "-", "_" and placeholders like {accountUuid}.
// No query string, fragment, dots, percent escapes, whitespace or empty segments, so the path that
// is checked below is exactly the path that is sent, and the request cannot leave api.abaninja.ch.
const PATH_PATTERN = /^(\/[A-Za-z0-9{}_-]+)+$/;

// Calls that send, delete, cancel or dun documents, bulk actions and outgoing webhooks.
// They stay blocked in "write" mode and are only allowed in "full" mode.
const BLOCKED_IN_WRITE: RegExp[] = [
  /\/actions\/(email|plannedMail|sendAbaNet|sendPaymentConfirmation|delete|cancel|cancelPermanently|dunningSent|dunningPrint|setDunningAmounts)$/i,
  /\/bulk-actions(\/|$)/i,
  /\/webhooks\/v2\/outgoing-webhooks(\/|$)/i,
];
const PAYMENTS = /\/finances\/v2\/payments(\/[^/]+)?$/i;

// The backend honours a method override ("_method=DELETE" on a POST, also written ".method" or " _method",
// which PHP turns into "_method"). Such keys would turn an allowed POST into a blocked DELETE.
const METHOD_OVERRIDE = /^[\s._]*method$/i;

function hasMethodOverride(query?: Query, body?: unknown): boolean {
  const keys = [
    ...Object.keys(query ?? {}),
    ...(body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : []),
  ];
  return keys.some((key) => METHOD_OVERRIDE.test(key));
}

// Returns why a call is not allowed in the given mode, or null when it is allowed.
export function checkAllowed(mode: Mode, method: string, path: string, body?: unknown, query?: Query): string | null {
  const verb = method.toUpperCase();
  if (mode === "full") return null;
  if (hasMethodOverride(query, body)) {
    return "A _method parameter would change the HTTP method. It is only allowed in full mode.";
  }
  if (verb === "GET") return null;
  if (mode === "read") {
    return `${verb} is not allowed in read mode. Set ABANINJA_MODE=write to allow changes.`;
  }
  if (!["POST", "PATCH", "PUT"].includes(verb)) {
    return `${verb} is only allowed in full mode.`;
  }
  if (BLOCKED_IN_WRITE.some((pattern) => pattern.test(path))) {
    return "This call sends, deletes, cancels or dunns documents, runs a bulk action or changes outgoing webhooks. It is only allowed in full mode.";
  }
  const processing = (body as { processing?: { sendPaymentConfirmation?: unknown } } | undefined)?.processing;
  if (PAYMENTS.test(path) && processing?.sendPaymentConfirmation === true) {
    return "sendPaymentConfirmation e-mails the customer and is only allowed in full mode.";
  }
  return null;
}

export class AbaNinjaClient {
  private accountUuid?: string;

  constructor(private readonly config: Config) {
    this.accountUuid = config.accountUuid;
  }

  get mode(): Mode {
    return this.config.mode;
  }

  // Uses the configured account, or the only account the token can access.
  async getAccountUuid(): Promise<string> {
    if (this.accountUuid) return this.accountUuid;
    const result = (await this.send("GET", "/users/v2/me/accounts")) as { data?: { uuid: string }[] };
    const accounts = result.data ?? [];
    if (accounts.length !== 1) {
      throw new Error(`The token can access ${accounts.length} accounts. Set ABANINJA_ACCOUNT_UUID to choose one.`);
    }
    this.accountUuid = accounts[0].uuid;
    return this.accountUuid;
  }

  // Calls an endpoint within the configured mode. "{accountUuid}" in the path is filled in automatically.
  async request(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<unknown> {
    if (!PATH_PATTERN.test(path)) {
      throw new Error("path must be a plain API path like /accounts/{accountUuid}/documents/v2/invoices. Put query parameters into query.");
    }
    const blocked = checkAllowed(this.config.mode, method, path, options.body, options.query);
    if (blocked) throw new Error(blocked);
    const resolved = path.includes("{accountUuid}")
      ? path.replaceAll("{accountUuid}", await this.getAccountUuid())
      : path;
    return this.send(method, resolved, options);
  }

  private async send(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<unknown> {
    const url = new URL(path, API_BASE);
    if (url.origin !== API_BASE) {
      throw new Error("Requests may only go to api.abaninja.ch.");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(item));
      }
    }
    const hasBody = options.body !== undefined;
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AbaNinja API ${response.status}: ${text.slice(0, 500)}`);
    }
    // Files (PDF, images, ZIP) are described, not decoded into unreadable text.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/json|^text\/|xml/i.test(contentType)) {
      const bytes = (await response.arrayBuffer()).byteLength;
      return { contentType, bytes, note: "Binary content is not shown." };
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
