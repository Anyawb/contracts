import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Interface, id } from "ethers";

const E2E_DIR = path.join(__dirname, "..");
const LOG_ROOT = path.join(E2E_DIR, "logs");
const RUN_ALL = path.join(E2E_DIR, "tools", "run-all-e2e.ts");
const RUN_GOLDEN = path.join(E2E_DIR, "tools", "run-release-golden.ts");
const DETAILS = path.join(E2E_DIR, "tools", "quantify-latest-e2e-details.ts");
const BATCH_QUANT = path.join(E2E_DIR, "quantify-latest-batch-artifacts.ts");
const AUDIT = path.join(E2E_DIR, "tools", "audit-latest-deep-dive.ts");
const STRESS = path.join(E2E_DIR, "e2e-localhost-price-liquidation-stress.ts");
const DEPLOY_MOCK_ASSET_PACK = path.join(__dirname, "..", "..", "deploy", "deploy-mock-asset-pack.ts");
const GRANT_REQUIRED_ROLES_LOCAL = path.join(
  __dirname,
  "..",
  "..",
  "tests",
  "grant-required-roles-local.ts"
);
const DEPLOY_OUTPUT_LOCALHOST = path.join(__dirname, "..", "..", "deployments", "localhost.json");

// Live-chain deploy + smoke scripts live under scripts/* (outside scripts/e2e).
const DEPLOY_ARB_SEPOLIA = path.join(__dirname, "..", "..", "deploy", "deploy-arbitrum-sepolia.ts");
const SEED_MOCK_ASSET_PRICES_ARB_SEPOLIA = path.join(
  __dirname,
  "..",
  "..",
  "deploy",
  "seed-mock-asset-prices.ts"
);
const LIVE_PREFLIGHT_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "tests",
  "live-test",
  "live-preflight-arbitrum-sepolia.ts"
);
const LIVE_PRIME_VIEWCACHE_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "tests",
  "live-test",
  "live-prime-viewcache-arbitrum-sepolia.ts"
);

const REGISTRY_READ_IFACE = new Interface([
  "function getModuleOrRevert(bytes32) view returns (address)",
]);

const LIVE_BASE_SMOKE_SCRIPTS = [
  path.join(__dirname, "..", "..", "tests", "whitelist-registry-smoke-local.ts"),
  path.join(__dirname, "..", "..", "tests", "view-schemeu-smoke-local.ts"),
  path.join(__dirname, "..", "..", "tests", "viewcache-smoke-local.ts"),
  path.join(__dirname, "..", "..", "tests", "lendingengine-smoke-local.ts"),
  path.join(__dirname, "..", "e2e-localhost-rewardview-acceptance.ts"),
  path.join(__dirname, "..", "e2e-localhost-rewardspend-acceptance.ts"),
  path.join(__dirname, "..", "..", "tests", "live-test", "live-read-pressure.ts"),
];

const LIVE_REWARD_SMOKE_SCRIPTS = [path.join(__dirname, "..", "..", "tests", "reward-smoke-local.ts")];

const LIVE_FUNDS_FLOW_SMOKE_SCRIPTS = [
  path.join(__dirname, "..", "..", "tests", "funds-flow-smoke-create-order.ts"),
  path.join(__dirname, "..", "..", "tests", "funds-flow-smoke-conservation.ts"),
  path.join(__dirname, "..", "..", "tests", "funds-flow-smoke-local.ts"),
  path.join(__dirname, "..", "..", "tests", "funds-flow-invariants-suite.ts"),
];

const LIVE_SMOKE_SCRIPTS = [
  ...LIVE_BASE_SMOKE_SCRIPTS,
  ...LIVE_REWARD_SMOKE_SCRIPTS,
  ...LIVE_FUNDS_FLOW_SMOKE_SCRIPTS,
];

const CORE_E2E_SCRIPTS = [
  path.join(E2E_DIR, "e2e-localhost-batch-10-users.ts"),
  path.join(E2E_DIR, "e2e-localhost-batch-advanced-10-users.ts"),
  path.join(E2E_DIR, "e2e-localhost-liquidation-reward-penalty.ts"),
  path.join(E2E_DIR, "e2e-localhost-price-liquidation-stress.ts"),
  path.join(E2E_DIR, "e2e-localhost-rewardmanager-governance.ts"),
];

const DEFAULT_ARB_SEPOLIA_FORK_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const DEFAULT_ARB_SEPOLIA_STABLE_FORK_BLOCK = "249385415";
const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function setDefault(env: Record<string, string | undefined>, key: string, value: string) {
  if (!env[key]) env[key] = value;
}

function shouldSkipDeploy(env: Record<string, string | undefined>) {
  const freshDeploy = (env.FRESH_DEPLOY ?? "").trim() === "1";
  return !freshDeploy && (
    hasFlag("--skip-deploy") ||
    hasFlag("--live-skip-deploy") ||
    (env.LIVE_SKIP_DEPLOY ?? "").trim() === "1"
  );
}

class StepFailed extends Error {
  status: number;
  detail?: string;
  constructor(label: string, status: number, detail?: string) {
    super(`Step failed: ${label}`);
    this.status = status;
    this.detail = detail;
  }
}

function runStep(label: string, cmd: string, args: string[], env?: Record<string, string | undefined>) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(cmd, args, { env: env ?? process.env, encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.status !== 0) {
    throw new StepFailed(label, result.status ?? 1, tailLines(`${stdout}${stderr}`, 160));
  }
}

function nowId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

