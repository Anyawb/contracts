import fs from "fs";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { getLiveTestProfile } from '../../../../config/profiles';

type CaseName = "preflight" | "warmup" | "platform-baseline" | "guarantee-baseline" | "release-gates" | "release-gates-layer-b" | "blocks-only-liquidation" | "blocks-only-state-machine" | "settlement-role-bridge" | "shortfall-ledger" | "shortfall-bootstrap-guard" | "ergm-settlement-entry-guard" | "reward-borrow-gate-rmcore";

type CaseConfig = {
  file: string;
  description: string;
  env?: Record<string, string>;
};

const CASES: Record<CaseName, CaseConfig> = {
  preflight: {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-preflight.ts",
    description: "Runs the BNB live preflight wrapper on top of a local fork",
  },
  warmup: {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-warmup.ts",
    description: "Runs the BNB live warmup wrapper on top of a local fork",
  },
  "platform-baseline": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-platform-baseline.ts",
    description: "Runs the BNB platform baseline wrapper on top of a local fork",
    env: {
      BNB_SKIP_WARMUP: "1",
    },
  },
  "guarantee-baseline": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-guarantee-baseline.ts",
    description: "Runs the BNB guarantee baseline wrapper on top of a local fork",
    env: {
      LIVE_GUARANTEE_BASELINE_LAYER: "runtime",
    },
  },
  "release-gates": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-release-gates.ts",
    description: "Runs the BNB release-gates wrapper on top of a local fork",
    env: {
      LIVE_RELEASE_NETWORK: "bnbTestnet",
      LIVE_RELEASE_EXECUTION_NETWORK: "localhost",
      LIVE_RELEASE_SCRIPT_NETWORK: "bnbTestnet",
      LIVE_RELEASE_SKIP_LOCALHOST_BOOTSTRAP: "1",
    },
  },
  "release-gates-layer-b": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-release-gates-layer-b.ts",
    description: "Runs the BNB architecture layer-b release-gates wrapper on top of a local fork",
    env: {
      LIVE_TEST_NETWORK: "bnbTestnet",
      LIVE_RELEASE_NETWORK: "bnbTestnet",
      LIVE_RELEASE_EXECUTION_NETWORK: "localhost",
      LIVE_RELEASE_SCRIPT_NETWORK: "bnbTestnet",
      LIVE_RELEASE_SKIP_LOCALHOST_BOOTSTRAP: "1",
      LIVE_AUTO_GRANT_RUNTIME_ROLES: "0",
      LIVE_FAIL_ON_MISSING_RUNTIME_ROLES: "1",
      LIVE_STRICT_FEE_ROUTER_GATE: "1",
      LIVE_STRICT_BLOCKS_ONLY_DATAPUSH: "1",
      LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: "1",
    },
  },
  "blocks-only-liquidation": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-blocks-only-liquidation.ts",
    description: "Runs the BNB blocks-only gate9 wrapper on top of a local fork",
    env: {
      LIVE_TEST_NETWORK: "bnbTestnet",
      LIVE_AUTO_GRANT_RUNTIME_ROLES: "0",
      LIVE_FAIL_ON_MISSING_RUNTIME_ROLES: "1",
      LIVE_STRICT_BLOCKS_ONLY_DATAPUSH: "1",
      LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: "0",
      LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS: "6",
      LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS: "1200",
    },
  },
  "blocks-only-state-machine": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-blocks-only-state-machine-layer-b.ts",
    description: "Runs the BNB blocks-only state-machine evidence wrapper on top of a local fork",
    env: {
      LIVE_TEST_NETWORK: "bnbTestnet",
      LIVE_AUTO_GRANT_RUNTIME_ROLES: "0",
      LIVE_FAIL_ON_MISSING_RUNTIME_ROLES: "1",
      LIVE_STRICT_BLOCKS_ONLY_DATAPUSH: "1",
      LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: "1",
      LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS: "6",
      LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS: "1200",
    },
  },
  "settlement-role-bridge": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-settlement-role-bridge.ts",
    description: "Verifies the SettlementManager -> ORDER_ENGINE role bridge on top of a local fork",
  },
  "shortfall-ledger": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-shortfall-ledger.ts",
    description: "Runs the BNB shortfall-ledger wrapper on top of a local fork",
  },
  "shortfall-bootstrap-guard": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-shortfall-bootstrap-guard.ts",
    description: "Verifies shortfall sync cannot bootstrap a missing OrderStateStoreV2 loan state on a local fork",
  },
  "ergm-settlement-entry-guard": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-ergm-settlement-entry-guard.ts",
    description: "Verifies ERGM settlement/default entrypoints reject non-SettlementManager callers on a local fork",
  },
  "reward-borrow-gate-rmcore": {
    file: "scripts/tests/live-test/networks/bnb-testnet/live-reward-borrow-gate-rmcore.ts",
    description: "Verifies long-term borrow gating remains bound to RewardManagerCore authority on a local fork",
  },
};

