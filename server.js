#!/usr/bin/env node
// local-mcp-simple-server
//
// One MCP tool, one configured source root: `read_source_file` returns the
// full UTF-8 text of one file the caller names, or a clear tool error.
// See README.md for the full walkthrough of how a call reaches this file.

import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// A file larger than this is rejected outright, never truncated. 64 KiB
// comfortably fits a small source file while keeping what we hand back to
// an LLM bounded and predictable.
const MAX_FILE_BYTES = 64 * 1024;

// The chunk size used while streaming a file off disk. It only affects how
// quickly an oversized read is noticed (see readBoundedFile below); it is
// not the enforced limit itself.
const READ_CHUNK_BYTES = 16 * 1024;

/**
 * One error type for every way `read_source_file` can legitimately fail.
 * The tool handler catches this (and only this) to build a clear,
 * non-crashing tool error; anything else is treated as unexpected (see
 * toToolErrorResult).
 */
class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Reads and validates SIMPLE_MCP_SOURCE_ROOT. This runs once at startup,
 * not per tool call: the caller never supplies or changes the root, so a
 * bad configuration is a launch-time failure, not a tool error.
 */
function loadSourceRootFromEnv(env) {
  const configured = env.SIMPLE_MCP_SOURCE_ROOT;
  if (!configured || configured.trim() === "") {
    throw new Error(
      "SIMPLE_MCP_SOURCE_ROOT is not set. Point it at an absolute directory " +
        "path before starting the server.",
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(
      `SIMPLE_MCP_SOURCE_ROOT must be an absolute path, got: ${configured}`,
    );
  }
  return configured;
}

/**
 * Splits and validates a caller-supplied relative path without touching the
 * filesystem. Accepts "/" or "\" as a separator so the same server behaves
 * the same way on Windows and Linux. Rejects anything that is absolute, or
 * that contains a ".." segment anywhere, before it ever reaches path
 * resolution — traversal is refused by construction, not by cleanup.
 *
 * Returns the path re-joined with "/" (used both to resolve the file and to
 * report back a normalized, platform-independent relative path).
 */
function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ToolInputError("path must be a non-empty string");
  }
  if (rawPath.includes("\u0000")) {
    throw new ToolInputError("path must not contain NUL characters");
  }
  const looksAbsolute =
    path.isAbsolute(rawPath) ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(rawPath);
  if (looksAbsolute) {
    throw new ToolInputError(
      "path must be relative to the configured source root, not absolute",
    );
  }

  const segments = [];
  for (const segment of rawPath.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new ToolInputError(
        "path must not contain '..' segments (escaping the source root is not allowed)",
      );
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new ToolInputError("path must reference a file");
  }
  return segments.join("/");
}

/**
 * Resolves `normalizedPath` against `sourceRootReal` and confirms the real,
 * symlink-resolved result still lives inside the root.
 *
 * `fs.realpath` walks every symlink in the chain (including any junction on
 * Windows), so this is what actually catches a symlink/junction escape —
 * checking the literal joined path is not enough, since a symlink can point
 * anywhere regardless of where it sits textually. Note this is a plain
 * containment check, not an OS-level sandbox: it cannot stop the target
 * file from being replaced by something outside the root between this
 * check and the read that follows (see README's "what this is not" section).
 */
async function resolveRealPathWithinRoot(sourceRootReal, normalizedPath) {
  const candidatePath = path.resolve(sourceRootReal, normalizedPath);
  let realPath;
  try {
    realPath = await fs.realpath(candidatePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ToolInputError(`file not found: ${normalizedPath}`);
    }
    if (error.code === "ELOOP") {
      throw new ToolInputError(
        `path could not be resolved (symlink loop): ${normalizedPath}`,
      );
    }
    throw error;
  }

  const relativeFromRoot = path.relative(sourceRootReal, realPath);
  const escapesRoot =
    relativeFromRoot === "" ||
    relativeFromRoot.startsWith("..") ||
    path.isAbsolute(relativeFromRoot);
  if (escapesRoot) {
    throw new ToolInputError(
      `path escapes the configured source root: ${normalizedPath}`,
    );
  }
  return realPath;
}

async function assertRegularFile(realPath, normalizedPath) {
  const stats = await fs.stat(realPath);
  if (!stats.isFile()) {
    throw new ToolInputError(`not a regular file: ${normalizedPath}`);
  }
}

/**
 * Streams the file in fixed-size chunks and aborts as soon as the running
 * total crosses MAX_FILE_BYTES, instead of reading the whole file and
 * checking its length afterward. That distinction matters for a file that
 * grows after an initial stat, and for simply never holding an oversized
 * file fully in memory before rejecting it.
 */
