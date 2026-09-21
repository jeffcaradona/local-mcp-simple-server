# local-mcp-simple-server

A deliberately small MCP server that isolates one complete interaction:

```
one selected file → one MCP tool call → bounded source text → Copilot explains it
```

It exposes exactly one tool, `read_source_file`. There is no inventory, no
search, no Git integration, no model client, and no second tool. This is
the MCP counterpart to `local-llm-simple-harness`: it exists so the
mechanics of *one* MCP round trip are easy to see end-to-end, before
looking at a larger system (`modernization-evidence-harness`) that builds
inventory, search, excerpts, provenance, and artifact-reference validation
on top of the same basic shape.

This is an independent learning project. It does not import, depend on, or
require either the simple LLM harness or the evidence harness.

## What this is not

- **Not a sandbox.** The containment checks in `server.js` (resolving
  `..`-free relative paths, then following symlinks with `fs.realpath` to
  confirm the real file is still under the configured root) are ordinary
  application-level checks, not an OS-level security boundary. They stop a
  well-formed MCP client from reading outside the configured root; they do
  not defend against a hostile process racing the filesystem underneath
  this one (a file swapped out between the containment check and the read
  that follows). Run this server with the same trust you'd give any local
  process that reads files on your behalf.
- **Not a text-content guarantee.** "UTF-8 text file" is enforced by two
  cheap, honest checks: reject any file containing a NUL byte, then require
  the remaining bytes to decode as strict UTF-8 (`TextDecoder` with
  `fatal: true`). This reliably rejects binary formats (images, archives,
  compiled binaries) but cannot prove a file is *meaningful* source code —
  a valid UTF-8 file full of nonsense still passes, and in principle a
  binary format could (rarely) decode as valid UTF-8 too. Good enough to
  keep this tool from handing binary garbage to an LLM; not a general
  file-type classifier.
- **Not versioned or attributed.** The tool reads whatever is on disk right
  now. There is no Git subprocess, no commit pinning, no hash, and no
  provenance record — if you need "prove this exact text existed at this
  exact revision," that's what the larger evidence harness is for.

## Requirements

- Node.js 18 or newer, native ESM.
- npm (a lockfile is committed; use `npm ci` for a reproducible install).

## Setup

```powershell
cd local-mcp-simple-server
npm ci
```

Configure the one thing this server needs — an absolute path to the
directory it's allowed to read from — via `SIMPLE_MCP_SOURCE_ROOT`. The
tool caller (Copilot) never sees or changes this value; it is fixed for
the life of the server process.

Run it directly to confirm it starts (single-line PowerShell, no
heredocs):

```powershell
$env:SIMPLE_MCP_SOURCE_ROOT = "C:\path\to\local-mcp-simple-server\examples\source"; node server.js
```

### Why this appears to hang

`server.js` prints a one-line "ready" banner to **stderr** and then waits.
That's correct, not broken: a stdio MCP server has no interactive prompt —
it is a subprocess meant to be launched and driven by an MCP client (VS
Code / Copilot, or the test client in this repo) that writes JSON-RPC
requests to its stdin and reads responses from its stdout. Run standalone
in a terminal, it will sit there silently (aside from that one stderr
line) until something speaks the protocol to it, or until you close its
stdin (Ctrl+C, or closing the terminal) to stop it.

## VS Code / Copilot setup (Windows)

1. Copy `examples/vscode.mcp.json` into your workspace's `.vscode/mcp.json`
   (single-line PowerShell):

   ```powershell
   Copy-Item "examples\vscode.mcp.json" ".vscode\mcp.json" -Force
   ```

2. Edit the copied file so `SIMPLE_MCP_SOURCE_ROOT` points at an absolute
   path on your machine (the checked-in example uses
   `${workspaceFolder}/examples/source`, which VS Code expands for you, so
   this step may already be correct if you keep the same layout).

3. Open the Command Palette and run **MCP: List Servers**, confirm
   `local-mcp-simple-server` is listed, and start it from there if it
   isn't already running.

4. Open Copilot Chat in **Agent** mode. Ask it to use the
   `read_source_file` tool (name it explicitly) to read
   `examples/source/CustomerService.vb` and explain its validation
   behavior.

5. **Check the tool-call record before trusting the answer.** Copilot's
   chat UI shows which tool actually ran for a turn. Confirm it says
   `read_source_file` from `local-mcp-simple-server` — not a built-in
   workspace file read. A built-in read can produce a similar-looking
   explanation without ever going through this server, which would
   silently defeat the point of the smoke test.

This manual smoke test has not been run against live VS Code/Copilot from
this environment (no VS Code instance available here). Treat it as
untested until you've actually walked through it once yourself; do not
take this README's word for a live pass.

## What the SDK handles vs. what this code handles

| Concern | Handled by |
|---|---|
| JSON-RPC framing, request/response correlation | `@modelcontextprotocol/sdk` (`StdioServerTransport`, `McpServer`) |
| Tool discovery (`tools/list`) | SDK, from the config passed to `registerTool` |
| Argument shape validation (missing/wrong-typed `path`) | SDK, via the Zod `inputSchema` |
| Output shape validation | SDK, via the Zod `outputSchema` |
| Path safety, root containment, symlink-escape checks | This code (`server.js`) |
| File-size enforcement, streaming read | This code |
| UTF-8 text policy | This code |
| Turning a failure into a non-crashing tool result | This code (`toToolErrorResult`), never the SDK |

We never hand-write JSON-RPC or MCP framing — the SDK owns the wire
format entirely. Our job is exactly the part inside the tool callback:
turn one validated path into either a result or a clear, catchable error.

## Why no model client lives in this server

