import { spawnSync } from "child_process";

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

const result = spawnSync(
  pnpmBin(),
  [
    "-s",
    "exec",
    "ts-node",
    "--project",
    "./tsconfig.scripts.json",
    "scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts",
  ],
  {
    env: {
      ...process.env,
      BNB_FORK_AUTONODE_CASES: process.env.BNB_FORK_AUTONODE_CASES ?? "reward-borrow-gate-rmcore",
      TERM_DAYS: process.env.TERM_DAYS ?? "90",
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
