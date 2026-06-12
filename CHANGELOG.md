# Changelog

All notable changes to this project are documented here. This package was developed
privately before its first public release, so the history below starts at the first
public version. Format inspired by [Keep a Changelog](https://keepachangelog.com/),
versioning per [SemVer](https://semver.org/).

## [2.20.3] — 2026-06-12

Wire-schema diet: the full 15-tool tools/list handshake shrank **98,885 →
75,783 B (−23.4%, ~−5.8k tokens per session)**; the filtered
`meta,read,audit` surface shrank 13,398 → 10,030 B. Measured live over
stdio; `scripts/measure-wire.mjs` (new) reproduces the numbers.

- fix(schema): default/examples-only differences no longer fork per-action
  `anyOf` variants (12 duplicated shapes across 10 tools). When merged
  actions disagree on an advertised `default`, the key is dropped rather
  than first-wins — advertising `default:true` on `build.pushTo` while
  push_fragment runtime-defaults false could have triggered an unintended
  live push. (−4.5 kB)
- perf(wire): the ~470-char `context` policy, label description, and
  "Full docs…" trailer were byte-identical across all 15 tools — now one
  line each, with the policy and the get_more_tools pointer stated once in
  the server instructions (which net-shrank, 1,793 → 1,693 B). Runtime
  enforcement unchanged (context-validator). New guard test pins `context`
  as a declared property under `additionalProperties:false` (incident
  2026-05-26). (−7.8 kB)
- perf(wire): action summary cap 220 → 110 chars; enum lines drop the
  `action="…"` prefix; all 73 over-long "Use when:" leads rewritten to
  ≤100-char verb phrases with displaced detail preserved off-wire
  (meta.get_more_tools / guide BM25 still index full docs). (−8.0 kB)
- perf(wire): styles.update advertises a compact StyleValue stand-in
  instead of the inlined 11-variant recursive union (which degraded to {}
  through zod-to-json-schema anyway); runtime validation unchanged. Six
  oversized property descriptions in build trimmed. (−2.7 kB)
- perf(output): the fixed read.inspect style-sources hint (~280 chars) and
  get_decls `json:true` footer (~150 chars) now emit on the first call and
  every 10th thereafter instead of every response (hint-once).
- chore(scripts): wire measurement promoted to `scripts/measure-wire.mjs`;
  lint-descriptions + measure-baseline now run on Windows (fileURLToPath).

## [2.20.2] — 2026-06-11

- fix(assets): asset uploads now invalidate the build cache before the first
  /rest/assets POST. Previously, for up to a full cache TTL after assets.upload,
  replace_asset rejected the just-uploaded assetId, pages.update_meta validated
  against a stale asset list, and upload dedupe re-uploaded bytes it already had.
  Regression tests: test/upload-cache-invalidation.test.mjs.
- perf(cache): default build-cache TTL raised 30s → 120s. The server sends
  `Cache-Control: private, no-store` and no ETag, so the in-process TTL is the
  only read-dedup lever; every mutation path (pushes, asset uploads) invalidates
  eagerly and push retries always re-fetch fresh. Override via
  WEBSTUDIO_MCP_BUILD_CACHE_TTL_MS (0 disables).
- perf(cache): pure-read tools (13 audit actions, get_decls, inspect,
  list_instances, read_texts, list_assets, find_asset_usage, project.export)
  now share one deep-frozen cached build instead of paying a full
  structuredClone per cache hit (~25 ms/hit on a 1 MB build, scales with
  project size). Frozen objects turn latent cache-corrupting mutations into
  loud TypeErrors; mutation-path reads keep receiving mutable clones.
- fix(patterns): pattern docs are read CRLF-tolerantly. On Windows checkouts
  (git autocrlf) the LF-only frontmatter regex never matched, so all 42
  patterns lost name/description/recommendedTool metadata — resources/list
  shipped fallback slices and meta.guide could not map patterns to tools.
  Packing/publishing from a Windows tree would have shipped the broken files.

## [2.20.1] — 2026-06-11

- fix(schema): instances.update_text (and every action sharing a param name with a
  differently-shaped sibling) was uncallable — the mega-tool's flat inputSchema merged
  per-action properties first-wins, so `updates` advertised update_label's strict
  `{instanceId, label}` item shape for ALL of update_label/update_tag/update_text/
  prop_update. Clients validating against the advertised schema demanded `label` on
  every item while the update_text sub-handler rejects it — no payload satisfied both
  layers. Conflicting shapes now merge into a nested `anyOf` (one variant per distinct
  shape, tagged with its action(s); nested unions are fine — only TOP-LEVEL
  oneOf/allOf/anyOf is rejected by the Anthropic API). Also corrects the advertised
  shapes of resources.update (`url`/`method`/`headers`/`body`), pages (`meta`,
  `name`), tokens (`instanceIds`) and friends. Wire payload stays under budget
  (98.4k / 120k chars). Regression tests: test/instances-updates-schema.test.mjs +
  buildJsonSchemaForActions unit tests.

## [2.20.0] — 2026-06-10

- feat(resources): method-aware create — form actions are standalone (no dataSource, no cache header)
- feat(guards): global anti-pattern audit — Video coerce, show-binding lint, shared-subtree delete guard
- feat(images): raw <img> eradication — auto-convert to the native Image component everywhere
- chore(deps): engines >=20 + zod4 migration path documented (timeboxed no-go)
- perf(wire,snapshot): $defs dedupe (-13k chars wire) + warm browser + canvas polling
- feat(instances): append batch form — N simple children in ONE transaction
- feat(surface): reduced tool-surface mode via WEBSTUDIO_MCP_TOOLS allowlist
- feat(hardening): wire-budget CI guard, build-cache telemetry, retry backoff, registry comments
- feat(reads): bounded responses (tokens limit, audit.page maxChars) + structuredContent on get_decls
- refactor(lib): dedupe findReplaceTargets, Binding Zod schemas, replace-merge engine
- perf(core): build cache + lazy playwright + BM25 corpus cache
- feat(schema): wire-schema economy — one-line action summaries + xActions stripped from tools/list
- feat(expressions): lint raw binding expressions against Webstudio's allowlist
- chore: sync package-lock.json to v2.10.10
- fix(release): bump.mjs detects SERVER_VERSION via regex test (idempotent on same version)
- docs(changelog): public changelog entry for v2.10.10
- docs(changelog): backfill 2.10.8 and 2.10.9 entries
- fix(state): coerce state selector on all style write paths

## [2.10.10] — 2026-06-03

- fix(state): coerce the `state` selector on every style write path — a bare `"hover"` (no colon) was stored as a dead state that never triggered; recoverable forms (`"hover"`, `":Hover"`, `":before"`) are now coerced to canonical + hinted, unknown states rejected. New pattern `state-selector-format`.

## [2.10.9] — 2026-06-03

- docs(patterns): fix Image.src asset-only myth + add image-component recipe
- fix(tokens): run full coerce/normalize/complete pipeline on create_tokens

## [2.10.8] — 2026-06-03

- build(release): one-command release-public.sh (dry-run by default)
- chore(cleanup): drop superseded webstudio_delete_page + fix page-management doc
- chore(hygiene): remove dead internal residue from the private repo

## [2.10.7] — 2026-06-03

Polish: removed author-environment paths and internal residue from shipped comments/docs, fixed two stale doc references and the CI branch trigger. No functional or API change.

## [2.10.6] — 2026-06-03

Initial public release.

### Highlights

- **15 mega-tools** to generate, push, audit, and refactor [Webstudio Cloud](https://webstudio.is)
  projects programmatically (`meta`, `auth`, `project`, `read`, `pages`, `instances`,
  `build`, `styles`, `tokens`, `cssvar`, `variables`, `resources`, `assets`, `audit`, `cms`).
- **Pattern library** exposed as MCP resources (`webstudio://patterns/<slug>`) and via
  free-text triage (`meta.guide`).
- **Safety-first**: every mutating action defaults to `dryRun`, with a two-stage push
  protocol enforced server-side; destructive actions additionally require explicit
  confirmation.
- **External CMS adapters** (Directus / WordPress / n8n) for dynamic content binding.

See the [README](README.md) for the full tool catalog and quick start.
