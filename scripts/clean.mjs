// Remove the build output so `tsc` always compiles from a clean slate.
//
// Plain `tsc` only emits files that have a current source — it never deletes a
// stale `.js` left behind when a `.ts` is renamed or removed. Without this step,
// orphaned compiled files (e.g. the pre-mega tool dispatchers) linger in `dist/`
// and ship via the npm `files` allowlist. Run automatically by `npm run build`
// (and therefore by `prepack` at publish time).
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
rmSync("bundle", { recursive: true, force: true });
