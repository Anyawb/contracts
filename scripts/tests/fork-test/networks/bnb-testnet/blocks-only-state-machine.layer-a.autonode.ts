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
      BNB_FORK_AUTONODE_CASES: process.env.BNB_FORK_AUTONODE_CASES ?? "blocks-only-state-machine",
      LIVE_STRICT_BLOCKS_ONLY_DATAPUSH: process.env.LIVE_STRICT_BLOCKS_ONLY_DATAPUSH ?? "1",
      LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: process.env.LIVE_STRICT_BLOCKS_ONLY_PREMATURITY ?? "0",
      LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS:
        process.env.LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS ?? "6",
      LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS:
        process.env.LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS ?? "1200",
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
