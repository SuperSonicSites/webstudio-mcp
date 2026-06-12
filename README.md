# @densrt/webstudio-mcp

[![CI](https://github.com/Densrt/webstudio-mcp/actions/workflows/mcp-health.yml/badge.svg)](https://github.com/Densrt/webstudio-mcp/actions/workflows/mcp-health.yml)
[![npm](https://img.shields.io/npm/v/@densrt/webstudio-mcp)](https://www.npmjs.com/package/@densrt/webstudio-mcp)
![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

An **unofficial** [MCP](https://modelcontextprotocol.io) server for [Webstudio Cloud](https://webstudio.is) —
generate, push, audit, and refactor Webstudio projects programmatically. Built for AI agents
(Claude, Cursor, any MCP-compatible client) and CLI workflows.

> **Disclaimer.** This is an independent, community project. It is **not affiliated with,
> endorsed by, or supported by Webstudio**. It drives Webstudio Cloud through a captured
> browser session (cookie + CSRF), not a public API — behaviour may break if Webstudio
> changes. Use at your own risk; review [`SECURITY.md`](SECURITY.md) before exposing it to
> untrusted input.

## What it does

- **Generate** Webstudio fragments (sheets, navs, sections, swipers, popups, custom trees) and push them to a project.
- **Audit** projects for unused tokens, dead images, oversized fonts, broken bindings, mobile overflow, and more.
- **Refactor** tokens at scale (rename, replace, dedupe overrides into variants, extract from locals).
- **Inspect** instances, forms, and resources before patching.
- **Safety-first**: every mutating action defaults to `dryRun`, and a two-stage push protocol is enforced server-side.

## Requirements

- Node.js **≥ 18**
- A Webstudio Cloud account (you capture your own session cookie + CSRF — see [`docs/auth.md`](docs/auth.md))

## Quick start

### 1. Add the server to your MCP client

No install needed — run it straight from npm with `npx`.

**Claude Code:**

```bash
claude mcp add webstudio -- npx -y @densrt/webstudio-mcp
```

**Cursor / Claude Desktop** (`mcpServers` block of your client config):

```json
{
  "mcpServers": {
    "webstudio": {
      "command": "npx",
      "args": ["-y", "@densrt/webstudio-mcp"]
    }
  }
}
```

### 2. Bootstrap a project

```ts
mcp__webstudio__project({ action: "init", label: "init-site", projectSlug: "my-site", webstudioProjectId: "..." })
mcp__webstudio__auth({ action: "setup", label: "auth-site", projectSlug: "my-site", cookie: "...", csrfToken: "..." })
mcp__webstudio__auth({ action: "allow_push", label: "allow-push", projectSlug: "my-site", allow: true })
mcp__webstudio__read({ action: "fetch_pages", label: "list-pages", projectSlug: "my-site" })
```

See [`docs/auth.md`](docs/auth.md) for how to capture the cookie + CSRF token.

### 3. Discover tools & patterns

```ts
mcp__webstudio__meta({ action: "guide", label: "triage", brief: "desktop mega menu with dropdowns" })   // best pattern + tool
mcp__webstudio__meta({ action: "index", label: "catalog" })                                              // tool catalog
mcp__webstudio__meta({ action: "describe_pattern", label: "doc", pattern: "navigation-menu-radix" })     // full recipe
```

## Architecture

- **15 mega-tools** with a discriminated `action` field (Webflow-MCP-style), instead of a sprawl of atomic tools.
- **Required `label`** (3–30 chars, unique within multi-action calls) for result identification.
- **Tiered `context`** enforcement: required for CRITICAL actions, recommended for STRUCTURING.
- **Annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool let MCP clients gate permissions.
- **MCP Resources**: the pattern library is exposed at `webstudio://patterns/<slug>`.
- **Two-stage push protocol** on every mutating action (`dryRun:true` → `forceConfirmed:true`).

Deep technical notes live in [`docs/`](docs/): [`data-model.md`](docs/data-model.md),
[`auth.md`](docs/auth.md), [`patches.md`](docs/patches.md), [`safety.md`](docs/safety.md),
plus the pattern recipes under [`docs/patterns/`](docs/patterns/).

## Tool catalog

| Mega-tool | Highlights |
|---|---|
| `meta` | `guide` (free-text triage), `index`, `list_patterns`, `describe_pattern` |
| `auth` | local credential management (`setup`, `allow_push`, `update_app_version`) |
| `project` | `init`, `list`, `export`, **`nuke`** (CRITICAL), `import_figma` |
| `read` | `fetch_pages`, `list_instances`, `read_texts`, `inspect`, `snapshot` (PNG via Playwright) |
| `pages` | `create`, `update`, **`delete`**, folders, project-level `get_meta` / `update_meta` |
| `instances` | `append`, **`delete`**, `clone`, `clone_page`, `wrap`, `flatten`, `update_*`, `prop_*` |
| `build` | `build_fragment`, `push_fragment`, `push_complete`, `create_sheet`, `create_navigation_menu`, `create_popup`, `push_html` |
| `styles` | `get_decls`, `update`, `delete_decl`, `replace_value` (local overrides) |
| `tokens` | full lifecycle — create, attach, extract, variants, rename, dedupe, … |
| `cssvar` | `define`, `list`, **`delete`**, `rewrite_refs` |
| `variables` | `create`, `list`, `update`, **`delete`**, `bind_page_field` |
| `resources` | `create`, `list`, `update`, **`delete`** (REST data binding) |
| `assets` | `upload`, `list`, `find_usage`, **`replace`**, **`delete`** |
| `audit` | `page`, `overflow`, `token_usage`, `orphans`, `images`, `fonts`, `scripts`, … (read-only) |
| `cms` | external CMS adapter (Directus / WordPress / n8n): list, discover, CRUD, `bind_collection_to_instance` |

Run `meta.index` for the live, per-action catalog.

## Configuration (environment variables)

All optional — the defaults fit interactive agent sessions.

| Variable | Default | Effect |
|---|---|---|
| `WEBSTUDIO_MCP_TOOLS` | unset (full surface) | Comma-separated mega-tools to register, e.g. `meta,read,audit`, or a named preset: `readonly` (meta,read,audit), `content` (meta,read,styles,tokens,instances,cms), `builder` (meta,read,build,instances,styles,tokens). Presets compose with explicit names (`readonly,assets`). `meta` is always included. Unknown names warn on stderr; a filter matching nothing fail-safes to `meta` only. Read-only routines get safety (no mutation tools mounted) + a ~7× cheaper handshake. |
| `WEBSTUDIO_MCP_RESOURCES` | unset (enabled) | `0` disables the MCP pattern resources (the 42-entry `resources/list`, ~6.6 kB per session). Patterns stay reachable via `meta.list_patterns` / `meta.describe_pattern`. Recommended for secondary read-only instances: `WEBSTUDIO_MCP_TOOLS=readonly` + `WEBSTUDIO_MCP_RESOURCES=0`. |
| `WEBSTUDIO_MCP_BUILD_CACHE_TTL_MS` | `120000` | TTL of the in-memory project-build cache. `0` disables it (every read re-fetches — useful when debugging alongside live edits in the builder). |
| `WEBSTUDIO_MCP_TELEMETRY` | unset (off) | `1` enables JSONL telemetry (tool calls, coerces, build-cache hit/miss). |
| `WEBSTUDIO_MCP_TELEMETRY_PATH` | `~/.webstudio-mcp-telemetry.jsonl` | Telemetry output path. |

## From source

```bash
git clone https://github.com/Densrt/webstudio-mcp
cd webstudio-mcp
npm install
npm run build
node dist/index.js   # or: claude mcp add webstudio -- node /abs/path/to/dist/index.js
```

## Development

```bash
npm run build      # compile TypeScript → dist/
npm test           # run the test suite (node:test)
npm run dev        # watch mode (ts-node)
```

CI (`.github/workflows/mcp-health.yml`) runs the build, the full test suite, and a set of
guard tests (tool-count cap, description linter, pattern-doc frontmatter, version
consistency). See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Contributing

Contributions are welcome — please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. It
describes the 4-tier "anti-spaghetti" rule that keeps the tool surface small, and the
8-step workflow for adding an action or pattern.

## Security

Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
