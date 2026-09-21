// Integration tests for local-mcp-simple-server.
//
// These spawn the real server.js over a real StdioClientTransport, exactly
// as an MCP-speaking client would, rather than calling internal functions
// directly. That is what actually proves discovery, tool invocation, and
// error handling work over the wire, not just in isolation.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const serverPath = path.resolve(repoRoot, "server.js");

const GOOD_TEXT = "Public Class Fixture\nEnd Class\n";
const TOO_BIG_BYTES = 64 * 1024 + 1;

let sourceRoot;
let outsideDir;
let client;
let transport;
let symlinkEscapeSupported = false;
let capturedStderr = "";

// One server + one client for the whole file: every test below is a
// read-only tool call, so there is no need to pay for a fresh process per
// assertion, and it doubles as the "stays usable after failures" check.
before(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "simple-mcp-root-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "simple-mcp-outside-"));

  await writeFile(path.join(sourceRoot, "Good.vb"), GOOD_TEXT, "utf8");
  await writeFile(
    path.join(sourceRoot, "TooBig.vb"),
    "a".repeat(TOO_BIG_BYTES),
    "utf8",
  );
  await writeFile(
    path.join(sourceRoot, "Binary.dat"),
    Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
  );
  await mkdir(path.join(sourceRoot, "ADirectory"));
  await writeFile(path.join(outsideDir, "secret.vb"), "outside text\n", "utf8");

  try {
    await symlink(
      path.join(outsideDir, "secret.vb"),
      path.join(sourceRoot, "Escape.vb"),
    );
    symlinkEscapeSupported = true;
  } catch {
    // Creating symlinks can require elevated privileges on some platforms
    // (notably Windows without developer mode). We skip the escape test
    // rather than fail the suite for an environment limitation.
    symlinkEscapeSupported = false;
  }

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { SIMPLE_MCP_SOURCE_ROOT: sourceRoot },
    stderr: "pipe",
  });
  // Attach before connecting so the startup banner (written to stderr
  // before the transport handshake completes) is not missed.
  transport.stderr?.on("data", (chunk) => {
    capturedStderr += chunk.toString();
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

test("discovery exposes exactly read_source_file", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "read_source_file");
});

test("reads the expected relative path and text", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "Good.vb" },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { path: "Good.vb", text: GOOD_TEXT });
  assert.match(result.content[0].text, /Good\.vb/);
});

test("rejects malformed arguments (missing path)", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: {},
  });
  assert.equal(result.isError, true);
});

test("rejects malformed arguments (wrong type)", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: 42 },
  });
  assert.equal(result.isError, true);
});

test("rejects a missing file", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "DoesNotExist.vb" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
});

test("rejects an absolute path", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: path.join(sourceRoot, "Good.vb") },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /absolute/i);
});

test("rejects a directory", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "ADirectory" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a regular file/i);
});

test("rejects path traversal", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "../secret.vb" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\.\.|escape/i);
});

test("rejects an oversized file without truncating it", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "TooBig.vb" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /64|limit/i);
  assert.equal(result.structuredContent, undefined);
});

test("rejects unsupported (binary) content", async () => {
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "Binary.dat" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /utf-8|nul/i);
});

test("rejects a symlink escaping the source root", async (t) => {
  if (!symlinkEscapeSupported) {
    t.skip("this environment would not let us create a symlink in the fixture root");
    return;
  }
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "Escape.vb" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /escape/i);
});

test("server remains usable after failed tool calls", async () => {
  await client.callTool({ name: "read_source_file", arguments: {} });
  await client.callTool({
    name: "read_source_file",
    arguments: { path: "DoesNotExist.vb" },
  });
  const result = await client.callTool({
    name: "read_source_file",
    arguments: { path: "Good.vb" },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { path: "Good.vb", text: GOOD_TEXT });
});

test("diagnostics on stderr do not corrupt protocol stdout", async () => {
  // Every call in this file has already round-tripped valid JSON-RPC over
  // stdout; if server.js had ever written a stray non-protocol line there,
  // StdioClientTransport's read buffer would have failed to parse it and
  // those calls would already be failing. This assertion additionally
  // confirms the server actually does write diagnostics to stderr (its
  // startup banner), so the separation is verified, not just assumed.
  assert.match(capturedStderr, /local-mcp-simple-server ready/);
});