function envStr(name: string, def?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = raw.trim();
  return value.length ? value : def;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = Number(raw);
  return Number.isFinite(value) ? value : def;
}

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function nowId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

function defaultForkPort() {
  return 18000 + Math.floor(Math.random() * 1000);
}

async function rpcCall(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}`);
  }
  if (json?.error) {
    throw new Error(`RPC error: ${json.error?.message ?? JSON.stringify(json.error)}`);
  }
  return json?.result;
}

async function waitForRpc(url: string, expectedChainId: bigint, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const chainIdHex = (await rpcCall(url, "eth_chainId")) as string;
      if (BigInt(chainIdHex) === expectedChainId) {
        await rpcCall(url, "eth_blockNumber");
        return;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error(`Timed out waiting for fork node at ${url}`);
}

function startForkNode(opts: {
  host: string;
  port: number;
  forkUrl: string;
  logFile: string;
  forkBlock?: string;
}): ChildProcess {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const fd = fs.openSync(opts.logFile, "a");
  return spawn(
    pnpmBin(),
    ["-s", "exec", "hardhat", "node", "--hostname", opts.host, "--port", String(opts.port)],
    {
      env: {
        ...process.env,
        HARDHAT_FORK_URL: opts.forkUrl,
        HARDHAT_FORK_BLOCK_NUMBER: opts.forkBlock,
        DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI:
          process.env.DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI ?? "1",
      },
      stdio: ["ignore", fd, fd],
    },
  );
}

function parseCases(): CaseName[] {
  const raw = envStr(
    "BNB_FORK_AUTONODE_CASES",
    "preflight,warmup,platform-baseline,guarantee-baseline,settlement-role-bridge,reward-borrow-gate-rmcore,blocks-only-state-machine,release-gates,release-gates-layer-b"
  )!;
  const cases = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (cases.length === 0) {
    throw new Error("BNB_FORK_AUTONODE_CASES must include at least one case");
  }

  return cases.map((item) => {
    if (!(item in CASES)) {
      throw new Error(
        `unknown BNB fork case \"${item}\"; expected one of ${Object.keys(CASES).join(", ")}`,
      );
    }
    return item as CaseName;
  });
}

