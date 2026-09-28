#!/usr/bin/env node
// Builds static/downloads/wardwise.mcpb, the Claude Desktop extension (MCPB, formerly .dxt)
// version of the Ward Wise MCP server.
//
// Run with: npm run build:mcpb
//
// Steps:
//   1. esbuild bundles mcpb/server/index.mjs, which imports buildServer() straight from
//      netlify/functions/lib/wardwise-mcp.mjs (the same tool code the hosted remote server
//      uses), into one self-contained file. That means the packed bundle needs no
//      node_modules directory at all.
//   2. mcpb/manifest.json and mcpb/icon.png are copied alongside it into a staging folder.
//   3. The MCPB CLI (`npx @anthropic-ai/mcpb pack`) zips the staging folder into the .mcpb.
//
// CLI reference: https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
// Manifest spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STAGE = path.join(HERE, ".build");
const OUT_FILE = path.join(ROOT, "static", "downloads", "wardwise.mcpb");

async function main() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(path.join(STAGE, "server"), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(HERE, "server", "index.mjs")],
    outfile: path.join(STAGE, "server", "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    // mcpb/server/index.mjs already starts with a shebang; esbuild preserves an entry
    // point's shebang automatically, so no banner is added here (a banner would duplicate it).
    logLevel: "info"
  });

  copyFileSync(path.join(HERE, "manifest.json"), path.join(STAGE, "manifest.json"));
  copyFileSync(path.join(HERE, "icon.png"), path.join(STAGE, "icon.png"));

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  if (existsSync(OUT_FILE)) rmSync(OUT_FILE);

  execFileSync("npx", ["-y", "@anthropic-ai/mcpb", "pack", STAGE, OUT_FILE], {
    stdio: "inherit",
    cwd: ROOT
  });

  const { size } = statSync(OUT_FILE);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${(size / 1024).toFixed(0)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
