// Unit tests for the v2.0 Zod-driven JSON schema builder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { actionFromZod, buildJsonSchemaFromZodActions } from "../dist/lib/zod-action-def.js";

test("actionFromZod: derives properties from a flat z.object schema", () => {
  const schema = z.object({
    projectSlug: z.string(),
    name: z.string(),
    enabled: z.boolean().optional(),
  }).strict();
  const def = actionFromZod({ action: "create", description: "Create thing.", zod: schema });
  assert.equal(def.action, "create");
  assert.equal(def.description, "Create thing.");
  assert.ok(def.schema.projectSlug, "projectSlug must be in derived schema");
  assert.ok(def.schema.name);
  assert.ok(def.schema.enabled);
  assert.deepEqual([...(def.required ?? [])].sort(), ["name", "projectSlug"]);
});

test("actionFromZod: omits optional fields from required[]", () => {
  const schema = z.object({
    a: z.string(),
    b: z.string().optional(),
  });
  const def = actionFromZod({ action: "x", description: "...", zod: schema });
  assert.deepEqual(def.required, ["a"]);
});

test("actionFromZod: nested objects preserved as JSON schema", () => {
  const schema = z.object({
    style: z.object({ color: z.string(), size: z.number().optional() }),
  });
  const def = actionFromZod({ action: "x", description: "...", zod: schema });
  const style = def.schema.style;
  assert.ok(style, "style key must exist");
  assert.equal(style.type, "object");
  assert.ok(style.properties.color);
  assert.ok(style.properties.size);
});

test("actionFromZod: arrays of objects preserved", () => {
  const schema = z.object({
    updates: z.array(z.object({ id: z.string(), value: z.string() })),
  });
  const def = actionFromZod({ action: "batch", description: "...", zod: schema });
  const updates = def.schema.updates;
  assert.equal(updates.type, "array");
  assert.equal(updates.items.type, "object");
  assert.ok(updates.items.properties.id);
});

test("actionFromZod: throws if Zod is not a z.object (e.g. primitive)", () => {
  assert.throws(
    () => actionFromZod({ action: "x", description: "...", zod: z.string() }),
    /sub-handler Zod must be a z\.object/,
  );
});

test("buildJsonSchemaFromZodActions: integrates with the flatten builder", () => {
  const create = z.object({ projectSlug: z.string(), name: z.string() }).strict();
  const remove = z.object({ projectSlug: z.string(), id: z.string() }).strict();

  const schema = buildJsonSchemaFromZodActions([
    { action: "create", description: "Create one.", zod: create },
    { action: "delete", description: "Delete one.", zod: remove },
  ]);

  // Anthropic-API compatible: flat object, action enum, required at top is just action+label.
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["action", "label"]);
  assert.deepEqual(schema.properties.action.enum, ["create", "delete"]);
  // Per-action props are merged into top-level properties (shape-aware:
  // identical shapes collapse, conflicting shapes fork a nested anyOf).
  assert.ok(schema.properties.projectSlug);
  assert.ok(schema.properties.name);
  assert.ok(schema.properties.id);

  // xActions carries per-action metadata for meta.index + meta.get_more_tools.
  assert.equal(schema.xActions.length, 2);
  const createMeta = schema.xActions.find((a) => a.action === "create");
  assert.ok(createMeta);
  assert.deepEqual([...createMeta.required].sort(), ["name", "projectSlug"]);
  assert.deepEqual([...createMeta.schemaKeys].sort(), ["name", "projectSlug"]);
});

test("buildJsonSchemaFromZodActions: no top-level oneOf/allOf/anyOf (Anthropic API constraint)", () => {
  const a = z.object({ x: z.string() }).strict();
  const b = z.object({ y: z.string() }).strict();
  const schema = buildJsonSchemaFromZodActions([
    { action: "a", description: "...", zod: a },
    { action: "b", description: "...", zod: b },
  ]);
  // The whole point of the v1.0 flatten: no oneOf/allOf/anyOf at the top of input_schema.
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.allOf, undefined);
  assert.equal(schema.anyOf, undefined);
});
