import fs from "fs";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

type StepResult = {
  status: number;
  output: string;
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
        HARDHAT_FORK_CHAIN_ID: "421614",
        HARDHAT_FORK_BLOCK_NUMBER: opts.forkBlock,
        DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI:
          process.env.DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI ?? "1",
      },
      stdio: ["ignore", fd, fd],
    },
  );
}

function runStep(label: string, args: string[], env: Record<string, string | undefined>, logFile: string): StepResult {
  const result = spawnSync(pnpmBin(), args, { env, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(logFile, output, "utf8");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.log(`step=${label} log=${logFile}`);
  return { status: result.status ?? 1, output };
}

function loadLocalPack(packFile: string) {
  return JSON.parse(fs.readFileSync(packFile, "utf8")) as {
    settlementToken: string;
  };
}

async function main() {
  const forkUrl = envStr("ARBITRUM_SEPOLIA_RPC_URL", envStr("ARBITRUM_SEPOLIA_URL"));
  if (!forkUrl) {
    throw new Error("missing ARBITRUM_SEPOLIA_RPC_URL (or ARBITRUM_SEPOLIA_URL) for fork demo");
  }

  const host = envStr("BLOCK_DEMO_FORK_NODE_HOST", "127.0.0.1")!;
  const port = envInt("BLOCK_DEMO_FORK_NODE_PORT", 19546);
  const rpcUrl = `http://${host}:${port}`;
  const collateralSymbol = envStr("COLLATERAL_SYMBOL", "RWAGOLD")!;
  const logDir = path.join(process.cwd(), "scripts", "tests", "logs", `backend-required-block-fork-${nowId()}`);
  const nodeLog = path.join(logDir, "fork-node.log");
  const forkBlock = envStr("HARDHAT_FORK_BLOCK_NUMBER");
  fs.mkdirSync(logDir, { recursive: true });

  const borrowerPk = envStr(
    "BORROWER_PRIVATE_KEY",
    "0x59c6995e998f97a5a0044966f094538e0d7d67b4d3e1f1f5e1d4a4f6f9d82b5a",
  )!;
  const lenderPk = envStr(
    "LENDER_PRIVATE_KEY",
    "0x5de4111afa1a4b94908d3b0f1f5f3c5f8d1b01b4d8c4f5f4c98f6633b457769c",
  )!;

  console.log("=== Backend-Required Missing-Price Demo (Arbitrum Sepolia fork) ===");
  console.log(`ForkUrl=${forkUrl}`);
  console.log(`ForkRpc=${rpcUrl}`);
  console.log(`Logs=${logDir}`);
  if (forkBlock) {
    console.log(`ForkBlock=${forkBlock}`);
  }

  const nodeProc = startForkNode({ host, port, forkUrl, logFile: nodeLog, forkBlock });
  let exitCode = 1;
  try {
    await waitForRpc(rpcUrl, 421614n, envInt("BLOCK_DEMO_FORK_WAIT_MS", 90_000));

    const baseEnv = {
      ...process.env,
      LOCALHOST_RPC_URL: rpcUrl,
      VIEWER_ADDRESS: "",
      DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI:
        process.env.DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI ?? "1",
    } as Record<string, string | undefined>;

    const deploy = runStep(
      "deploy:localhost",
      ["-s", "run", "deploy:localhost"],
      baseEnv,
      path.join(logDir, "01-deploy-localhost.log"),
    );
    if (deploy.status !== 0) {
      throw new Error(`deploy:localhost failed; see ${path.join(logDir, "01-deploy-localhost.log")}`);
    }

    const grant = runStep(
      "grant-required-roles-local",
      ["-s", "exec", "hardhat", "run", "scripts/tests/grant-required-roles-local.ts", "--network", "localhost"],
      baseEnv,
      path.join(logDir, "02-grant-required-roles-local.log"),
    );
    if (grant.status !== 0) {
      throw new Error(`grant-required-roles-local failed; see ${path.join(logDir, "02-grant-required-roles-local.log")}`);
    }

    const packDeploy = runStep(
      "deploy-mock-asset-pack",
      ["-s", "exec", "hardhat", "run", "scripts/deploy/deploy-mock-asset-pack.ts", "--network", "localhost"],
      baseEnv,
      path.join(logDir, "03-deploy-mock-asset-pack.log"),
    );
    if (packDeploy.status !== 0) {
      throw new Error(`deploy-mock-asset-pack failed; see ${path.join(logDir, "03-deploy-mock-asset-pack.log")}`);
    }

    const prepare = runStep(
      "prepare-backend-required-block-local",
      ["-s", "exec", "hardhat", "run", "scripts/tests/live-test/networks/arbitrum-sepolia/cases/prepare-backend-required-block-local.ts", "--network", "localhost"],
      { ...baseEnv, COLLATERAL_SYMBOL: collateralSymbol },
      path.join(logDir, "04-prepare-backend-required-block-local.log"),
    );
    if (prepare.status !== 0) {
      throw new Error(`prepare-backend-required-block-local failed; see ${path.join(logDir, "04-prepare-backend-required-block-local.log")}`);
    }

    const pack = loadLocalPack(path.join(process.cwd(), "deployments", "mock-assets.localhost.json"));
    const warmup = runStep(
      "live-warmup-backend-required",
      ["-s", "exec", "hardhat", "run", "scripts/tests/live-test/networks/arbitrum-sepolia/live-warmup.ts", "--network", "localhost"],
      {
        ...baseEnv,
        LIVE_PRICE_MODE: "backend-required",
        COLLATERAL_SYMBOL: collateralSymbol,
        SETTLEMENT_TOKEN_ADDRESS: pack.settlementToken,
        BORROWER_PRIVATE_KEY: borrowerPk,
        LENDER_PRIVATE_KEY: lenderPk,
        PRIME_VIEW_CACHE: "0",
      },
      path.join(logDir, "05-live-warmup-backend-required.log"),
    );

    if (warmup.status === 0) {
      throw new Error("expected backend-required warmup to fail on missing final price, but it succeeded");
    }
    if (!warmup.output.includes("LIVE_PRICE_MODE=backend-required blocks automatic bootstrap publication")) {
      throw new Error(
        `warmup failed for an unexpected reason; see ${path.join(logDir, "05-live-warmup-backend-required.log")}`,
      );
    }

    console.log("✅ backend-required missing-price block reproduced on Arbitrum Sepolia fork");
    console.log(`Log=${path.join(logDir, "05-live-warmup-backend-required.log")}`);
    exitCode = 0;
  } finally {
    nodeProc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("\n❌ backend-required-block-fork.autonode FAILED\n");
  console.error(error);
  process.exit(1);
});