#!/usr/bin/env node
// Entry point: reads the configuration, registers the tools and serves MCP over stdio.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AbaNinjaClient, loadConfig } from "./abaninja.js";
import { registerTools } from "./tools.js";

const config = loadConfig();
const client = new AbaNinjaClient(config);
const server = new McpServer({ name: "abaninja-mcp", version: "0.1.0" });

registerTools(server, client);

await server.connect(new StdioServerTransport());
console.error(`abaninja-mcp running in ${config.mode} mode`);
