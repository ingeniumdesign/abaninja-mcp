import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AbaNinjaClient } from "./abaninja.js";

// Registers the MCP tools. Planned for v1:
// - abaninja_list_endpoints     find endpoints by area or keyword (from catalog/)
// - abaninja_describe_endpoint  parameters and fields of one endpoint
// - abaninja_request            call any endpoint within the configured mode
// - abaninja_search_addresses   search companies and persons (the API has no search)
// - abaninja_open_invoices      open invoices, optionally per customer (the API has no customer filter)
export function registerTools(server: McpServer, client: AbaNinjaClient): void {
  // TODO: implement the tools listed above.
}