function resolveArbSepoliaDeployOutputFile(env: Record<string, string | undefined>): string {
  const explicit = env.DEPLOY_OUTPUT_FILE?.trim();
  if (!explicit) {
    return path.join(__dirname, "..", "..", "deployments", "arbitrum-sepolia.json");
  }
  return path.isAbsolute(explicit)
    ? explicit
    : path.resolve(__dirname, "..", "..", "deployments", explicit);
}

type MockAssetPackEntry = {
  address?: string;
  decimals?: number;
  settlementToken?: boolean;
};

type MockAssetPackFile = {
  settlementToken?: string;
  assets?: MockAssetPackEntry[];
};

function resolveArbSepoliaMockAssetsFile(env: Record<string, string | undefined>): string {
  const explicit = env.ASSETS_FILE?.trim();
  if (!explicit) {
    return path.join(__dirname, "..", "..", "..", "deployments", "assets.arbitrum-sepolia.mock.json");
  }
  return path.isAbsolute(explicit)
    ? explicit
    : path.resolve(process.cwd(), explicit);
}

function resolveArbSepoliaMockPackFile(env: Record<string, string | undefined>): string {
  const explicit = env.MOCK_ASSET_PACK_OUTPUT?.trim();
  if (!explicit) {
    return path.join(__dirname, "..", "..", "..", "deployments", "mock-assets.arbitrum-sepolia.json");
  }
  return path.isAbsolute(explicit)
    ? explicit
    : path.resolve(process.cwd(), explicit);
}

function maybeConfigureLiveMockAssetPack(env: Record<string, string | undefined>) {
  const deployOutputName = (env.DEPLOY_OUTPUT_FILE ?? "").toLowerCase();
  const explicitMockMode = env.LIVE_USE_MOCK_ASSET_PACK === "1";
  const deployOutputLooksMock = deployOutputName.includes("mock");
  const assetsFileLooksMock = (env.ASSETS_FILE ?? "").toLowerCase().includes(".mock.");
  const requested =
    explicitMockMode ||
    deployOutputLooksMock ||
    assetsFileLooksMock ||
    Boolean(env.MOCK_ASSET_PACK_OUTPUT?.trim());

  if (!requested) return;

  const assetsFile = resolveArbSepoliaMockAssetsFile(env);
  const packFile = resolveArbSepoliaMockPackFile(env);

  if (!fs.existsSync(assetsFile)) {
    throw new Error(
      `[Live] mock-suite asset alignment requested but assets file is missing: ${assetsFile}`
    );
  }
  if (!fs.existsSync(packFile)) {
    throw new Error(
      `[Live] mock-suite asset alignment requested but mock asset pack output is missing: ${packFile}`
    );
  }

  const pack = JSON.parse(fs.readFileSync(packFile, "utf8")) as MockAssetPackFile;
  const settlementToken = (pack.settlementToken ?? "").trim();
  if (!settlementToken) {
    throw new Error(`[Live] mock asset pack does not declare settlementToken: ${packFile}`);
  }

  const settlementAsset = (pack.assets ?? []).find((asset) => {
    const assetAddress = (asset.address ?? "").toLowerCase();
    return assetAddress === settlementToken.toLowerCase() || asset.settlementToken === true;
  });
  const settlementDecimals = settlementAsset?.decimals;
  if (!Number.isFinite(settlementDecimals)) {
    throw new Error(
      `[Live] could not resolve settlement token decimals from mock asset pack: ${packFile}`
    );
  }

  env.ASSETS_FILE = assetsFile;
  env.MOCK_ASSET_PACK_OUTPUT = packFile;
  env.SETTLEMENT_TOKEN_ADDRESS = settlementToken;
  env.SETTLEMENT_TOKEN_DECIMALS = String(settlementDecimals);

  if (deployOutputLooksMock && !env.FRESH_DEPLOY && !env.LIVE_SKIP_DEPLOY) {
    env.LIVE_SKIP_DEPLOY = "1";
    console.log("[Live] Mock-suite deploy output detected; defaulting LIVE_SKIP_DEPLOY=1 to revalidate the existing mock-suite deployment.");
    console.log("[Live] Set FRESH_DEPLOY=1 explicitly if you need a full redeploy instead of reusing the current proxies.");
  }

  console.log("[Live] Mock asset pack alignment enabled:");
  console.log(`        ASSETS_FILE=${assetsFile}`);
  console.log(`        MOCK_ASSET_PACK_OUTPUT=${packFile}`);
  console.log(`        SETTLEMENT_TOKEN_ADDRESS=${settlementToken}`);
  console.log(`        SETTLEMENT_TOKEN_DECIMALS=${settlementDecimals}`);
}

