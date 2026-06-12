// Staged push handles (v2.21.1).
//
// The two-stage push protocol (dryRun:true → user confirms → dryRun:false +
// forceConfirmed:true) made the model RE-SEND the entire fragment payload on
// the confirm call — 8-15 kB for a mid-size section, tens of kB for 100+
// instance pushes. A successful dry-run now stores its validated input under a
// short single-use id; confirming costs one ~60-char call
// (build.push_staged({stageId})) instead of re-emitting the payload.
//
// Semantics:
//   - single-use: a stage is consumed on take (success or failure of the
//     replayed push — re-staging requires a fresh dry-run, which is the safe
//     default after any failure);
//   - 10-minute TTL: stale previews must not be pushable forever;
//   - per-process memory (precedent: the build cache Map in
//     webstudio-client.ts) — stdio servers are long-lived per session;
//   - the replay path re-runs the FULL push pipeline (auth incl. allowPush,
//     coercions, Radix pre-flight, version-mismatch retries) — staging skips
//     re-transmission, never validation.

import { nanoid } from "nanoid";

export type StagedPush = {
  /** Which underlying tool handler to replay ("push_fragment" | "push_complete"). */
  handler: string;
  /** The validated tool-level args captured at dry-run time. */
  args: Record<string, unknown>;
  projectSlug: string;
  createdAt: number;
};

const STAGE_TTL_MS = 10 * 60_000;
const stages = new Map<string, StagedPush>();

function pruneExpired(now: number): void {
  for (const [id, s] of stages) {
    if (now - s.createdAt > STAGE_TTL_MS) stages.delete(id);
  }
}

/** Store a dry-run's validated args; returns the single-use stage id. */
export function stagePush(
  handler: string,
  projectSlug: string,
  args: Record<string, unknown>,
): string {
  const now = Date.now();
  pruneExpired(now);
  const id = `st_${nanoid(10)}`;
  stages.set(id, { handler, args, projectSlug, createdAt: now });
  return id;
}

/** Consume a stage (single-use). Returns null when unknown or expired. */
export function takeStagedPush(stageId: string): StagedPush | null {
  const now = Date.now();
  pruneExpired(now);
  const staged = stages.get(stageId) ?? null;
  if (staged) stages.delete(stageId);
  return staged;
}

/** Test hook: drop all stages. */
export function clearStagedPushes(): void {
  stages.clear();
}
