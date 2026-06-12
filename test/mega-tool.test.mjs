// Unit tests for mega-tool dispatcher + JSON Schema builder (v1.0 prep).

import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchAction, buildJsonSchemaForActions } from "../dist/lib/mega-tool.js";

test("dispatchAction: routes to the right handler", async () => {
  const handlers = {
    create: async (input) => ({ content: [{ type: "text", text: `created ${input.action}` }] }),
    delete: async (input) => ({ content: [{ type: "text", text: `deleted` }] }),
  };
  const out = await dispatchAction({ action: "create" }, handlers);
  assert.equal(out.content[0].text, "created create");
});

test("dispatchAction: unknown action returns structured error", async () => {
  const handlers = { create: async () => ({ content: [{ type: "text", text: "ok" }] }) };
  const out = await dispatchAction({ action: "ghost" }, handlers);
  assert.equal(out.isError, true);
  const payload = JSON.parse(out.content[0].text);
  assert.equal(payload.code, "VALIDATION_FAILED");
  assert.match(payload.message, /Unknown action "ghost"/);
  assert.match(payload.message, /create/);
});

test("dispatchAction: handler errors propagate (handler responsible for own errorResult)", async () => {
  const handlers = {
    boom: async () => ({ content: [{ type: "text", text: "internal" }], isError: true }),
  };
  const out = await dispatchAction({ action: "boom" }, handlers);
  assert.equal(out.isError, true);
});

test("buildJsonSchemaForActions: produces flat schema with xActions metadata", () => {
  const schema = buildJsonSchemaForActions([
    {
      action: "create",
      description: "Create a page",
      schema: { projectSlug: { type: "string" }, path: { type: "string" } },
      required: ["projectSlug", "path"],
    },
    {
      action: "delete",
      description: "Delete a page",
      schema: { projectSlug: { type: "string" }, pageIds: { type: "array", items: { type: "string" } } },
      required: ["projectSlug", "pageIds"],
    },
  ]);
  assert.equal(schema.type, "object");
  // No top-level oneOf — Anthropic API rejects it. Flat schema instead.
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(schema.properties.action.enum, ["create", "delete"]);
  assert.equal(schema.properties.label.minLength, 3);
  assert.equal(schema.properties.label.maxLength, 30);
  // Merged properties from all branches
  assert.equal(schema.properties.projectSlug.type, "string");
  assert.equal(schema.properties.path.type, "string");
  assert.equal(schema.properties.pageIds.type, "array");
  // Only action + label required at JSON Schema level (per-action required enforced by Zod at runtime)
  assert.deepEqual(schema.required, ["action", "label"]);
  assert.equal(schema.additionalProperties, false);
  // xActions exposes per-action metadata for the meta mega-tool
  assert.equal(schema.xActions.length, 2);
  assert.equal(schema.xActions[0].action, "create");
  assert.deepEqual(schema.xActions[0].required, ["projectSlug", "path"]);
  assert.equal(schema.xActions[1].action, "delete");
});

test("buildJsonSchemaForActions: empty array throws", () => {
  assert.throws(() => buildJsonSchemaForActions([]), /at least 1 action/);
});

// ─── conflicting property shapes → nested anyOf (v2.20.1 regression) ─────────
// First-wins merging made instances.update_text UNCALLABLE: update_label's
// `updates` item ({instanceId,label} both required) shadowed update_text's
// ({instanceId,text}) — the advertised schema required `label`, which the
// sub-handler rejects. No payload satisfied both layers.

test("buildJsonSchemaForActions: same key + same shape stays a plain schema (no anyOf)", () => {
  const schema = buildJsonSchemaForActions([
    { action: "a", description: "...", schema: { projectSlug: { type: "string" } }, required: [] },
    { action: "b", description: "...", schema: { projectSlug: { type: "string" } }, required: [] },
  ]);
  assert.equal(schema.properties.projectSlug.type, "string");
  assert.equal(schema.properties.projectSlug.anyOf, undefined);
});

test("buildJsonSchemaForActions: description-only differences do NOT fork an anyOf (first wins)", () => {
  const schema = buildJsonSchemaForActions([
    { action: "a", description: "...", schema: { dryRun: { type: "boolean", description: "doc A" } }, required: [] },
    { action: "b", description: "...", schema: { dryRun: { type: "boolean", description: "doc B" } }, required: [] },
  ]);
  assert.equal(schema.properties.dryRun.type, "boolean");
  assert.equal(schema.properties.dryRun.anyOf, undefined);
  assert.equal(schema.properties.dryRun.description, "doc A");
});

// ─── annotation-only differences (v2.20.3) ───────────────────────────────────
// default/examples never change what validates — they must not fork an anyOf
// either (12 default-only two-variant anyOfs shipped across 10 tools pre-fix).

test("buildJsonSchemaForActions: default-only differences do NOT fork an anyOf; conflicting default is dropped", () => {
  const schema = buildJsonSchemaForActions([
    { action: "a", description: "...", schema: { dryRun: { type: "boolean", default: true } }, required: [] },
    { action: "b", description: "...", schema: { dryRun: { type: "boolean", default: false } }, required: [] },
  ]);
  assert.equal(schema.properties.dryRun.type, "boolean");
  assert.equal(schema.properties.dryRun.anyOf, undefined);
  // Advertising either default could mislead the other action's caller.
  assert.equal("default" in schema.properties.dryRun, false);
});

