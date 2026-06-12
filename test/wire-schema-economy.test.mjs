// v2.12.0 — wire-schema economy guard tests.
//
// The 15-tool handshake weighed ~57k tokens in v2.11.0 because every action
// description travelled twice in each inputSchema: once concatenated in the
// `action` enum description, once in the non-standard `xActions` metadata.
// v2.12.0 keeps full docs in-memory (meta.get_more_tools / guide BM25) and
// ships only one-line summaries on the wire:
//   1. summarizeActionDescription — full description → "Use when:" lead
//   2. toWireToolDefinition — strips xActions at ListTools time
//   3. meta.get_more_tools exact "<tool>.<action>" brief → full doc on demand

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeActionDescription,
  toWireToolDefinition,
  buildJsonSchemaForActions,
} from "../dist/lib/mega-tool.js";
import { makeMetaTool } from "../dist/tools/meta-mega.js";
import { instancesTool } from "../dist/tools/instances-mega.js";

// ── summarizeActionDescription ──────────────────────────────────────────────

test("summarize: cuts at the first detail marker (Do NOT use when)", () => {
  const full =
    "Use when: add child instances to a parent. Do NOT use when: moving (use move). Returns: patch list. Example: {action:\"append\"}";
  assert.equal(summarizeActionDescription(full), "Use when: add child instances to a parent.");
});

test("summarize: cuts at Returns when Do NOT is absent", () => {
  const full = "Use when: list things. Returns: a list. Side effects: none.";
  assert.equal(summarizeActionDescription(full), "Use when: list things.");
});

test("summarize: short free-form description passes through unchanged", () => {
  assert.equal(summarizeActionDescription("doc A"), "doc A");
  assert.equal(summarizeActionDescription("Create a page"), "Create a page");
});

test("summarize: collapses newlines/whitespace to one line", () => {
  const full = "Use when: foo\n  bar.\n\nReturns: stuff.";
  assert.equal(summarizeActionDescription(full), "Use when: foo bar.");
});

