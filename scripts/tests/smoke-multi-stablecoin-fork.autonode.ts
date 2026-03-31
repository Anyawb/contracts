import fs from "fs";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

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

function runStep(label: string, args: string[], env: Record<string, string | undefined>, logFile: string) {
  const result = spawnSync(pnpmBin(), args, { env, encoding: "utf8" });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(logFile, combined, "utf8");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`step failed: ${label}; log=${logFile}`);
  }
}

async function main() {
  const forkUrl = envStr("ARBITRUM_SEPOLIA_RPC_URL", envStr("ARBITRUM_SEPOLIA_URL"));
  if (!forkUrl) {
    throw new Error("missing ARBITRUM_SEPOLIA_RPC_URL (or ARBITRUM_SEPOLIA_URL) for fork smoke");
  }

  const host = envStr("SMOKE_FORK_NODE_HOST", "127.0.0.1")!;
  const port = envInt("SMOKE_FORK_NODE_PORT", 18545);
  const rpcUrl = `http://${host}:${port}`;
  const logDir = path.join(process.cwd(), "scripts", "tests", "logs", `multi-stablecoin-fork-${nowId()}`);
  const nodeLog = path.join(logDir, "fork-node.log");
  const forkBlock = envStr("HARDHAT_FORK_BLOCK_NUMBER");

  fs.mkdirSync(logDir, { recursive: true });

  console.log("=== Multi-Stablecoin Fork Smoke ===");
  console.log(`ForkUrl=${forkUrl}`);
  console.log(`ForkRpc=${rpcUrl}`);
  console.log(`Logs=${logDir}`);
  if (forkBlock) {
    console.log(`ForkBlock=${forkBlock}`);
  }

  const nodeProc = startForkNode({ host, port, forkUrl, logFile: nodeLog, forkBlock });
  let exitCode = 1;
  try {
    await waitForRpc(rpcUrl, 421614n, envInt("SMOKE_FORK_WAIT_MS", 90_000));
    console.log(`✅ fork node ready at ${rpcUrl}`);

    const stepEnv = {
      ...process.env,
      LOCALHOST_RPC_URL: rpcUrl,
      DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI:
        process.env.DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI ?? "1",
    };

    runStep(
      "deploy:localhost",
      ["-s", "run", "deploy:localhost"],
      stepEnv,
      path.join(logDir, "01-deploy-localhost.log"),
    );
    runStep(
      "deploy-mock-asset-pack",
      ["-s", "exec", "hardhat", "run", "scripts/deploy/deploy-mock-asset-pack.ts", "--network", "localhost"],
      stepEnv,
      path.join(logDir, "02-deploy-mock-asset-pack.log"),
    );
    runStep(
      "multi-stablecoin-smoke",
      ["-s", "run", "test:smoke:multi-stablecoin:localhost"],
      stepEnv,
      path.join(logDir, "03-multi-stablecoin-smoke.log"),
    );

    console.log("\n✅ Multi-stablecoin fork smoke PASSED\n");
    console.log(`Logs=${logDir}`);
    exitCode = 0;
  } finally {
    nodeProc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("\n❌ Multi-stablecoin fork smoke FAILED\n");
  console.error(error);
  process.exit(1);
});