test("buildJsonSchemaForActions: agreeing defaults survive the merge", () => {
  const schema = buildJsonSchemaForActions([
    { action: "a", description: "...", schema: { dryRun: { type: "boolean", default: true } }, required: [] },
    { action: "b", description: "...", schema: { dryRun: { type: "boolean", default: true } }, required: [] },
  ]);
  assert.equal(schema.properties.dryRun.anyOf, undefined);
  assert.equal(schema.properties.dryRun.default, true);
});

test("buildJsonSchemaForActions: default present on only one action is dropped on merge", () => {
  const schema = buildJsonSchemaForActions([
    { action: "a", description: "...", schema: { dryRun: { type: "boolean", default: true } }, required: [] },
    { action: "b", description: "...", schema: { dryRun: { type: "boolean" } }, required: [] },
  ]);
  assert.equal(schema.properties.dryRun.anyOf, undefined);
  assert.equal("default" in schema.properties.dryRun, false);
});

test("buildJsonSchemaForActions: NESTED conflicting defaults are dropped recursively without forking", () => {
  // Real case: build.pushTo forks two byte-identical object shapes differing
  // only in a nested dryRun default (push_fragment=false, push_complete=true).
  const shape = (dryRunDefault) => ({
    type: "object",
    properties: { page: { type: "string" }, dryRun: { type: "boolean", default: dryRunDefault } },
    additionalProperties: false,
  });
  const schema = buildJsonSchemaForActions([
    { action: "push_fragment", description: "...", schema: { pushTo: shape(false) }, required: [] },
    { action: "push_complete", description: "...", schema: { pushTo: shape(true) }, required: [] },
  ]);
  const pushTo = schema.properties.pushTo;
  assert.equal(pushTo.anyOf, undefined, "default-only nested difference must not fork");
  assert.equal("default" in pushTo.properties.dryRun, false);
  assert.equal(pushTo.properties.page.type, "string");
});

test("buildJsonSchemaForActions: dropConflictingDefaults does not mutate the source action schemas", () => {
  const a = { dryRun: { type: "boolean", default: true } };
  const b = { dryRun: { type: "boolean", default: false } };
  buildJsonSchemaForActions([
    { action: "a", description: "...", schema: a, required: [] },
    { action: "b", description: "...", schema: b, required: [] },
  ]);
  assert.equal(a.dryRun.default, true, "first action's in-memory schema must keep its default");
  assert.equal(b.dryRun.default, false);
});

test("buildJsonSchemaForActions: conflicting shapes for the same key become a nested anyOf tagged per action", () => {
  const labelItems = {
    type: "array",
    items: { type: "object", properties: { instanceId: { type: "string" }, label: { type: "string" } }, required: ["instanceId", "label"], additionalProperties: false },
  };
  const textItems = {
    type: "array",
    items: { type: "object", properties: { instanceId: { type: "string" }, text: { type: "string" } }, required: ["instanceId", "text"], additionalProperties: false },
  };
  const schema = buildJsonSchemaForActions([
    { action: "update_label", description: "...", schema: { updates: labelItems }, required: ["updates"] },
    { action: "update_text", description: "...", schema: { updates: textItems }, required: ["updates"] },
  ]);
  const updates = schema.properties.updates;
  assert.ok(Array.isArray(updates.anyOf), "conflicting `updates` shapes must merge into anyOf");
  assert.equal(updates.anyOf.length, 2);
  // Each variant keeps its own validation shape and is tagged with its action.
  const labelVariant = updates.anyOf.find((v) => v.items.required.includes("label"));
  const textVariant = updates.anyOf.find((v) => v.items.required.includes("text"));
  assert.ok(labelVariant && textVariant, "both shapes must survive the merge");
  assert.match(labelVariant.description, /action="update_label"/);
  assert.match(textVariant.description, /action="update_text"/);
  // Still no TOP-LEVEL anyOf (Anthropic API constraint) — only nested under the property.
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.allOf, undefined);
});

test("buildJsonSchemaForActions: actions sharing one shape group into a single anyOf variant", () => {
  const shapeA = { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
  const shapeB = { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
  const schema = buildJsonSchemaForActions([
    { action: "a1", description: "...", schema: { updates: shapeA }, required: [] },
    { action: "a2", description: "...", schema: { updates: shapeA }, required: [] },
    { action: "b1", description: "...", schema: { updates: shapeB }, required: [] },
  ]);
  const updates = schema.properties.updates;
  assert.equal(updates.anyOf.length, 2);
  const grouped = updates.anyOf.find((v) => /action="a1", action="a2"/.test(v.description));
  assert.ok(grouped, "a1 and a2 share a shape — must be one variant tagged with both");
});

test("buildJsonSchemaForActions: per-action required surfaced via xActions", () => {
  const schema = buildJsonSchemaForActions([
    { action: "list", description: "List", schema: { projectSlug: { type: "string" } }, required: ["projectSlug"] },
  ]);
  assert.deepEqual(schema.xActions[0].required, ["projectSlug"]);
  // JSON Schema top-level required is always just action + label
  assert.deepEqual(schema.required, ["action", "label"]);
});

test("buildJsonSchemaForActions: action description concatenates per-variant docs", () => {
  const schema = buildJsonSchemaForActions([
    { action: "a", description: "doc A", schema: {}, required: [] },
    { action: "b", description: "doc B", schema: {}, required: [] },
  ]);
  // v2.20.3: bare `name — summary` lines (no action="" prefix) in the enum.
  assert.match(schema.properties.action.description, /^a — doc A$/m);
  assert.match(schema.properties.action.description, /^b — doc B$/m);
});