test("summarize: hard cap at 110 chars with ellipsis", () => {
  const long = "Use when: " + "x".repeat(400);
  const out = summarizeActionDescription(long);
  assert.ok(out.length <= 110, `expected <=110 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("summarize: CRITICAL marker survives even when it lives in the cut detail", () => {
  const full =
    "Use when: delete a token everywhere. Do NOT use when: detaching. CRITICAL — context required. Returns: patch list.";
  const out = summarizeActionDescription(full);
  assert.match(out, /CRITICAL/);
});

test("summarize: CRITICAL in the lead is not duplicated", () => {
  const full = "Use when: CRITICAL — context required — wipe the project. Returns: report.";
  const out = summarizeActionDescription(full);
  assert.equal(out.match(/CRITICAL/g)?.length, 1);
});

// ── toWireToolDefinition ────────────────────────────────────────────────────

test("toWireToolDefinition: strips xActions, keeps everything else", () => {
  const wire = toWireToolDefinition(instancesTool.definition);
  assert.equal(wire.name, instancesTool.definition.name);
  assert.equal(wire.description, instancesTool.definition.description);
  assert.ok(!("xActions" in wire.inputSchema), "wire schema must not carry xActions");
  assert.ok("properties" in wire.inputSchema);
  assert.deepEqual(wire.inputSchema.required, instancesTool.definition.inputSchema.required);
});

test("toWireToolDefinition: does not mutate the in-memory definition", () => {
  toWireToolDefinition(instancesTool.definition);
  const schema = instancesTool.definition.inputSchema;
  assert.ok(Array.isArray(schema.xActions), "in-memory xActions must survive (meta + guard tests read it)");
  assert.ok(schema.xActions.length >= 10);
});

test("toWireToolDefinition: passthrough for schemas without xActions", () => {
  const def = { name: "plain", inputSchema: { type: "object", properties: {} } };
  assert.equal(toWireToolDefinition(def), def);
});

// ── buildJsonSchemaForActions wire shape ────────────────────────────────────

test("action enum description carries one-line summaries only", () => {
  const schema = buildJsonSchemaForActions([
    {
      action: "create",
      description: "Use when: create one. Do NOT use when: batch. Returns: id. Example: {action:\"create\"}",
      schema: {},
      required: [],
    },
  ]);
  const desc = schema.properties.action.description;
  assert.match(desc, /^create — Use when: create one\./m);
  assert.doesNotMatch(desc, /Do NOT use when: batch/, "detail must not travel in the enum description");
  // v2.20.3: the get_more_tools pointer moved off the per-tool wire (was ×15)
  // into SERVER_INSTRUCTIONS rule 8 — it must not be re-added here.
  assert.doesNotMatch(desc, /meta\.get_more_tools/, "pointer lives once in SERVER_INSTRUCTIONS, not ×15 on the wire");
  // Full doc still available in-memory for BM25 + exact lookup.
  assert.match(schema.xActions[0].description, /Do NOT use when: batch/);
});

// ── context property guard (incident 2026-05-26) ────────────────────────────
// `context` must stay a DECLARED property under additionalProperties:false on
// every mega-tool wire schema — without it, clients reject the param before it
// reaches the server and CRITICAL actions become uncallable.

test("every wire schema declares `context` under additionalProperties:false", async () => {
  const mods = [
    ["../dist/tools/auth-mega.js", "authTool"],
    ["../dist/tools/project-mega.js", "projectTool"],
    ["../dist/tools/read-mega.js", "readTool"],
    ["../dist/tools/build-mega.js", "buildTool"],
    ["../dist/tools/instances-mega.js", "instancesTool"],
    ["../dist/tools/pages.js", "pagesTool"],
    ["../dist/tools/styles-mega.js", "stylesMegaTool"],
    ["../dist/tools/tokens-mega.js", "tokensTool"],
    ["../dist/tools/cssvar-mega.js", "cssvarTool"],
    ["../dist/tools/variables-mega.js", "variablesTool"],
    ["../dist/tools/resources-mega.js", "resourcesTool"],
    ["../dist/tools/assets.js", "assetsTool"],
    ["../dist/tools/audit-mega.js", "auditMegaTool"],
    ["../dist/tools/cms-mega.js", "cmsTool"],
  ];
  const tools = [];
  for (const [path, exp] of mods) tools.push((await import(path))[exp]);
  tools.unshift(makeMetaTool(() => tools));
  for (const t of tools) {
    const wire = toWireToolDefinition(t.definition);
    const schema = wire.inputSchema;
    assert.equal(schema.additionalProperties, false, `${wire.name}: additionalProperties must be false`);
    assert.ok(schema.properties.context, `${wire.name}: context must stay a declared property`);
    assert.equal(schema.properties.context.type, "string");
    assert.ok(schema.properties.label, `${wire.name}: label must stay declared`);
  }
});

// ── meta.get_more_tools exact lookup (progressive disclosure path) ──────────

const stubTool = {
  definition: {
    name: "stub",
    description: "Stub tool for exact-lookup tests",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      xActions: [
        {
          action: "alpha",
          description:
            'Use when: alpha things. Do NOT use when: beta things. Returns: ok. Example: {action:"alpha",label:"go"}',
          required: [],
          schemaKeys: [],
        },
        { action: "beta", description: "Use when: beta things only.", required: [], schemaKeys: [] },
      ],
    },
  },
  handler: async () => ({ content: [] }),
};

test("get_more_tools: exact <tool>.<action> brief returns the FULL doc", async () => {
  const meta = makeMetaTool(() => [stubTool]);
  const res = await meta.handler({ action: "get_more_tools", label: "doc-alpha", brief: "stub.alpha" });
  assert.notEqual(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /Full doc/);
  assert.match(text, /stub\.alpha/);
  assert.match(text, /Do NOT use when: beta things/, "full description expected, not a snippet");
});

test("get_more_tools: bare action name also resolves exactly", async () => {
  const meta = makeMetaTool(() => [stubTool]);
  const res = await meta.handler({ action: "get_more_tools", label: "doc-beta", brief: "beta" });
  const text = res.content[0].text;
  assert.match(text, /Full doc/);
  assert.match(text, /beta things only/);
});

test("get_more_tools: free-text brief still goes through BM25 ranking", async () => {
  const meta = makeMetaTool(() => [stubTool]);
  const res = await meta.handler({ action: "get_more_tools", label: "find-alpha", brief: "alpha things" });
  const text = res.content[0].text;
  assert.doesNotMatch(text, /Full doc/);
  assert.match(text, /BM25 ranked/);
});