async function readBoundedFile(realPath) {
  const stream = createReadStream(realPath, {
    highWaterMark: READ_CHUNK_BYTES,
  });
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_FILE_BYTES) {
        throw new ToolInputError(
          `file exceeds the ${MAX_FILE_BYTES}-byte limit and was rejected (not truncated)`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Text-file policy: reject a NUL byte outright (a strong, cheap signal of
 * binary content), then require the remaining bytes to decode as strict
 * UTF-8. `TextDecoder({ fatal: true })` throws on any malformed byte
 * sequence, which is what actually enforces "UTF-8 text file" here.
 *
 * Limitation: this cannot detect every binary format. A binary file whose
 * bytes happen to form valid UTF-8 (rare, but possible for small files)
 * will pass. It also cannot tell "valid UTF-8" apart from "meaningful
 * source code" — a UTF-8 text file full of nonsense still passes. Both are
 * accepted, deliberate trade-offs for a milestone that is about bounded,
 * safe delivery of text, not content analysis.
 */
function decodeUtf8Text(buffer, normalizedPath) {
  if (buffer.includes(0)) {
    throw new ToolInputError(
      `file does not look like UTF-8 text (contains a NUL byte): ${normalizedPath}`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ToolInputError(
      `file is not valid UTF-8 text: ${normalizedPath}`,
    );
  }
}

/**
 * The full pipeline for one read_source_file call, composed from the pure
 * validation step (normalizeRelativePath) and the imperative filesystem
 * steps that follow it. Throws ToolInputError for every expected failure
 * mode; anything else is a genuinely unexpected error and is left to
 * propagate to the caller in server.js.
 */
async function readSourceFile(sourceRootReal, rawPath) {
  const normalizedPath = normalizeRelativePath(rawPath);
  const realPath = await resolveRealPathWithinRoot(sourceRootReal, normalizedPath);
  await assertRegularFile(realPath, normalizedPath);
  const buffer = await readBoundedFile(realPath);
  const text = decodeUtf8Text(buffer, normalizedPath);
  return { path: normalizedPath, text };
}

/**
 * Converts any error raised while handling a tool call into a normal
 * (non-throwing) MCP tool result with isError: true. This is what keeps a
 * bad call from ever reaching the transport as an exception: the server
 * process, and the stdio connection to it, stay up no matter what one call
 * does.
 */
function toToolErrorResult(error) {
  if (error instanceof ToolInputError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  // Not one of our expected cases (e.g. a permission error from the OS).
  // Log the detail to stderr for whoever is running the server, but still
  // return a plain tool error rather than letting the exception surface.
  console.error("read_source_file: unexpected error:", error);
  const detail = error && error.message ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `unexpected error: ${detail}` }],
  };
}

/**
 * Wires the one tool this server exposes onto an McpServer instance.
 * Kept as its own function so server construction and tool behavior are
 * easy to read separately.
 */
function registerReadSourceFileTool(server, sourceRootReal) {
  server.registerTool(
    "read_source_file",
    {
      title: "Read source file",
      description:
        "Reads one UTF-8 text file from the server's configured source root " +
        "and returns its relative path and complete text. Files over 64 KiB " +
        "are rejected, not truncated. The caller cannot choose or change the " +
        "root; only a path relative to it.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Path to the file, relative to the configured source root, e.g. "CustomerService.vb".',
          ),
      },
      outputSchema: {
        path: z.string(),
        text: z.string(),
      },
    },
    async ({ path: rawPath }) => {
      try {
        const { path: normalizedPath, text } = await readSourceFile(
          sourceRootReal,
          rawPath,
        );
        return {
          structuredContent: { path: normalizedPath, text },
          content: [
            {
              type: "text",
              text: `Path: ${normalizedPath}\n\n${text}`,
            },
          ],
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );
}

/**
 * Composition root: read configuration, build the server, connect it to
 * stdio, and say so on stderr. Nothing above this function performs I/O
 * against stdin/stdout, so it is easy to see that stdout is reserved for
 * the MCP SDK's own protocol traffic.
 */
async function main() {
  const sourceRoot = loadSourceRootFromEnv(process.env);
  // Resolved once at startup so every tool call compares against the same
  // canonical (symlink-resolved) root.
  const sourceRootReal = await fs.realpath(sourceRoot);
  const rootStats = await fs.stat(sourceRootReal);
  if (!rootStats.isDirectory()) {
    throw new Error(
      `SIMPLE_MCP_SOURCE_ROOT does not point at a directory: ${sourceRoot}`,
    );
  }

  const server = new McpServer({
    name: "local-mcp-simple-server",
    version: "1.0.0",
  });
  registerReadSourceFileTool(server, sourceRootReal);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only: stdout carries nothing but MCP JSON-RPC frames.
  console.error(`local-mcp-simple-server ready. Source root: ${sourceRootReal}`);
}

main().catch((error) => {
  console.error("local-mcp-simple-server failed to start:", error);
  process.exitCode = 1;
});
