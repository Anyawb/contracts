import fs from "fs";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

type StepResult = {
  status: number;
  output: string;
};

// 这个 autonode 脚本会启动一条临时 localhost 链，
// 然后复现“backend-required 模式下，缺最终价格会阻断 warmup”的完整演示链路。
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

// 轮询本地节点是否已就绪，避免部署脚本在 RPC 未开放时抢跑。
async function waitForRpc(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (response.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for hardhat node at ${url}`);
}

// fresh localhost 模式下直接起一个全新 hardhat node，与现有会话隔离。
function startNode(host: string, port: number): ChildProcess {
  return spawn(
    pnpmBin(),
    ["-s", "exec", "hardhat", "node", "--hostname", host, "--port", String(port)],
    {
      stdio: "inherit",
      env: { ...process.env, HARDHAT_NETWORK: "hardhat" },
    },
  );
}

// 每一步都同步执行并写入独立日志，方便失败后逐步回放。
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
  const host = envStr("BLOCK_DEMO_NODE_HOST", "127.0.0.1")!;
  const port = envInt("BLOCK_DEMO_NODE_PORT", 19545);
  const rpcUrl = `http://${host}:${port}`;
  const collateralSymbol = envStr("COLLATERAL_SYMBOL", "RWAGOLD")!;
  const logDir = path.join(process.cwd(), "scripts", "tests", "logs", `backend-required-block-${nowId()}`);
  fs.mkdirSync(logDir, { recursive: true });

  const borrowerPk = envStr(
    "BORROWER_PRIVATE_KEY",
    "0x59c6995e998f97a5a0044966f094538e0d7d67b4d3e1f1f5e1d4a4f6f9d82b5a",
  )!;
  const lenderPk = envStr(
    "LENDER_PRIVATE_KEY",
    "0x5de4111afa1a4b94908d3b0f1f5f3c5f8d1b01b4d8c4f5f4c98f6633b457769c",
  )!;

  console.log("=== Backend-Required Missing-Price Demo (fresh localhost) ===");
  console.log(`Rpc=${rpcUrl}`);
  console.log(`Logs=${logDir}`);

  const nodeProc = startNode(host, port);
  let exitCode = 1;
  try {
    await waitForRpc(rpcUrl, envInt("BLOCK_DEMO_WAIT_MS", 20_000));

    // 顺序不能乱：部署 -> 授权 -> 部署 mock 资产 -> 准备缺价环境 -> 验证 warmup 被阻断。
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
    // 不仅要失败，还要确认失败原因就是 backend-required 的价格阻断，而不是其他环境异常。
    if (!warmup.output.includes("LIVE_PRICE_MODE=backend-required blocks automatic bootstrap publication")) {
      throw new Error(
        `warmup failed for an unexpected reason; see ${path.join(logDir, "05-live-warmup-backend-required.log")}`,
      );
    }

    console.log("✅ backend-required missing-price block reproduced as expected");
    console.log(`Log=${path.join(logDir, "05-live-warmup-backend-required.log")}`);
    exitCode = 0;
  } finally {
    nodeProc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("\n❌ backend-required-block-local.autonode FAILED\n");
  console.error(error);
  process.exit(1);
});