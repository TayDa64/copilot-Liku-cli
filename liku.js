#!/usr/bin/env node

// Convenience dev shim.
// Allows: `node liku.js <command>` from the repo root.
// The actual CLI entrypoint lives at `src/cli/liku.js` (also used by the npm bin mapping).

require('./src/cli/liku.js');
