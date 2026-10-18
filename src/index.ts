#!/usr/bin/env node
// Entry point: reads the configuration, registers the tools and serves MCP over stdio.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AbaNinjaClient, loadConfig } from "./abaninja.js";
import { registerTools } from "./tools.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`abaninja-mcp: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const client = new AbaNinjaClient(config);
const server = new McpServer({ name: "abaninja-mcp", version });

registerTools(server, client);

await server.connect(new StdioServerTransport());
console.error(`abaninja-mcp ${version} running in ${config.mode} mode`);
