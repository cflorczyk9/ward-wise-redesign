// Ward Wise MCP server, mounted at /mcp. A remote, stateless Streamable HTTP endpoint so
// anyone can add https://wardwise-redesign.netlify.app/mcp as a custom connector in Claude
// or another MCP client. No auth, read-only.
//
// Stateless means: a fresh McpServer and a fresh transport are built on every request. The
// SDK does not allow reusing either across requests (see the lib file's header comment and
// scratchpad/ww-mcp/RESEARCH.md section 1 for the verified error messages that rule out reuse).
//
// GET and DELETE are answered with 405 before the transport is ever touched. A GET here would
// otherwise open an SSE stream that never closes, and this server never has anything to push
// through one (stateless, no server-initiated notifications), so it would just hold a Netlify
// function invocation open until the platform's timeout killed it.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./lib/wardwise-mcp.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, mcp-session-id",
  "Access-Control-Max-Age": "86400"
};

function methodNotAllowed() {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } }), {
    status: 405,
    headers: { "content-type": "application/json", ...CORS_HEADERS }
  });
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  await server.connect(transport);

  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
};

export const config = { path: "/mcp" };
