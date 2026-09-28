#!/usr/bin/env node
// Ward Wise MCP Bundle (.mcpb) entry point.
//
// Same tool logic as the hosted remote server (netlify/functions/mcp.mjs), wired to stdio
// instead of Streamable HTTP so Claude Desktop can run it locally. This file imports
// buildServer() from netlify/functions/lib/wardwise-mcp.mjs directly rather than forking
// the tool definitions, so the two servers can never drift apart.
//
// mcpb/build.mjs bundles this file, that shared lib, and their SDK/zod dependencies into a
// single file with esbuild, so the packed .mcpb ships with no node_modules directory. See
// MCPB CLI docs: https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md and the
// manifest spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../../netlify/functions/lib/wardwise-mcp.mjs";

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ward Wise MCP server running on stdio.");
}

main().catch((error) => {
  console.error("Fatal error starting the Ward Wise MCP server:", error);
  process.exit(1);
});
