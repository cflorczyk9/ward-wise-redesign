#!/usr/bin/env node
// Local dev wrapper for netlify/functions/mcp.mjs. Netlify Functions v2 handlers take a
// Web-standard Request and return a Web-standard Response, so this just adapts Node's
// http.createServer to that shape, without needing the Netlify CLI. Used to smoke-test with
// @modelcontextprotocol/inspector and curl before anything is deployed.
//
// Usage: node tools/mcp-dev.mjs [port]   (default port 8797)

import http from "node:http";
import handler from "../netlify/functions/mcp.mjs";

const PORT = Number(process.argv[2] || process.env.PORT) || 8797;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) body = Buffer.concat(chunks);
    }

    const request = new Request(url, { method: req.method, headers, body });
    const response = await handler(request, {});

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.end(String((error && error.stack) || error));
  }
});

server.listen(PORT, () => {
  console.log(`Ward Wise MCP dev server listening on http://localhost:${PORT}/mcp`);
});
