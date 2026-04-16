#!/usr/bin/env node

console.error("ERROR: test:unit has been deprecated to prevent pg-mem / real-db mixing.");
console.error("Use one explicit command instead:");
console.error("  pnpm run test:fast");
console.error("  pnpm run test:real-db-core");
console.error("  pnpm run test:critical-path");
console.error("  pnpm run test:integration");
console.error("  pnpm run test:invariant");
process.exit(1);