function shouldPrimeLiveMockViewCache(env: Record<string, string | undefined>) {
  const explicit = (env.LIVE_PRIME_VIEWCACHE ?? "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  if (explicit === "1" || explicit === "true" || explicit === "on") return true;

  const deployOutputName = (env.DEPLOY_OUTPUT_FILE ?? "").toLowerCase();
  const assetsFileLooksMock = (env.ASSETS_FILE ?? "").toLowerCase().includes(".mock.");
  return env.LIVE_USE_MOCK_ASSET_PACK === "1" || deployOutputName.includes("mock") || assetsFileLooksMock;
}

function getLivePriceMode(env: Record<string, string | undefined>) {
  const raw = (env.LIVE_PRICE_MODE ?? "bootstrap").trim().toLowerCase();
  if (raw === "bootstrap" || raw === "backend-required") return raw;
  throw new Error(`[Live] unsupported LIVE_PRICE_MODE=${raw}. expected bootstrap or backend-required.`);
}

function shouldSeedLiveMockPrices(env: Record<string, string | undefined>) {
  if (!shouldPrimeLiveMockViewCache(env)) return false;

  const explicit = (env.LIVE_PRIME_PRICES ?? "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  if (explicit === "1" || explicit === "true" || explicit === "on") return true;

  const livePriceMode = getLivePriceMode(env);
  if (livePriceMode === "bootstrap") return true;

  return env.FORCE_PRICE_UPDATE === "1";
}

function tailLines(s: string, maxLines: number): string {
  const lines = s.split(/\r?\n/);
  if (lines.length <= maxLines) return s;
  return lines.slice(lines.length - maxLines).join("\n");
}

function classifyFailure(output: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  const o = output.toLowerCase();
  if (o.includes("econnrefused")) push("RPC 连接失败（节点未启动 / 端口不通 / fork 进程崩溃）");
  if (o.includes("missing trie node")) push("Fork RPC 历史状态缺失（missing trie node）；更换/付费 RPC 或固定 fork block");
  if (o.includes("insufficient funds") || o.includes("not enough funds")) push("账户余额不足（真实链部署/写入会失败）");
  if (o.includes("missingrole") || o.includes("missing role")) push("权限缺失（MissingRole）；需要先配置/授予角色或切换到 fork/local 环境");
  if (o.includes("function selector was not recognized")) push("ABI/部署不一致（selector 不匹配）；可能是地址文件/合约版本错位");
  if (o.includes("hardhat_impersonateaccount") || o.includes("hardhat_setbalance")) {
    push("脚本依赖 Hardhat 专用 RPC（impersonate/setBalance）；只能在 localhost/fork 跑");
  }
  if (o.includes("hardhat_mine") || o.includes("evm_snapshot") || o.includes("evm_revert")) {
    push("脚本依赖 Hardhat 专用 RPC（mine/snapshot）；只能在 localhost/fork 跑");
  }
  if (o.includes("hh604")) push("Hardhat/EDR fork reset 限制（HH604）；应使用 env forking 启动 node（本仓库已做 workaround）");
  if (out.length === 0) push("未知/未分类（请看日志末尾与完整 log 文件）");
  return out;
}

function runHardhatScriptWithLog(opts: {
  label: string;
  scriptPath: string;
  network: string;
  env: Record<string, string | undefined>;
  logDir: string;
}) {
  console.log(`\n== ${opts.label} ==`);
  fs.mkdirSync(opts.logDir, { recursive: true });
  const base = path.basename(opts.scriptPath).replace(/\.ts$/, "");
  const logFile = path.join(opts.logDir, `${base}.log`);

  const result = spawnSync(
    "pnpm",
    ["-s", "exec", "hardhat", "run", opts.scriptPath, "--network", opts.network],
    { env: opts.env, encoding: "utf8" }
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}${stderr}`;
  fs.writeFileSync(logFile, combined, "utf8");

  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (result.status !== 0) {
    console.error(`\n❌ Step failed: ${opts.label}`);
    console.error(`Log: ${logFile}`);
    const reasons = classifyFailure(combined);
    console.error("Likely cause(s):");
    for (const r of reasons) console.error(`- ${r}`);
    console.error("\n--- last 120 lines (combined) ---");
    console.error(tailLines(combined, 120));
    console.error("--- end ---\n");
    throw new StepFailed(opts.label, result.status ?? 1);
  }
}

function prewarmMockAssetPack(label: string, env: Record<string, string | undefined>) {
  runStep(
    label,
    "pnpm",
    ["-s", "exec", "hardhat", "run", DEPLOY_MOCK_ASSET_PACK, "--network", "localhost"],
    env,
  );
}

async function rpcCall(url: string, method: string, params: unknown[] = []): Promise<any> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
  if (json?.error) throw new Error(`RPC error: ${json.error?.message ?? JSON.stringify(json.error)}`);
  return json?.result;
}

async function pickForkBlockNumber(forkUrl: string): Promise<bigint> {
  const hex = (await rpcCall(forkUrl, "eth_blockNumber")) as string;
  return BigInt(hex);
}

async function waitForRpcReady(opts: { url: string; expectChainId: bigint; timeoutMs: number }) {
  const started = Date.now();
  while (Date.now() - started < opts.timeoutMs) {
    try {
      const chainIdHex = (await rpcCall(opts.url, "eth_chainId")) as string;
      const chainId = BigInt(chainIdHex);
      if (chainId !== opts.expectChainId) {
        throw new Error(`unexpected chainId=${chainId} expect=${opts.expectChainId}`);
      }
      await rpcCall(opts.url, "eth_blockNumber");
      return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`RPC not ready after ${opts.timeoutMs}ms: ${opts.url}`);
}

function startHardhatForkNode(opts: {
  forkUrl: string;
  host: string;
  port: number;
  logFile: string;
}): ChildProcess {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const fd = fs.openSync(opts.logFile, "a");

  // Important: do NOT pass `--fork` here.
  // `hardhat node --fork <url>` triggers a `hardhat_reset` at startup, and the
  // EDR backend currently errors in that path with HH604 (storage overrides on
  // forked blocks). Instead we configure `networks.hardhat.forking` via env
  // vars (see hardhat.config.ts) so the provider starts already forked.
  const childEnv = {
    ...process.env,
    HARDHAT_FORK_URL: opts.forkUrl,
    HARDHAT_FORK_CHAIN_ID: "421614",
    // Hardhat uses undici's `headersTimeout` for upstream JSON-RPC calls.
    // Some RPCs can intermittently take >35s to respond with headers, which
    // causes flaky `UND_ERR_HEADERS_TIMEOUT` failures during forked E2E runs.
    // Setting this env var makes Hardhat set `headersTimeout = 0` (disabled).
    // This mirrors Hardhat's own CI workaround.
    DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI:
      process.env.DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI ?? "1",
  };

  const child = spawn(
    "pnpm",
    [
      "-s",
      "exec",
      "hardhat",
      "node",
      "--hostname",
      opts.host,
      "--port",
      String(opts.port),
    ],
    {
      env: childEnv,
      stdio: ["ignore", fd, fd],
    }
  );
  child.unref();
  return child;
}

function stopChild(child: ChildProcess | null | undefined) {
  if (!child) return;
  try {
    child.kill("SIGINT");
  } catch {
    // ignore
  }
}

async function ensureForkRpcHealthy(opts: {
  url: string;
  expectChainId: bigint;
  timeoutMs: number;
  onUnhealthy: () => Promise<void>;
}) {
  try {
    await waitForRpcReady({ url: opts.url, expectChainId: opts.expectChainId, timeoutMs: opts.timeoutMs });
  } catch {
    await opts.onUnhealthy();
    await waitForRpcReady({ url: opts.url, expectChainId: opts.expectChainId, timeoutMs: 90_000 });
  }
}

function isForkInfraFailure(err: unknown): boolean {
  const raw =
    err instanceof StepFailed
      ? `${err.message}\n${err.detail ?? ""}`
      : err instanceof Error
        ? `${err.message}\n${String((err as { cause?: unknown }).cause ?? "")}`
        : String(err);
  const lower = raw.toLowerCase();
  return (
    lower.includes("econnrefused") ||
    lower.includes("cannot connect to the network localhost") ||
    lower.includes("rpc not ready") ||
    lower.includes("missing trie node") ||
    lower.includes("other side closed") ||
    lower.includes("und_err_socket") ||
    lower.includes("fatal external error")
  );
}

function latestRunManifestPath(): string | null {
  try {
    const dirs = fs
      .readdirSync(LOG_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("e2e-run-"))
      .map((d) => d.name)
      .sort();
    if (dirs.length === 0) return null;
    return path.join(LOG_ROOT, dirs[dirs.length - 1], "manifest.json");
  } catch {
    return null;
  }
}

function latestRunLooksLikeForkInfraFailure(): boolean {
  const manifestPath = latestRunManifestPath();
  if (!manifestPath || !fs.existsSync(manifestPath)) return false;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      scripts?: Array<{ exitCode: number | null; logFile: string }>;
    };
    const failed = (manifest.scripts ?? []).filter((row) => row.exitCode !== 0);
    if (failed.length === 0) return false;

    let infraMatches = 0;
    for (const row of failed) {
      if (!row.logFile || !fs.existsSync(row.logFile)) continue;
      const lower = fs.readFileSync(row.logFile, "utf8").toLowerCase();
      if (
        lower.includes("econnrefused") ||
        lower.includes("cannot connect to the network localhost") ||
        lower.includes("rpc not ready") ||
        lower.includes("missing trie node") ||
        lower.includes("other side closed") ||
        lower.includes("und_err_socket") ||
        lower.includes("fatal external error")
      ) {
        infraMatches++;
      }
    }

    return infraMatches > 0;
  } catch {
    return false;
  }
}

function tryLoadDeployOutputMap(filePath: string): Record<string, string> | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(json)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed.startsWith("0x")) continue;
      out[key] = trimmed;
    }
    return out;
  } catch {
    return undefined;
  }
}

function tryLoadRegistryFromDeployOutput(filePath: string): string {
  const json = tryLoadDeployOutputMap(filePath);
  const addr = json?.Registry ?? "";
  return addr && addr.startsWith("0x") ? addr : "";
}

async function validateLiveSkipDeployBaseline(opts: {
  rpcUrl: string;
  deployOutputPath: string;
  expectedChainId: bigint;
  requiredRegistryModules?: string[];
}): Promise<string> {
  const regAddr = tryLoadRegistryFromDeployOutput(opts.deployOutputPath);
  if (!regAddr) {
    throw new Error(
      `[Live] --skip-deploy baseline invalid: ${opts.deployOutputPath} does not contain a readable Registry address. ` +
        `Current deploy output is not a valid Arbitrum Sepolia live deployment result; run without --skip-deploy first.`
    );
  }

  const chainIdHex = (await rpcCall(opts.rpcUrl, "eth_chainId")) as string;
  const chainId = BigInt(chainIdHex);
  if (chainId !== opts.expectedChainId) {
    throw new Error(
      `[Live] --skip-deploy baseline invalid: RPC chainId=${chainId} (expected ${opts.expectedChainId}). ` +
        `Current deploy output is not being checked against Arbitrum Sepolia; run without --skip-deploy first.`
    );
  }

  const code = ((await rpcCall(opts.rpcUrl, "eth_getCode", [regAddr, "latest"])) as string) ?? "0x";
  if (code === "0x") {
    throw new Error(
      `[Live] --skip-deploy baseline invalid: Registry ${regAddr} from ${opts.deployOutputPath} has no code on Arbitrum Sepolia. ` +
        `Current deploy output is not a valid Arbitrum Sepolia live deployment result; run without --skip-deploy first.`
    );
  }

  for (const moduleName of opts.requiredRegistryModules ?? []) {
    const moduleAddr = await rpcReadRegistryModule(opts.rpcUrl, regAddr, moduleName);
    const moduleCode = ((await rpcCall(opts.rpcUrl, "eth_getCode", [moduleAddr, "latest"])) as string) ?? "0x";
    if (moduleCode === "0x") {
      throw new Error(
        `[Live] --skip-deploy baseline invalid: Registry ${regAddr} resolves ${moduleName}=${moduleAddr}, but that address has no code on Arbitrum Sepolia. ` +
          `Current deploy output is stale or partially deployed; run without --skip-deploy first.`
      );
    }
  }

  return regAddr;
}

async function rpcReadRegistryModule(rpcUrl: string, registryAddr: string, moduleName: string): Promise<string> {
  const data = REGISTRY_READ_IFACE.encodeFunctionData("getModuleOrRevert", [id(moduleName)]);
  let raw: string;
  try {
    raw = (await rpcCall(rpcUrl, "eth_call", [{ to: registryAddr, data }, "latest"])) as string;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[Live] --skip-deploy baseline invalid: Registry ${registryAddr} cannot resolve ${moduleName}. ` +
        `eth_call(getModuleOrRevert) reverted: ${reason}`
    );
  }

  try {
    const decoded = REGISTRY_READ_IFACE.decodeFunctionResult("getModuleOrRevert", raw);
    const moduleAddr = decoded[0] as string;
    return moduleAddr;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[Live] --skip-deploy baseline invalid: Registry ${registryAddr} returned unreadable data for ${moduleName}. ` +
        `decode(getModuleOrRevert) failed: ${reason}`
    );
  }
}

async function validateLocalhostBaselineReady(opts: {
  rpcUrl: string;
  deployOutputPath: string;
}): Promise<string> {
  const regAddr = tryLoadRegistryFromDeployOutput(opts.deployOutputPath);
  if (!regAddr) {
    throw new Error(
      `[Localhost] Missing deployment baseline: ${opts.deployOutputPath} does not contain a readable Registry address. ` +
        `Run a fresh localhost bootstrap first: pnpm -s run deploy:localhost && ` +
        `pnpm -s exec hardhat run scripts/tests/grant-required-roles-local.ts --network localhost`
    );
  }

  const code = ((await rpcCall(opts.rpcUrl, "eth_getCode", [regAddr, "latest"])) as string) ?? "0x";
  if (code === "0x") {
    throw new Error(
      [
        `[Localhost] Registry ${regAddr} from ${opts.deployOutputPath} has no bytecode at ${opts.rpcUrl}.`,
        `e2e:pre-release:localhost does NOT auto-run deploy:localhost or localhost role bootstrap.`,
        `Correct sequence on a fresh node:`,
        `1. pnpm -s run node`,
        `2. LOCALHOST_RPC_URL=${opts.rpcUrl} pnpm -s run deploy:localhost`,
        `3. LOCALHOST_RPC_URL=${opts.rpcUrl} pnpm -s exec hardhat run scripts/tests/grant-required-roles-local.ts --network localhost`,
        `4. LOCALHOST_RPC_URL=${opts.rpcUrl} pnpm -s run e2e:pre-release:localhost`,
      ].join("\n")
    );
  }

  return regAddr;
}

function main() {
  const arbitrumSepoliaLive = hasFlag("--arbitrum-sepolia-live");
  const network = arbitrumSepoliaLive ? "arbitrumSepolia" : getArg("--network") ?? "localhost";
  const forkArbSepolia = hasFlag("--fork-arbitrum-sepolia");
  const rpcUrlFromArgs = getArg("--rpc") ?? process.env.LOCALHOST_RPC_URL ?? "";

  const requireCoreE2e = !hasFlag("--skip-core-e2e");

  if (arbitrumSepoliaLive && forkArbSepolia) {
    throw new Error("Invalid flags: --arbitrum-sepolia-live and --fork-arbitrum-sepolia are mutually exclusive.");
  }

  const skipCompile = hasFlag("--skip-compile");
  const skipInvariant = hasFlag("--skip-invariant");
  const skipGolden = hasFlag("--skip-golden");
  const skipFull = hasFlag("--skip-full");
  const skipReports = hasFlag("--skip-reports");
  const skipAudit = hasFlag("--skip-audit");
  const skipStress = hasFlag("--skip-stress");

  const env = { ...process.env } as Record<string, string | undefined>;
  setDefault(env, "E2E_STRICT_VIEWS", "1");
  setDefault(env, "E2E_VIEW_STRICT", "1");
  setDefault(env, "E2E_STRICT_DATAPUSH", "1");
  setDefault(env, "E2E_STRICT_REWARD", "1");

  let forkNode: ChildProcess | null = null;
  let forkNodeConfig:
    | {
        forkUrl: string;
        host: string;
        port: number;
      }
    | null = null;
  let forkLocalRpcUrl = "";
  const cleanup = () => stopChild(forkNode);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);

  // In fork mode we own the node lifecycle.
  // Otherwise we honor --rpc / LOCALHOST_RPC_URL.
  const effectiveRpcUrl = forkArbSepolia || arbitrumSepoliaLive ? "" : rpcUrlFromArgs;
  if (effectiveRpcUrl) env.LOCALHOST_RPC_URL = effectiveRpcUrl;

  const run = async () => {
    const restartForkNodeAndRedeploy = async (reason: string) => {
      if (!forkNodeConfig) throw new Error(`[Fork] Cannot restart fork node: missing config. Reason: ${reason}`);
      console.warn(`[Fork] ${reason}; restarting fork node at block ${process.env.HARDHAT_FORK_BLOCK_NUMBER ?? env.HARDHAT_FORK_BLOCK_NUMBER ?? DEFAULT_ARB_SEPOLIA_STABLE_FORK_BLOCK}.`);
      stopChild(forkNode);
      const runId = new Date().toISOString().replace(/[-:TZ.]/g, "");
      const logFile = path.join(E2E_DIR, "logs", `fork-node-${runId}.log`);
      forkNode = startHardhatForkNode({
        forkUrl: forkNodeConfig.forkUrl,
        host: forkNodeConfig.host,
        port: forkNodeConfig.port,
        logFile,
      });
      await waitForRpcReady({ url: forkLocalRpcUrl, expectChainId: 421614n, timeoutMs: 90_000 });
      env.LOCALHOST_RPC_URL = forkLocalRpcUrl;
      runStep("Deploy (fork restart)", "pnpm", ["-s", "run", "deploy:localhost"], env);
      runStep(
        "Grant Required Roles (fork restart)",
        "pnpm",
        ["-s", "exec", "hardhat", "run", GRANT_REQUIRED_ROLES_LOCAL, "--network", "localhost"],
        env
      );
      prewarmMockAssetPack("Prewarm Mock Asset Pack (fork restart)", env);
    };

    const runForkStepWithRecovery = async (label: string, action: () => void | Promise<void>) => {
      try {
        await action();
      } catch (err) {
        const infraFailure = isForkInfraFailure(err) || latestRunLooksLikeForkInfraFailure();
        if (!forkArbSepolia || !forkNodeConfig || !infraFailure) {
          throw err;
        }
        await restartForkNodeAndRedeploy(`${label} failed due to fork infrastructure instability`);
        await action();
      }
    };

    if (arbitrumSepoliaLive) {
      const deployOutputArbSepolia = resolveArbSepoliaDeployOutputFile(env);
      setDefault(env, "ARBITRUM_SEPOLIA_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc");
      setDefault(env, "ARBITRUM_SEPOLIA_URL", env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc");
      maybeConfigureLiveMockAssetPack(env);
      const skipDeploy = shouldSkipDeploy(env);

      console.log("\n== Live Mode (Arbitrum Sepolia) ==");
      console.log("network: arbitrumSepolia");
      console.log(
        skipDeploy
          ? "mode: revalidate existing mock-suite deployment + live preflight + expanded live-safe smoke gate (base view checks + reward read-only + funds-flow read-only + read pressure)"
          : "mode: deploy + live preflight + expanded live-safe smoke gate (base view checks + reward read-only + funds-flow read-only + read pressure)"
      );

      if (requireCoreE2e) {
        console.log(
          "[Live] Core localhost E2E remain fork-only and are not executed here; live mode runs the default live-safe subset instead."
        );
      }

      if (!skipDeploy) {
        // Deploy/upgrade on live chain (idempotent; uses scripts/deployments/arbitrum-sepolia.json).
        runStep(
          "Deploy (arbitrumSepolia live)",
          "pnpm",
          ["-s", "exec", "hardhat", "run", DEPLOY_ARB_SEPOLIA, "--network", "arbitrumSepolia"],
          env
        );
      } else {
        console.log("\n== Deploy (skipped) ==");
        console.log("[Live] --skip-deploy set; validating existing deployments only.");

        const rpcUrl = env.ARBITRUM_SEPOLIA_RPC_URL ?? env.ARBITRUM_SEPOLIA_URL;
        if (!rpcUrl) {
          throw new Error(
            "[Live] --skip-deploy requires ARBITRUM_SEPOLIA_RPC_URL or ARBITRUM_SEPOLIA_URL so the existing deploy output can be validated."
          );
        }

        const validatedRegistry = await validateLiveSkipDeployBaseline({
          rpcUrl,
          deployOutputPath: deployOutputArbSepolia,
          expectedChainId: 421614n,
          requiredRegistryModules: shouldSeedLiveMockPrices(env)
            ? ["ACCESS_CONTROL_MANAGER", "PRICE_ORACLE", PRICE_UPDATER_REGISTRY_RAW_KEY]
            : undefined,
        });
        env.REGISTRY_ADDRESS = validatedRegistry;
        console.log(`[Live] --skip-deploy baseline OK: Registry ${validatedRegistry} has code on chainId 421614.`);
      }

      // Plumb Registry address into smoke scripts (they resolve Registry via REGISTRY_ADDRESS).
      const deployOutputMap = tryLoadDeployOutputMap(deployOutputArbSepolia);
      const regAddr = deployOutputMap?.Registry ?? "";
      if (regAddr) {
        env.REGISTRY_ADDRESS = regAddr;
        if (deployOutputMap?.WhitelistRegistry) {
          env.WHITELIST_REGISTRY_ADDRESS = deployOutputMap.WhitelistRegistry;
        }
        if (deployOutputMap?.AccessControlManager) {
          env.ACCESS_CONTROL_MANAGER_ADDRESS = deployOutputMap.AccessControlManager;
        }
        console.log(`\n[Live] Using REGISTRY_ADDRESS from deploy output: ${regAddr}`);
      } else {
        console.log(
          `\n[Live] WARN: could not read Registry from ${deployOutputArbSepolia}; smoke scripts will fall back to deployments/addresses.arbitrum-sepolia.json or env overrides.`
        );
      }

      if (!skipCompile) {
        runStep("Compile", "pnpm", ["-s", "run", "compile"]);
      }

      if (!skipInvariant) {
        runStep("Invariant Tests", "pnpm", ["-s", "test", "test/Registry.invariant.test.ts"]);
      }

      // Live-chain smoke subset: keep read-only and avoid hardhat-only RPC.
      const liveEnv = { ...env } as Record<string, string | undefined>;
      liveEnv.READ_ONLY = "1";
      liveEnv.ENABLE_WRITE = "0";
      liveEnv.STRICT_TX = "0";

      const liveRunId = `live-smoke-${nowId()}`;
      const liveLogDir = path.join(E2E_DIR, "logs", liveRunId);
      if (shouldSeedLiveMockPrices(env)) {
        const livePriceMode = getLivePriceMode(env);
        const seedEnv = { ...env } as Record<string, string | undefined>;
        setDefault(seedEnv, "AUTO_GRANT_UPDATE_PRICE", "1");
        if (livePriceMode === "backend-required") {
          console.log(
            "[Live] backend-required price mode is active; auto-seeding final prices only because FORCE_PRICE_UPDATE=1 was explicitly set."
          );
        }
        runHardhatScriptWithLog({
          label: "Live Prime: seed-mock-asset-prices.ts",
          scriptPath: SEED_MOCK_ASSET_PRICES_ARB_SEPOLIA,
          network: "arbitrumSepolia",
          env: seedEnv,
          logDir: liveLogDir,
        });
      }
      if (shouldPrimeLiveMockViewCache(env)) {
        runHardhatScriptWithLog({
          label: "Live Prime: live-prime-viewcache-arbitrum-sepolia.ts",
          scriptPath: LIVE_PRIME_VIEWCACHE_SCRIPT,
          network: "arbitrumSepolia",
          env,
          logDir: liveLogDir,
        });
      }
      runHardhatScriptWithLog({
        label: "Live Preflight: live-preflight-arbitrum-sepolia.ts",
        scriptPath: LIVE_PREFLIGHT_SCRIPT,
        network: "arbitrumSepolia",
        env: liveEnv,
        logDir: liveLogDir,
      });

      console.log(`\n== Live Smoke Set ==`);
      console.log(`scripts: ${LIVE_SMOKE_SCRIPTS.length}`);
      console.log(`logs: ${liveLogDir}`);

      for (const scriptPath of LIVE_SMOKE_SCRIPTS) {
        const label = `Live Smoke: ${path.basename(scriptPath)}`;
        runHardhatScriptWithLog({
          label,
          scriptPath,
          network: "arbitrumSepolia",
          env: liveEnv,
          logDir: liveLogDir,
        });
      }

      console.log("\n✅ Pre-release gate finished (arbitrumSepolia live).\n");
      return;
    }

    if (!forkArbSepolia) {
      const localhostRpcUrl = env.LOCALHOST_RPC_URL ?? "http://127.0.0.1:8545";
      const validatedRegistry = await validateLocalhostBaselineReady({
        rpcUrl: localhostRpcUrl,
        deployOutputPath: DEPLOY_OUTPUT_LOCALHOST,
      });
      env.REGISTRY_ADDRESS = validatedRegistry;
      console.log(`\n[Localhost] Baseline OK: Registry ${validatedRegistry} has code at ${localhostRpcUrl}.`);
    }

    if (forkArbSepolia) {
      // NOTE: Some public RPCs can intermittently fail to serve recent historical state
      // (`missing trie node`), which will crash a forked Hardhat node. We default to a
      // public endpoint that has been observed to serve the required state for forking,
      // but allow overrides via args/env.
      const forkUrl =
        getArg("--fork-url") ??
        process.env.ARBITRUM_SEPOLIA_RPC_URL ??
        process.env.ARBITRUM_SEPOLIA_URL ??
        process.env.ARB_SEPOLIA_FORK_URL ??
        DEFAULT_ARB_SEPOLIA_FORK_URL;
      if (!forkUrl) {
        throw new Error(
          "[Fork] Missing fork RPC URL. Set ARBITRUM_SEPOLIA_RPC_URL (recommended) or ARBITRUM_SEPOLIA_URL (legacy template), or pass --fork-url <url>."
        );
      }

      const host = getArg("--fork-host") ?? "127.0.0.1";
      const port = Number(getArg("--fork-port") ?? "18545");
      if (!Number.isFinite(port) || port <= 0) throw new Error(`[Fork] Invalid --fork-port: ${port}`);
      forkNodeConfig = { forkUrl, host, port };

      const forkHead = await pickForkBlockNumber(forkUrl);
      const pinnedForkBlockNumber =
        (getArg("--fork-block") ?? process.env.HARDHAT_FORK_BLOCK_NUMBER ?? "").trim() || "";
      const defaultForkBlockNumber = pinnedForkBlockNumber || DEFAULT_ARB_SEPOLIA_STABLE_FORK_BLOCK;
      env.HARDHAT_FORK_BLOCK_NUMBER = defaultForkBlockNumber;
      const effectiveForkBlockNumber = pinnedForkBlockNumber || String(forkHead);
      console.log(`\n== Fork Node (Arbitrum Sepolia) ==`);
      console.log(`forkUrl: ${forkUrl}`);
      console.log(`forkHead: ${forkHead}`);
      console.log(
        `forkBlockNumber: ${env.HARDHAT_FORK_BLOCK_NUMBER}` +
          (pinnedForkBlockNumber
            ? " (pinned via --fork-block/HARDHAT_FORK_BLOCK_NUMBER)"
            : ` (default stable block; current head=${effectiveForkBlockNumber})`)
      );
      console.log(`localRpc: http://${host}:${port}`);

      const runId = new Date().toISOString().replace(/[-:TZ.]/g, "");
      const logFile = path.join(E2E_DIR, "logs", `fork-node-${runId}.log`);
      forkNode = startHardhatForkNode({ forkUrl, host, port, logFile });

      const localRpcUrl = `http://${host}:${port}`;
      forkLocalRpcUrl = localRpcUrl;
      // Arbitrum Sepolia chainId = 421614
      await waitForRpcReady({ url: localRpcUrl, expectChainId: 421614n, timeoutMs: 90_000 });

      env.LOCALHOST_RPC_URL = localRpcUrl;
      // Make fork-only scripts runnable under full runs.
      env.E2E_INCLUDE_FORK = "1";

      // Forked runs rely on upstream JSON-RPC providers and can be much slower.
      // 1) Prevent flaky undici `UND_ERR_HEADERS_TIMEOUT` inside Hardhat.
      // 2) Loosen hardhat-RPC extension timeouts used by some E2E scripts.
      setDefault(env, "DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI", "1");
      setDefault(env, "E2E_EVM_TIMEOUT_MS", "120000");

      await runForkStepWithRecovery("Deploy (fork)", () =>
        runStep("Deploy (fork)", "pnpm", ["-s", "run", "deploy:localhost"], env)
      );
      await runForkStepWithRecovery("Grant Required Roles (fork)", () =>
        runStep(
          "Grant Required Roles (fork)",
          "pnpm",
          ["-s", "exec", "hardhat", "run", GRANT_REQUIRED_ROLES_LOCAL, "--network", "localhost"],
          env
        )
      );
      await runForkStepWithRecovery("Prewarm Mock Asset Pack (fork)", () =>
        prewarmMockAssetPack("Prewarm Mock Asset Pack (fork)", env)
      );
    }

    if (!skipCompile) {
      runStep("Compile", "pnpm", ["-s", "run", "compile"]);
    }

    if (!skipInvariant) {
      runStep("Invariant Tests", "pnpm", ["-s", "test", "test/Registry.invariant.test.ts"]);
    }

    if (!skipGolden) {
      await runForkStepWithRecovery("Golden Path + Critical Exceptions", () =>
        runStep(
          "Golden Path + Critical Exceptions",
          "pnpm",
          [
            "-s",
            "exec",
            "ts-node",
            "--project",
            "./tsconfig.scripts.json",
            RUN_GOLDEN,
            "--network",
            network,
          ],
          env
        )
      );
    }

    if (!skipStress) {
      await runForkStepWithRecovery("Price/Liquidation Stress", () =>
        runStep(
          "Price/Liquidation Stress",
          "pnpm",
          ["-s", "exec", "hardhat", "run", STRESS, "--network", network],
          env
        )
      );
    }

    if (!skipFull) {
      if (forkArbSepolia && forkNodeConfig) {
        const localRpcUrl = `http://${forkNodeConfig.host}:${forkNodeConfig.port}`;
        await ensureForkRpcHealthy({
          url: localRpcUrl,
          expectChainId: 421614n,
          timeoutMs: 5_000,
          onUnhealthy: async () => {
            await restartForkNodeAndRedeploy("RPC unhealthy before Full Strict E2E");
          },
        });
      }

      const args = ["-s", "exec", "ts-node", "--project", "./tsconfig.scripts.json", RUN_ALL, "--network", network];
      if (forkArbSepolia) args.push("--include-fork");
      await runForkStepWithRecovery("Full Strict E2E", () => runStep("Full Strict E2E", "pnpm", args, env));
    }

    // Enforce core E2E coverage when Full run is skipped (so the critical 4 scripts cannot be accidentally omitted).
    // When Full Strict E2E runs, it already enumerates all scripts/e2e/e2e-*.ts (including these core scripts).
    if (requireCoreE2e && skipFull) {
      const runId = `core-e2e-${nowId()}`;
      const logDir = path.join(E2E_DIR, "logs", runId);
      console.log("\n== Core E2E (required) ==");
      console.log("[Core] Full Strict E2E was skipped; running required core scripts explicitly.");
      console.log(`Logs: ${logDir}`);

      const results: Array<{ file: string; ok: boolean; status: number; logFile: string }> = [];

      // NOTE: core scripts are localhost/fork oriented; they may mutate state and assume a writeable node.
      // We intentionally do NOT auto-skip; any failure is fatal with detailed logs.
      for (const scriptPath of CORE_E2E_SCRIPTS) {
        const file = path.basename(scriptPath);
        const logFile = path.join(logDir, `${file.replace(/\.ts$/, "")}.log`);
        try {
          runHardhatScriptWithLog({
            label: `Core E2E: ${file}`,
            scriptPath,
            network,
            env,
            logDir,
          });
          results.push({ file, ok: true, status: 0, logFile });
        } catch (e: any) {
          const status = typeof e?.status === "number" ? e.status : 1;
          results.push({ file, ok: false, status, logFile });
          // Continue to run the remaining core scripts so CI can report all failures.
        }
      }

      const failed = results.filter((r) => !r.ok);
      console.log("\n== Core E2E Summary ==");
      for (const r of results) {
        const tag = r.ok ? "OK" : "FAIL";
        console.log(`[${tag}] ${r.file}`);
        console.log(`      log: ${r.logFile}`);
      }
      console.log(`\nCore logs: ${logDir}`);
      if (failed.length) {
        console.error(`\n❌ Core E2E failed: ${failed.length}/${results.length}`);
        throw new StepFailed("Core E2E Summary", 1);
      }
      console.log(`\n✅ Core E2E all passed: ${results.length}/${results.length}`);
    }

    if (!skipReports) {
      runStep(
        "E2E Details Report",
        "pnpm",
        ["-s", "exec", "ts-node", "--project", "./tsconfig.scripts.json", DETAILS]
      );
      runStep(
        "Batch Artifacts Quantification",
        "pnpm",
        ["-s", "exec", "ts-node", "--project", "./tsconfig.scripts.json", BATCH_QUANT, "--strict-batch-ci"]
      );
    }

    if (!skipAudit) {
      runStep("Deep Dive Audit", "pnpm", ["-s", "exec", "ts-node", "--project", "./tsconfig.scripts.json", AUDIT]);
    }

    console.log("\n✅ Pre-release gate finished.");
  };

  run()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => {
      cleanup();
    });

  return;
}

main();