function runStep(label: string, args: string[], env: Record<string, string | undefined>, logFile: string) {
  const result = spawnSync(pnpmBin(), args, {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(logFile, combined, "utf8");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.log(`step=${label} log=${logFile}`);
  if (result.status !== 0) {
    throw new Error(`step failed: ${label}; log=${logFile}`);
  }
}

function sanitizeForkStepEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const sanitized = { ...env };
  const overrideKeys = [
    "SETTLEMENT_TOKEN_ADDRESS",
    "SETTLEMENT_TOKEN_SYMBOL",
    "SETTLEMENT_TOKEN_SOURCE_ID",
    "SETTLEMENT_TOKEN_COINGECKO_ID",
    "SETTLEMENT_TOKEN_DECIMALS",
    "SETTLEMENT_PRICE_VALUE",
    "BORROW_ASSET_ADDRESS",
    "BORROW_SYMBOL",
    "BORROW_SOURCE_ID",
    "BORROW_COINGECKO_ID",
    "BORROW_ASSET_DECIMALS",
    "BORROW_PRICE_VALUE",
    "COLLATERAL_ASSET_ADDRESS",
    "COLLATERAL_SYMBOL",
    "COLLATERAL_SOURCE_ID",
    "COLLATERAL_COINGECKO_ID",
    "COLLATERAL_ASSET_DECIMALS",
    "COLLATERAL_PRICE_VALUE",
  ] as const;

  for (const key of overrideKeys) {
    delete sanitized[key];
  }

  return sanitized;
}

function resolveForkUrl(): string {
  const forkUrl =
    envStr("BNB_FORK_UPSTREAM_RPC_URL") ??
    envStr("BNB_TESTNET_RPC_URL") ??
    envStr("BSC_TESTNET_RPC_URL") ??
    envStr("BSC_TESTNET_URL") ??
    envStr("BNB_TESTNET_URL");

  if (!forkUrl) {
    throw new Error(
      "missing BNB fork upstream RPC; set BNB_FORK_UPSTREAM_RPC_URL, BNB_TESTNET_RPC_URL, or BSC_TESTNET_RPC_URL",
    );
  }
  return forkUrl;
}

async function main() {
  const forkUrl = resolveForkUrl();
  const cases = parseCases();
  const profile = getLiveTestProfile('bnbTestnet');
  const host = envStr("BNB_FORK_NODE_HOST", "127.0.0.1")!;
  const port = envInt("BNB_FORK_NODE_PORT", defaultForkPort());
  const rpcUrl = `http://${host}:${port}`;
  const logDir = path.join(process.cwd(), "scripts", "tests", "logs", `bnb-live-fork-${nowId()}`);
  const nodeLog = path.join(logDir, "fork-node.log");
  const forkBlock = envStr("HARDHAT_FORK_BLOCK_NUMBER");

  fs.mkdirSync(logDir, { recursive: true });

  console.log("=== BNB Live Fork Autonode ===");
  console.log(`ForkUrl=${forkUrl}`);
  console.log(`ForkRpc=${rpcUrl}`);
  console.log(`Cases=${cases.join(",")}`);
  console.log(`Logs=${logDir}`);
  if (forkBlock) {
    console.log(`ForkBlock=${forkBlock}`);
  }

  const nodeProc = startForkNode({ host, port, forkUrl, logFile: nodeLog, forkBlock });
  let exitCode = 1;
  try {
    await waitForRpc(rpcUrl, 1337n, envInt("BNB_FORK_WAIT_MS", 90_000));
    console.log(`✅ fork node ready at ${rpcUrl}`);
    await rpcCall(rpcUrl, "evm_mine");
    console.log("✅ fork node advanced by one local block");

    const stepEnv = sanitizeForkStepEnv({
      ...process.env,
      LOCALHOST_RPC_URL: rpcUrl,
      BNB_TESTNET_RPC_URL: rpcUrl,
      BSC_TESTNET_RPC_URL: rpcUrl,
      BNB_TESTNET_URL: rpcUrl,
      BSC_TESTNET_URL: rpcUrl,
      DEPLOY_OUTPUT_FILE: process.env.DEPLOY_OUTPUT_FILE ?? profile.deployOutputFile,
      ASSETS_FILE: process.env.ASSETS_FILE ?? profile.assetsFile,
      MOCK_ASSET_PACK_OUTPUT: process.env.MOCK_ASSET_PACK_OUTPUT ?? profile.mockAssetsFile,
      BNB_LIVE_ALLOW_LOCAL_FORK: "1",
      LIVE_NETWORK_ALIAS: "bnbTestnet",
      DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI:
        process.env.DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI ?? "1",
    } as Record<string, string | undefined>);

    runStep(
      "prepare-runtime-roles",
      [
        "-s",
        "exec",
        "hardhat",
        "run",
        "scripts/tests/fork-test/networks/bnb-testnet/prepare-runtime-roles.ts",
        "--network",
        "localhost",
      ],
      stepEnv,
      path.join(logDir, "00-prepare-runtime-roles.log"),
    );

    cases.forEach((caseName, index) => {
      const stepNo = String(index + 1).padStart(2, "0");
      const config = CASES[caseName];
      console.log(`\n=== ${caseName} ===`);
      console.log(config.description);
      runStep(
        caseName,
        ["-s", "exec", "hardhat", "run", config.file, "--network", "localhost"],
        { ...stepEnv, ...(config.env ?? {}) },
        path.join(logDir, `${stepNo}-${caseName}.log`),
      );
    });

    console.log("\n✅ BNB live fork autonode PASSED\n");
    console.log(`Logs=${logDir}`);
    exitCode = 0;
  } finally {
    nodeProc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("\n❌ BNB live fork autonode FAILED\n");
  console.error(error);
  process.exit(1);
});