Copilot supplies its own reasoning; this server supplies bytes. VS Code's
Copilot already has a configured chat model and calls this MCP server as a
*tool* mid-conversation — the server's job ends the moment it returns text.
There is deliberately no API key, no model SDK, and no prompt construction
here: adding one would blur exactly the boundary this milestone exists to
make visible (server = context, Copilot = reasoning).

## Where the text you return actually goes

Whatever `read_source_file` returns is inserted into Copilot's ongoing
chat context and sent to whatever model backs your Copilot subscription
and its currently configured processing environment/region — the same as
if you'd pasted the file into the chat yourself. Only put synthetic,
non-sensitive files under a directory you point `SIMPLE_MCP_SOURCE_ROOT`
at for real use; the fixtures in this repo (`examples/source/`) are
intentionally synthetic for exactly this reason.

## How this maps onto the larger evidence harness

`modernization-evidence-harness` performs the same *kind* of step — hand a
bounded slice of source to an LLM — but wraps it with repository inventory
(which files exist), search (which file is relevant), excerpting (which
lines matter), and provenance (proving what revision the text came from).
This server is that one step by itself: given a path someone already
picked, read it safely and hand back the whole thing. If you can explain
how a call reaches `server.js`'s tool callback and how its result gets
back to Copilot, you've understood the piece the bigger harness builds on.

## Function-by-function walkthrough of one call

Given a request to read `CustomerService.vb`:

1. **VS Code / Copilot** sends a `tools/call` JSON-RPC request over the
   server's stdin. The MCP SDK's `StdioServerTransport` reads and parses
   it; this code never touches raw stdin.
2. **`McpServer`** (SDK) looks up the registered `read_source_file` tool,
   validates `{ path: "CustomerService.vb" }` against the Zod
   `inputSchema`, and — only if that passes — invokes the callback
   registered in `registerReadSourceFileTool`.
3. **`readSourceFile(sourceRootReal, rawPath)`** is the composition of the
   actual policy, in order:
   - `normalizeRelativePath(rawPath)` — pure, no filesystem access. Splits
     on `/` or `\`, rejects an absolute-looking path, and rejects any `..`
     segment. Returns a normalized, forward-slash relative path.
   - `resolveRealPathWithinRoot(sourceRootReal, normalizedPath)` — joins
     the path onto the root, calls `fs.realpath` (which follows every
     symlink/junction in the chain), and confirms the real result is still
     inside the real root via `path.relative`.
   - `assertRegularFile(realPath, normalizedPath)` — `fs.stat` and rejects
     anything that isn't a plain file (a directory, in particular).
   - `readBoundedFile(realPath)` — streams the file in 16 KiB chunks,
     throwing the moment the running total passes 64 KiB, so an oversized
     file is never fully buffered before being rejected.
   - `decodeUtf8Text(buffer, normalizedPath)` — rejects a NUL byte, then
     strictly decodes the rest as UTF-8.
4. **On success**, the callback returns an ordinary object —
   `{ structuredContent: { path, text }, content: [{ type: "text", ... }] }`
   — straight back to `McpServer`, which validates it against the
   `outputSchema` and serializes it as the `tools/call` response.
5. **On any failure** at any step above, the callback's `catch` calls
   `toToolErrorResult(error)`, which returns `{ isError: true, content: [...] }`
   instead of throwing. This is what satisfies "return understandable tool
   errors without terminating the server": the exception never reaches the
   SDK or the transport, so the process and the stdio connection to it
   both stay alive for the next call.
6. **`StdioServerTransport`** (SDK) serializes that result and writes it to
   stdout; Copilot reads it back as the tool's output and continues the
   conversation with it in context.

## Testing

```powershell
npm test
```

Uses Node's built-in test runner (`node --test`) against
`test/server.test.js`. That file starts one real server subprocess via the
SDK's `StdioClientTransport`/`Client` — exactly the way a real MCP client
would — and reuses it across the whole suite (bounded by
`--test-timeout=15000`; the client and its fixtures are torn down in an
`after` hook regardless of pass/fail).

Covered:

- discovery lists exactly `read_source_file`;
- a synthetic fixture round-trips its expected relative path and text;
- malformed arguments (missing `path`, wrong type);
- missing file, a directory instead of a file, an absolute path, `..`
  traversal;
- an oversized file is rejected, not truncated (`structuredContent` is
  absent on that result);
- unsupported (binary) content is rejected;
- a symlink escaping the source root is rejected — skipped with an
  explanation if the test environment can't create a symlink (e.g.
  Windows without permission to create one), rather than failing;
- the server answers a normal call correctly after several failed calls;
- the server's stderr banner is captured and asserted on directly, and
  every other test having round-tripped valid JSON-RPC over stdout is
  itself evidence that no stray diagnostic corrupted the protocol stream.

## Known acceptance gaps

- The live VS Code/Copilot smoke test described above has not actually
  been performed from this environment (no VS Code available here). Run
  it yourself before relying on this as end-to-end proof.
- Symlink/junction-escape rejection is exercised on Linux in this
  environment; Windows junction behavior relies on Node's `fs.realpath`
  resolving junctions the same way it resolves symlinks, which is
  documented Node behavior but has not been separately verified on
  Windows here.

## Non-goals (out of scope for this milestone, on purpose)

Repository inventory or search, multiple source roots, Git subprocesses or
revision pinning, evidence catalogs or artifact validation, a model
client or API key, MCP sampling/prompts/resources/HTTP transport/auth,
file writes, shell tools, database storage, a UI, Docker/deployment, or
any plugin/agent/extensibility scaffolding. All of that belongs to
`modernization-evidence-harness`, not here.
