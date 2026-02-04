import { spawn } from "child_process";

function envStr(name: string, def?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const v = raw.trim();
  return v.length ? v : def;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function waitForRpc(url: string, timeoutMs: number) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // ignore and retry
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for hardhat node RPC at ${url}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const host = envStr("SMOKE_NODE_HOST", "127.0.0.1")!;
  const port = envInt("SMOKE_NODE_PORT", 18545);
  const rpcUrl = `http://${host}:${port}`;

  const cmd = pnpmBin();
  const nodeArgs = ["-s", "exec", "hardhat", "node", "--hostname", host, "--port", String(port)];
  console.log("=== Smoke runner (ephemeral fresh node) ===");
  console.log(`  node: ${cmd} ${nodeArgs.join(" ")}`);

  const nodeProc = spawn(cmd, nodeArgs, {
    stdio: "inherit",
    env: { ...process.env, HARDHAT_NETWORK: "hardhat" },
  });

  let exitCode = 1;
  try {
    await waitForRpc(rpcUrl, envInt("SMOKE_NODE_WAIT_MS", 15_000));
    console.log(`  ✅ hardhat node ready at ${rpcUrl}`);

    const runnerArgs = ["-s", "exec", "hardhat", "run", "scripts/tests/smoke-productionlike-local.ts", "--network", "localhost"];
    console.log(`  runner: ${cmd} ${runnerArgs.join(" ")}`);

    // Force the child hardhat processes to talk to our ephemeral node.
    const env = {
      ...process.env,
      LOCALHOST_RPC_URL: rpcUrl,
      MODE: process.env.MODE ?? "fresh",
      RUN_DEPLOY: process.env.RUN_DEPLOY ?? "1",
      RUN_GRANT: process.env.RUN_GRANT ?? "1",
      RUN_PRECONFIG: process.env.RUN_PRECONFIG ?? "1",
    };

    const runner = spawn(cmd, runnerArgs, { stdio: "inherit", env });
    exitCode = await new Promise<number>((resolve) => {
      runner.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    nodeProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error("\n❌ Ephemeral-node smoke runner FAILED\n");
  console.error(e);
  process.exit(1);
});

