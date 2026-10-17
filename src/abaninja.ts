// AbaNinja REST API client: configuration, account lookup, mode checks and requests.

export const API_BASE = "https://api.abaninja.ch";

export type Mode = "read" | "write" | "full";

export interface Config {
  token: string;
  accountUuid?: string;
  mode: Mode;
}

export type Query = Record<string, string | number | boolean>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ABANINJA_API_TOKEN?.trim();
  if (!token) {
    throw new Error("ABANINJA_API_TOKEN is not set.");
  }
  const mode = env.ABANINJA_MODE?.trim() || "read";
  if (mode !== "read" && mode !== "write" && mode !== "full") {
    throw new Error(`ABANINJA_MODE must be read, write or full, got "${mode}".`);
  }
  return { token, accountUuid: env.ABANINJA_ACCOUNT_UUID?.trim() || undefined, mode };
}

// Actions that send, delete, cancel or dun documents, plus all bulk actions.
// They stay blocked in "write" mode and are only allowed in "full" mode.
const BLOCKED_IN_WRITE: RegExp[] = [
  /\/actions\/(email|plannedMail|sendAbaNet|sendPaymentConfirmation|delete|cancel|cancelPermanently|dunningSent|dunningPrint|setDunningAmounts)$/i,
  /\/bulk-actions(\/|$)/i,
];

// Returns why a call is not allowed in the given mode, or null when it is allowed.
export function checkAllowed(mode: Mode, method: string, path: string): string | null {
  const verb = method.toUpperCase();
  if (mode === "full") return null;
  if (mode === "read") {
    return verb === "GET" ? null : `${verb} is not allowed in read mode. Set ABANINJA_MODE=write to allow changes.`;
  }
  if (!["GET", "POST", "PATCH", "PUT"].includes(verb)) {
    return `${verb} is only allowed in full mode.`;
  }
  if (BLOCKED_IN_WRITE.some((pattern) => pattern.test(path))) {
    return "This action sends, deletes, cancels or dunns documents and is only allowed in full mode.";
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
    const blocked = checkAllowed(this.config.mode, method, path);
    if (blocked) throw new Error(blocked);
    const resolved = path.includes("{accountUuid}")
      ? path.replace("{accountUuid}", await this.getAccountUuid())
      : path;
    return this.send(method, resolved, options);
  }

  private async send(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<unknown> {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
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
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AbaNinja API ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
