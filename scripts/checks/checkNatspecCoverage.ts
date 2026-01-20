// NOTE:
// - This file used to contain a top-level `await import('./checkNatspecCoverage')` which self-imported and could hang.
// - Keep it as a non-blocking shim so CI/check scripts won't hang.
// - If you want a real NatSpec coverage check, implement it here and make it exit non-zero on failure.
console.warn("[checkNatspecCoverage] Not implemented (skipped).");