// v2.20.1 regression — instances.update_text was UNCALLABLE.
//
// The mega-tool's flat inputSchema merged per-action properties first-wins:
// `updates` from update_label ({instanceId,label} — both required, strict)
// shadowed the differently-shaped `updates` of update_tag, update_text and
// prop_update. Clients validating against the advertised schema demanded
// `label` on every updates[] item, while the update_text sub-handler's strict
// Zod rejects `label` — no payload satisfied both layers, so no text-node
// edit could go through (field report 2026-06-11, v2.20.0).
//
// Fix: conflicting shapes for the same key now merge into a nested anyOf
// (see buildJsonSchemaForActions). This test pins the advertised shape of the
// real instances tool so the collision can't silently come back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { instancesTool } from "../dist/tools/instances-mega.js";
import { toWireToolDefinition } from "../dist/lib/mega-tool.js";

function getUpdatesVariants(schema) {
  const updates = schema.properties.updates;
  assert.ok(updates, "instances schema must advertise `updates`");
  assert.ok(Array.isArray(updates.anyOf), "`updates` is shared by 4 actions with different item shapes — must be an anyOf");
  return updates.anyOf;
}

function variantRequiring(variants, key) {
  return variants.find((v) => Array.isArray(v.items?.required) && v.items.required.includes(key));
}

test("instances: `updates` advertises one variant per conflicting action shape", () => {
  const variants = getUpdatesVariants(instancesTool.definition.inputSchema);
  for (const [key, action] of [["label", "update_label"], ["tag", "update_tag"], ["text", "update_text"], ["propName", "prop_update"]]) {
    const v = variantRequiring(variants, key);
    assert.ok(v, `missing updates[] variant requiring "${key}" (action ${action})`);
    assert.match(v.description, new RegExp(`action="${action}"`), `variant for "${key}" must name its action`);
  }
});

test("instances: the update_text variant accepts {instanceId,text,childIndex?,mode?} and does NOT require label", () => {
  const variants = getUpdatesVariants(instancesTool.definition.inputSchema);
  const v = variantRequiring(variants, "text");
  assert.deepEqual([...v.items.required].sort(), ["instanceId", "text"]);
  assert.ok(v.items.properties.childIndex, "childIndex must be advertised");
  assert.ok(v.items.properties.mode, "mode must be advertised");
  assert.equal(v.items.properties.label, undefined, "update_text items must not advertise label");
});

test("instances: wire definition keeps the anyOf nested — never at the schema top level", () => {
  const wire = toWireToolDefinition(instancesTool.definition);
  assert.equal(wire.inputSchema.anyOf, undefined);
  assert.equal(wire.inputSchema.oneOf, undefined);
  assert.equal(wire.inputSchema.allOf, undefined);
  // The updates property survives the wire dedupe pass (possibly with $ref'd
  // subtrees inside, but the anyOf fan-out itself must remain addressable).
  const updates = wire.inputSchema.properties.updates;
  assert.ok(updates, "wire schema must still advertise `updates`");
});
