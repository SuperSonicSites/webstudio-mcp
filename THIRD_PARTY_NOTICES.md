# Third-party notices

`bundle/index.js` (the published artifact since v2.21.0) inlines the following
open-source packages and their transitive dependencies. Their license terms
apply to the bundled code; full texts ship inside each package on npm.

| Package | License |
|---|---|
| @modelcontextprotocol/sdk (and its dependency tree, incl. ajv) | MIT |
| zod | MIT |
| zod-to-json-schema | ISC |
| acorn | MIT |
| acorn-walk | MIT |
| nanoid | MIT |
| node-html-parser | MIT |

`playwright-core` (Apache-2.0) is NOT bundled — it is an optional runtime
dependency resolved from the consumer's environment when `read.snapshot` or
the browser-based version recovery is used.
