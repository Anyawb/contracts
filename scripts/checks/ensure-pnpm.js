#!/usr/bin/env node
/**
 * Enforce pnpm as the package manager for this repo.
 *
 * Why:
 * - We use `pnpm-lock.yaml` as the single source of truth for dependency resolution.
 * - Mixing npm/yarn lockfiles can silently downgrade dependencies (e.g. OZ v4 vs v5).
 */
const userAgent = process.env.npm_config_user_agent || "";

// Allow opting out for edge cases.
if (process.env.SKIP_PNPM_ENFORCE === "1") {
  process.exit(0);
}

if (!userAgent.startsWith("pnpm/")) {
  // eslint-disable-next-line no-console
  console.error(
    [
      "ERROR: This repo uses pnpm only.",
      "",
      `Detected npm_config_user_agent: ${userAgent || "(empty)"}`,
      "",
      "Please run:",
      "  pnpm install",
      "",
      "If you really need to bypass this check, set:",
      "  SKIP_PNPM_ENFORCE=1",
    ].join("\n")
  );
  process.exit(1);
}

