import "dotenv/config";

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { JsonRpcProvider, Wallet, Contract, ethers } from "ethers";

import { bnbTestnetNetworkConfig } from "../config/networks";
import {
  auditDeployedImplementations,
  type AddressMap,
} from "./utils/evm-implementation-audit";
import {
  buildFrontendReleaseArtifact,
  EVM_NAME_TO_KEY,
  writeFrontendArtifacts,
} from "./utils/evm-frontend-release";

type RunSummary = {
  runDir: string;
  steps: Array<{
    id: string;
    label: string;
    command?: string;
    logFile?: string;
    status: "passed" | "failed" | "skipped";
    detail?: string;
  }>;
};

type RoleAuditRow = {
  label: string;
  account: string;
  requiredAnyOf: string[];
  satisfied: boolean;
  matchedRole?: string;
};

type BridgeProbeResult = {
  label: string;
  passed: boolean;
  detail: string;
};

type RoleAuditReport = {
  acmOwner: string;
  relayerAddress?: string;
  updaterAddress?: string;
  viewerAddress?: string;
  rows: RoleAuditRow[];
  bridgeProbes: BridgeProbeResult[];
};

type BuildInfoCompilerSummary = {
  buildInfoFile: string;
  solcVersion: string | null;
  solcLongVersion: string | null;
  optimizerEnabled: boolean | null;
  optimizerRuns: number | null;
  viaIR: boolean | null;
  evmVersion: string | null;
  bytecodeHash: string | null;
};

type BaselineContractRecord = {
  address: string;
  registryKey: string | null;
  isProxy: boolean;
  implementationAddress: string | null;
  artifactPath: string | null;
  buildInfoFile: string | null;
  compilerKey: string | null;
  codeHash: string | null;
  normalizedCodeHash: string | null;
  artifactHash: string | null;
  normalizedArtifactHash: string | null;
  auditStatus: string | null;
};

type DeployBaselineArtifact = {
  network: string;
  chainId: number;
  releaseId: string;
  generatedAt: string;
  registry: string;
  sourceFiles: Record<string, string>;
  git: {
    commit: string | null;
    branch: string | null;
    isDirty: boolean;
    statusShort: string[];
  };
  compilers: Record<string, BuildInfoCompilerSummary>;
  contracts: Record<string, BaselineContractRecord>;
  audit: {
    implementation: {
      counts: Record<string, number>;
      failureCount: number;
      status: "passed" | "failed";
    };
  };
};

type ReferenceBaselineResolution = {
  referenceBaselineFile: string;
  releaseId: string | null;
  matchedContractCount: number;
  explainedFailures: string[];
  unresolvedFailures: string[];
};

const ROOT = process.cwd();
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const CORE_FILE = path.join(ROOT, "scripts", "deployments", "bnb-testnet", "core.json");
const MANIFEST_FILE = path.join(ROOT, "scripts", "deployments", "bnb-testnet", "manifest.json");
const BASELINE_FILE = path.join(ROOT, "scripts", "deployments", "bnb-testnet", "baseline.json");
const BASELINE_HISTORY_DIR = path.join(ROOT, "scripts", "deployments", "bnb-testnet", "history");
const DEFAULT_REFERENCE_BASELINE_FILE = path.join(
  ROOT,
  "scripts",
  "deployments",
  "bnb-testnet",
  "history",
  "bnb-testnet-20260414011126528.baseline.json",
);
const MOCK_SUITE_FILE = path.join(ROOT, "scripts", "deployments", "bnb-testnet", "mock-suite.json");
const FRONTEND_FILE = path.join(ROOT, "frontend-config", "contracts-bnb-testnet.ts");
const CANONICAL_FRONTEND_FILE = path.join(ROOT, "frontend-config", "networks", "bnb-testnet.ts");
const FRONTEND_RELEASE_FILE = path.join(ROOT, "frontend-config", "networks", "bnb-testnet.release.json");
const EIP1967_IMPLEMENTATION_SLOT = "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";
const NO_CODE_ALLOWED = new Set(["GovernanceGuardian"]);
const MISSING_ROLE_SELECTOR = ethers.id("MissingRole()").slice(0, 10).toLowerCase();
const NAME_TO_KEY = EVM_NAME_TO_KEY;

const EXTRA_ALIASES: Array<{ deployName: string; keyName: string }> = [
  { deployName: "CollateralManager", keyName: "CM" },
];

const IMPLEMENTATION_ARTIFACT_ALIASES: Record<string, string[]> = {
  PriceUpdater: ["CoinGeckoPriceUpdater", "CoingeckoPriceUpdater"],
  LiquidatorView: ["LiquidationView"],
  StatisticsView: ["VaultStatistics"],
  UserView: ["UserViewFacade"],
  EarnConfig: ["RewardEarnConfig"],
  RewardConfig: ["RewardManagerConfig"],
  RegistryDynamicModuleKey: ["DynamicModuleRegistry"],
  LendingEngine: ["OrderEngine"],
};

function nowId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

function envFlag(name: string, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envStr(name: string) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function archiveDeployBaseline(releaseId: string) {
  if (!fs.existsSync(BASELINE_FILE)) {
    throw new Error(`Missing baseline file to archive: ${BASELINE_FILE}`);
  }
  ensureDir(BASELINE_HISTORY_DIR);
  const archiveFile = path.join(BASELINE_HISTORY_DIR, `${releaseId}.baseline.json`);
  fs.copyFileSync(BASELINE_FILE, archiveFile);
  return archiveFile;
}

function buildArtifactPathIndex() {
  const index = new Map<string, string[]>();
  const queue = [ARTIFACTS_DIR];

  const add = (name: string | undefined, filePath: string) => {
    if (!name) return;
    const key = name.trim();
    if (!key) return;
    const list = index.get(key) ?? [];
    if (!list.includes(filePath)) {
      list.push(filePath);
      index.set(key, list);
    }
  };

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".dbg.json")) {
        continue;
      }

      add(path.basename(entry.name, ".json"), fullPath);
      try {
        const parsed = readJson<{ contractName?: string }>(fullPath);
        add(parsed.contractName, fullPath);
      } catch {
      }
    }
  }

  return index;
}

function runGit(args: string[]) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || "").trim();
}

function keyOf(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function resolveRpcUrl() {
  const rpcUrl =
    envStr("BNB_TESTNET_RPC_URL") ||
    envStr("BSC_TESTNET_RPC_URL") ||
    envStr("BNB_TESTNET_URL") ||
    envStr("BSC_TESTNET_URL");
  if (!rpcUrl) {
    throw new Error("Missing BNB RPC URL. Set BNB_TESTNET_RPC_URL or BSC_TESTNET_RPC_URL.");
  }
  return rpcUrl;
}

function collectGitSnapshot() {
  const statusRaw = runGit(["status", "--short"]) ?? "";
  return {
    commit: runGit(["rev-parse", "HEAD"]),
    branch: runGit(["branch", "--show-current"]),
    isDirty: statusRaw.length > 0,
    statusShort: statusRaw.length > 0 ? statusRaw.split(/\r?\n/).filter(Boolean) : [],
  };
}

function resolveRoleAddresses(core: AddressMap) {
  const provider = new JsonRpcProvider(resolveRpcUrl());
  const resolveWalletAddress = (privateKeyEnv: string) => {
    const privateKey = envStr(privateKeyEnv);
    if (!privateKey) return undefined;
    return new Wallet(privateKey, provider).address;
  };

  const relayerAddress =
    resolveWalletAddress("RELAYER_PRIVATE_KEY") ||
    resolveWalletAddress("PRIVATE_KEY") ||
    envStr("RELAYER_ADDRESS") ||
    core.GovernanceGuardian;
  const updaterAddress =
    resolveWalletAddress("UPDATER_PRIVATE_KEY") ||
    resolveWalletAddress("PRIVATE_KEY") ||
    envStr("UPDATER_ADDRESS") ||
    relayerAddress;
  const viewerAddress =
    resolveWalletAddress("VIEWER_PRIVATE_KEY") ||
    envStr("VIEWER_ADDRESS") ||
    relayerAddress;

  return {
    provider,
    relayerAddress,
    updaterAddress,
    viewerAddress,
  };
}

function runCommand(params: {
  label: string;
  command: string;
  args: string[];
  logFile: string;
  extraEnv?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}) {
  ensureDir(path.dirname(params.logFile));
  if (params.dryRun) {
    fs.writeFileSync(params.logFile, `[dry-run] ${params.command} ${params.args.join(" ")}\n`, "utf8");
    return;
  }

  const result = spawnSync(params.command, params.args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...params.extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(params.logFile, output, "utf8");
  if (result.status !== 0) {
    throw new Error(`${params.label} failed with exit code ${result.status}. See ${params.logFile}`);
  }
}

function refreshDerivedArtifacts(core: AddressMap, releaseId: string, generatedAt: string) {
  const releaseArtifact = buildFrontendReleaseArtifact({
    network: bnbTestnetNetworkConfig.slug,
    chainId: bnbTestnetNetworkConfig.chainId,
    releaseId,
    generatedAt,
    registry: core.Registry,
    sourceFiles: {
      deployOutputFile: path.relative(ROOT, CORE_FILE),
      manifestFile: path.relative(ROOT, MANIFEST_FILE),
      baselineFile: path.relative(ROOT, BASELINE_FILE),
      mockSuiteFile: path.relative(ROOT, MOCK_SUITE_FILE),
      frontendConfigFile: path.relative(ROOT, CANONICAL_FRONTEND_FILE),
      frontendReleaseFile: path.relative(ROOT, FRONTEND_RELEASE_FILE),
    },
    core,
  });

  writeFrontendArtifacts({
    frontendFile: FRONTEND_FILE,
    canonicalFrontendFile: CANONICAL_FRONTEND_FILE,
    frontendReleaseFile: FRONTEND_RELEASE_FILE,
    manifestFile: MANIFEST_FILE,
    mockSuiteFile: MOCK_SUITE_FILE,
    core,
    releaseArtifact,
    displayLabel: "BNB Testnet",
    network: bnbTestnetNetworkConfig.slug,
    chainId: bnbTestnetNetworkConfig.chainId,
    rpcUrl: resolveRpcUrl(),
    explorer: bnbTestnetNetworkConfig.explorerBaseUrl ?? "https://testnet.bscscan.com",
  });

  writeJson(MOCK_SUITE_FILE, core);
}

function readBuildInfoCompilerSummary(artifactPath: string): BuildInfoCompilerSummary | null {
  const dbgPath = artifactPath.replace(/\.json$/, ".dbg.json");
  if (!fs.existsSync(dbgPath)) return null;

  try {
    const dbg = readJson<{ buildInfo?: string }>(dbgPath);
    if (!dbg.buildInfo) return null;
    const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
    if (!fs.existsSync(buildInfoPath)) return null;
    const buildInfo = readJson<{
      solcVersion?: string;
      solcLongVersion?: string;
      input?: {
        settings?: {
          optimizer?: { enabled?: boolean; runs?: number };
          viaIR?: boolean;
          evmVersion?: string;
          metadata?: { bytecodeHash?: string };
        };
      };
    }>(buildInfoPath);
    const settings = buildInfo.input?.settings;
    return {
      buildInfoFile: path.relative(ROOT, buildInfoPath),
      solcVersion: buildInfo.solcVersion ?? null,
      solcLongVersion: buildInfo.solcLongVersion ?? null,
      optimizerEnabled: typeof settings?.optimizer?.enabled === "boolean" ? settings.optimizer.enabled : null,
      optimizerRuns: typeof settings?.optimizer?.runs === "number" ? settings.optimizer.runs : null,
      viaIR: typeof settings?.viaIR === "boolean" ? settings.viaIR : null,
      evmVersion: typeof settings?.evmVersion === "string" ? settings.evmVersion : null,
      bytecodeHash: typeof settings?.metadata?.bytecodeHash === "string" ? settings.metadata.bytecodeHash : null,
    };
  } catch {
    return null;
  }
}

function buildDeployBaseline(params: {
  core: AddressMap;
  releaseId: string;
  generatedAt: string;
  implementationAudit: Awaited<ReturnType<typeof auditImplementations>>;
}): DeployBaselineArtifact {
  const auditByName = new Map(params.implementationAudit.audits.map((audit) => [audit.name, audit]));
  const artifactIndex = buildArtifactPathIndex();
  const compilerCatalog = new Map<string, BuildInfoCompilerSummary>();
  const contracts = Object.fromEntries(
    Object.entries(params.core).map(([name, address]) => {
      const audit = auditByName.get(name);
      const candidateArtifactPath = audit?.artifactPath
        ?? artifactIndex.get(name)?.[0]
        ?? (IMPLEMENTATION_ARTIFACT_ALIASES[name] ?? []).flatMap((alias) => artifactIndex.get(alias) ?? [])[0]
        ?? null;
      const artifactPath = candidateArtifactPath ? path.relative(ROOT, candidateArtifactPath) : null;
      const compiler = candidateArtifactPath ? readBuildInfoCompilerSummary(candidateArtifactPath) : null;
      if (compiler) {
        compilerCatalog.set(compiler.buildInfoFile, compiler);
      }

      const record: BaselineContractRecord = {
        address,
        registryKey: NAME_TO_KEY[name] ?? null,
        isProxy: audit?.isProxy ?? false,
        implementationAddress: audit?.implementationAddress ?? null,
        artifactPath,
        buildInfoFile: compiler?.buildInfoFile ?? null,
        compilerKey: compiler?.buildInfoFile ?? null,
        codeHash: audit?.codeHash ?? null,
        normalizedCodeHash: audit?.normalizedCodeHash ?? null,
        artifactHash: audit?.artifactHash ?? null,
        normalizedArtifactHash: audit?.normalizedArtifactHash ?? null,
        auditStatus: audit?.status ?? null,
      };

      return [name, record];
    }),
  );

  return {
    network: bnbTestnetNetworkConfig.slug,
    chainId: bnbTestnetNetworkConfig.chainId,
    releaseId: params.releaseId,
    generatedAt: params.generatedAt,
    registry: params.core.Registry,
    sourceFiles: {
      deployOutputFile: path.relative(ROOT, CORE_FILE),
      manifestFile: path.relative(ROOT, MANIFEST_FILE),
      baselineFile: path.relative(ROOT, BASELINE_FILE),
      mockSuiteFile: path.relative(ROOT, MOCK_SUITE_FILE),
      frontendConfigFile: path.relative(ROOT, CANONICAL_FRONTEND_FILE),
      frontendReleaseFile: path.relative(ROOT, FRONTEND_RELEASE_FILE),
    },
    git: collectGitSnapshot(),
    compilers: Object.fromEntries([...compilerCatalog.entries()].sort(([left], [right]) => left.localeCompare(right))),
    contracts,
    audit: {
      implementation: {
        counts: params.implementationAudit.counts,
        failureCount: params.implementationAudit.failures.length,
        status: params.implementationAudit.failures.length > 0 ? "failed" : "passed",
      },
    },
  };
}

function writeDeployBaseline(params: {
  core: AddressMap;
  releaseId: string;
  generatedAt: string;
  implementationAudit: Awaited<ReturnType<typeof auditImplementations>>;
}) {
  writeJson(
    BASELINE_FILE,
    buildDeployBaseline({
      core: params.core,
      releaseId: params.releaseId,
      generatedAt: params.generatedAt,
      implementationAudit: params.implementationAudit,
    }),
  );
}

function validateDerivedArtifacts() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    throw new Error(`Missing manifest file: ${MANIFEST_FILE}`);
  }
  if (!fs.existsSync(MOCK_SUITE_FILE)) {
    throw new Error(`Missing mock-suite file: ${MOCK_SUITE_FILE}`);
  }
  if (!fs.existsSync(FRONTEND_RELEASE_FILE)) {
    throw new Error(`Missing frontend release file: ${FRONTEND_RELEASE_FILE}`);
  }

  const manifest = readJson<{ contracts?: Record<string, unknown> }>(MANIFEST_FILE);
  const mockSuite = readJson<Record<string, string>>(MOCK_SUITE_FILE);
  const frontendRelease = readJson<{ contracts?: Record<string, unknown> }>(FRONTEND_RELEASE_FILE);
  if (!manifest.contracts || Object.keys(manifest.contracts).length === 0) {
    throw new Error(`Manifest contracts are empty: ${MANIFEST_FILE}`);
  }
  if (Object.keys(mockSuite).length === 0) {
    throw new Error(`Mock-suite is empty: ${MOCK_SUITE_FILE}`);
  }
  if (!frontendRelease.contracts || Object.keys(frontendRelease.contracts).length === 0) {
    throw new Error(`Frontend release contracts are empty: ${FRONTEND_RELEASE_FILE}`);
  }
}

function parseFrontendAddresses(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const out: AddressMap = {};
  for (const match of content.matchAll(/^\s*([A-Za-z0-9_]+): '(0x[a-fA-F0-9]{40})',?$/gm)) {
    out[match[1]] = match[2];
  }
  return out;
}

async function auditRegistryRoutes(core: AddressMap, provider: JsonRpcProvider) {
  const registry = new Contract(core.Registry, ["function getModule(bytes32) view returns (address)"], provider);
  const mismatches: string[] = [];

  for (const [name, address] of Object.entries(core)) {
    const keyName = NAME_TO_KEY[name];
    if (!keyName || name === "Registry") continue;
    const onchain = await registry.getModule(keyOf(keyName));
    if (!onchain || onchain === ethers.ZeroAddress) {
      mismatches.push(`${name}: registry key ${keyName} is unset`);
      continue;
    }
    if (onchain.toLowerCase() !== address.toLowerCase()) {
      mismatches.push(`${name}: registry=${onchain} deploy=${address}`);
    }
  }

  for (const alias of EXTRA_ALIASES) {
    const address = core[alias.deployName];
    if (!address) continue;
    const onchain = await registry.getModule(keyOf(alias.keyName));
    if (!onchain || onchain === ethers.ZeroAddress) {
      continue;
    }
    if (onchain.toLowerCase() !== address.toLowerCase()) {
      mismatches.push(`${alias.deployName}: alias key ${alias.keyName} registry=${onchain} deploy=${address}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Registry route audit failed:\n${mismatches.join("\n")}`);
  }
}

async function auditImplementations(core: AddressMap, provider: JsonRpcProvider) {
  return auditDeployedImplementations({
    core,
    provider,
    artifactsDir: path.join(ROOT, "artifacts"),
    eip1967ImplementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    noCodeAllowed: NO_CODE_ALLOWED,
    artifactAliases: IMPLEMENTATION_ARTIFACT_ALIASES,
  });
}

function extractRevertData(error: unknown): string | null {
  const err = error as any;
  const candidates = [
    err?.data,
    err?.data?.data,
    err?.data?.result,
    err?.error?.data,
    err?.error?.data?.data,
    err?.error?.data?.result,
    err?.info?.error?.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x")) {
      return candidate;
    }
  }
  return null;
}

function describeRevert(error: unknown) {
  const err = error as any;
  const data = extractRevertData(err);
  if (!data || data === "0x") {
    return {
      selector: "<empty>",
      decoded: String(err?.shortMessage ?? err?.message ?? err),
    };
  }
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === MISSING_ROLE_SELECTOR) {
    return { selector, decoded: "MissingRole()" };
  }
  if (selector === "0x08c379a0") {
    try {
      const [message] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      return { selector, decoded: `Error(\"${message}\")` };
    } catch {
      return { selector, decoded: "Error(<decode-failed>)" };
    }
  }
  return { selector, decoded: `CustomError(${selector})` };
}

async function probeSettlementManagerBridge(core: AddressMap, provider: JsonRpcProvider) {
  const orderEngineAddress = core.LendingEngine;
  const settlementManagerAddress = core.SettlementManager;
  const iface = new ethers.Interface([
    "function getLoanOrderForView(uint256 orderId) view returns ((uint256,uint256,uint256,address,address,address,uint256,uint256,uint256))",
    "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
    "function repay(uint256 orderId,uint256 repayAmount)",
  ]);
  const probes: Array<{ label: string; data: string }> = [
    {
      label: "SettlementManager->ORDER_ENGINE getLoanOrderForView bridge",
      data: iface.encodeFunctionData("getLoanOrderForView", [0n]),
    },
    {
      label: "SettlementManager->ORDER_ENGINE getOrderTotalDueForView bridge",
      data: iface.encodeFunctionData("getOrderTotalDueForView", [0n]),
    },
    {
      label: "SettlementManager->ORDER_ENGINE repay bridge",
      data: iface.encodeFunctionData("repay", [0n, 1n]),
    },
  ];

  const results: BridgeProbeResult[] = [];
  for (const probe of probes) {
    try {
      await provider.call({
        to: orderEngineAddress,
        from: settlementManagerAddress,
        data: probe.data,
      });
      results.push({ label: probe.label, passed: true, detail: "call succeeded" });
    } catch (error) {
      const decoded = describeRevert(error);
      results.push({
        label: probe.label,
        passed: decoded.selector !== MISSING_ROLE_SELECTOR,
        detail: decoded.decoded,
      });
    }
  }
  return results;
}

async function auditCriticalRoles(core: AddressMap, provider: JsonRpcProvider) {
  const { relayerAddress, updaterAddress, viewerAddress } = resolveRoleAddresses(core);
  const acm = new Contract(
    core.AccessControlManager,
    ["function hasRole(bytes32 role,address account) view returns (bool)"],
    provider,
  );
  const owner = String(await new Contract(core.AccessControlManager, ["function owner() view returns (address)"], provider).owner());
  const failures: string[] = [];
  const rows: RoleAuditRow[] = [];
  const requiredRoles: Array<{ label: string; address: string | undefined; anyOf: string[] }> = [
    { label: "relayer VIEW_PRICE_DATA", address: relayerAddress, anyOf: ["VIEW_PRICE_DATA"] },
    { label: "relayer VIEW_USER_DATA", address: relayerAddress, anyOf: ["VIEW_USER_DATA"] },
    { label: "relayer VIEW_RISK_DATA", address: relayerAddress, anyOf: ["VIEW_RISK_DATA"] },
    { label: "relayer VIEW_SYSTEM_DATA", address: relayerAddress, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "relayer LIQUIDATE", address: relayerAddress, anyOf: ["LIQUIDATE"] },
    { label: "relayer DEPOSIT", address: relayerAddress, anyOf: ["DEPOSIT"] },
    { label: "relayer ACTION_VIEW_PUSH", address: relayerAddress, anyOf: ["ACTION_VIEW_PUSH"] },
    { label: "relayer UPDATE_PRICE", address: relayerAddress, anyOf: ["UPDATE_PRICE"] },
    { label: "relayer system viewer", address: relayerAddress, anyOf: ["ACTION_ADMIN", "ACTION_VIEW_SYSTEM_STATUS"] },
    { label: "relayer parameter setter", address: relayerAddress, anyOf: ["ACTION_SET_PARAMETER", "SET_PARAMETER"] },
    { label: "relayer reward emergency", address: relayerAddress, anyOf: ["ACTION_REWARD_CONFIG_EMERGENCY", "REWARD_CONFIG_EMERGENCY"] },
    { label: "updater UPDATE_PRICE", address: updaterAddress, anyOf: ["UPDATE_PRICE"] },
    { label: "viewer VIEW_USER_DATA", address: viewerAddress, anyOf: ["VIEW_USER_DATA"] },
    { label: "viewer VIEW_RISK_DATA", address: viewerAddress, anyOf: ["VIEW_RISK_DATA"] },
    { label: "viewer VIEW_SYSTEM_DATA", address: viewerAddress, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "SettlementManager LIQUIDATE", address: core.SettlementManager, anyOf: ["LIQUIDATE"] },
    { label: "SettlementManager VIEW_RISK_DATA", address: core.SettlementManager, anyOf: ["VIEW_RISK_DATA"] },
    { label: "LiquidationManager LIQUIDATE", address: core.LiquidationManager, anyOf: ["LIQUIDATE"] },
    { label: "StatisticsPushManager VIEW_SYSTEM_DATA", address: core.StatisticsPushManager, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "VaultBusinessLogic ORDER_CREATE", address: core.VaultBusinessLogic, anyOf: ["ORDER_CREATE"] },
    { label: "VaultBusinessLogic DEPOSIT", address: core.VaultBusinessLogic, anyOf: ["DEPOSIT"] },
    { label: "LendingEngine BORROW", address: core.LendingEngine, anyOf: ["BORROW"] },
  ];

  for (const entry of requiredRoles) {
    if (!entry.address) continue;
    let matchedRole: string | undefined;
    for (const roleName of entry.anyOf) {
      if ((await acm.hasRole(keyOf(roleName), entry.address)) as boolean) {
        matchedRole = roleName;
        break;
      }
    }
    const row: RoleAuditRow = {
      label: entry.label,
      account: entry.address,
      requiredAnyOf: entry.anyOf,
      satisfied: Boolean(matchedRole),
      matchedRole,
    };
    rows.push(row);
    if (!row.satisfied) {
      failures.push(`${row.label} account=${row.account} requiredAnyOf=${row.requiredAnyOf.join("|")}`);
    }
  }

  const bridgeProbes = await probeSettlementManagerBridge(core, provider);
  for (const result of bridgeProbes) {
    if (!result.passed) {
      failures.push(`${result.label} detail=${result.detail}`);
    }
  }

  const report: RoleAuditReport = {
    acmOwner: owner,
    relayerAddress,
    updaterAddress,
    viewerAddress,
    rows,
    bridgeProbes,
  };

  if (failures.length > 0) {
    throw new Error(`Critical role audit failed:\n${failures.join("\n")}`);
  }

  return report;
}

async function ensureCriticalRoles(core: AddressMap, provider: JsonRpcProvider) {
  const { relayerAddress, updaterAddress, viewerAddress } = resolveRoleAddresses(core);
  const adminPrivateKey = envStr("PRIVATE_KEY");
  if (!adminPrivateKey) {
    throw new Error("Missing PRIVATE_KEY for critical role repair.");
  }

  const adminSigner = new Wallet(adminPrivateKey, provider);
  const acm = new Contract(
    core.AccessControlManager,
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function grantRole(bytes32 role,address account)",
    ],
    adminSigner,
  );
  const owner = String(await acm.owner());
  if (owner.toLowerCase() !== adminSigner.address.toLowerCase()) {
    throw new Error(
      `Critical role repair requires ACM owner signer. owner=${owner} signer=${adminSigner.address}`,
    );
  }

  const repaired: string[] = [];
  const alreadyGranted: string[] = [];
  const grants: Array<{ label: string; account: string | undefined; anyOf: string[] }> = [
    { label: "relayer VIEW_PRICE_DATA", account: relayerAddress, anyOf: ["VIEW_PRICE_DATA"] },
    { label: "relayer VIEW_USER_DATA", account: relayerAddress, anyOf: ["VIEW_USER_DATA"] },
    { label: "relayer VIEW_RISK_DATA", account: relayerAddress, anyOf: ["VIEW_RISK_DATA"] },
    { label: "relayer VIEW_SYSTEM_DATA", account: relayerAddress, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "relayer LIQUIDATE", account: relayerAddress, anyOf: ["LIQUIDATE"] },
    { label: "relayer DEPOSIT", account: relayerAddress, anyOf: ["DEPOSIT"] },
    { label: "relayer ACTION_VIEW_PUSH", account: relayerAddress, anyOf: ["ACTION_VIEW_PUSH"] },
    { label: "relayer UPDATE_PRICE", account: relayerAddress, anyOf: ["UPDATE_PRICE"] },
    { label: "relayer system viewer", account: relayerAddress, anyOf: ["ACTION_ADMIN", "ACTION_VIEW_SYSTEM_STATUS"] },
    { label: "relayer parameter setter", account: relayerAddress, anyOf: ["ACTION_SET_PARAMETER", "SET_PARAMETER"] },
    { label: "relayer reward emergency", account: relayerAddress, anyOf: ["ACTION_REWARD_CONFIG_EMERGENCY", "REWARD_CONFIG_EMERGENCY"] },
    { label: "updater UPDATE_PRICE", account: updaterAddress, anyOf: ["UPDATE_PRICE"] },
    { label: "viewer VIEW_USER_DATA", account: viewerAddress, anyOf: ["VIEW_USER_DATA"] },
    { label: "viewer VIEW_RISK_DATA", account: viewerAddress, anyOf: ["VIEW_RISK_DATA"] },
    { label: "viewer VIEW_SYSTEM_DATA", account: viewerAddress, anyOf: ["VIEW_SYSTEM_DATA"] },
  ];

  for (const grant of grants) {
    if (!grant.account) continue;
    let matchedRole: string | undefined;
    for (const roleName of grant.anyOf) {
      if ((await acm.hasRole(keyOf(roleName), grant.account)) as boolean) {
        matchedRole = roleName;
        break;
      }
    }
    if (matchedRole) {
      alreadyGranted.push(`${grant.label} matched=${matchedRole}`);
      continue;
    }

    const targetRole = grant.anyOf[0];
    await (await acm.grantRole(keyOf(targetRole), grant.account)).wait();
    repaired.push(`${grant.label} granted=${targetRole} account=${grant.account}`);
  }

  return {
    owner,
    signer: adminSigner.address,
    repaired,
    alreadyGranted,
    relayerAddress,
    updaterAddress,
    viewerAddress,
  };
}

function auditFrontendAgainstCore(core: AddressMap) {
  const frontend = parseFrontendAddresses(CANONICAL_FRONTEND_FILE);
  const diffs: string[] = [];
  for (const [name, address] of Object.entries(core)) {
    const frontendAddress = frontend[name];
    if (!frontendAddress) {
      diffs.push(`${name}: missing in frontend config`);
      continue;
    }
    if (frontendAddress.toLowerCase() !== address.toLowerCase()) {
      diffs.push(`${name}: frontend=${frontendAddress} deploy=${address}`);
    }
  }
  if (diffs.length > 0) {
    throw new Error(`Frontend config drift detected:\n${diffs.join("\n")}`);
  }
}

function appendStep(summary: RunSummary, step: RunSummary["steps"][number]) {
  summary.steps.push(step);
}

function writeSummary(runDir: string, summary: RunSummary, extra?: Record<string, unknown>) {
  writeJson(path.join(runDir, "summary.json"), {
    ...summary,
    ...extra,
  });
}

function resolveReferenceBaselineFile() {
  const filePath = envStr("RELEASE_SYNC_REFERENCE_BASELINE_FILE");
  if (filePath) {
    return path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  }
  if (envFlag("RELEASE_SYNC_DISABLE_DEFAULT_REFERENCE_BASELINE", false)) {
    return undefined;
  }
  return fs.existsSync(DEFAULT_REFERENCE_BASELINE_FILE) ? DEFAULT_REFERENCE_BASELINE_FILE : undefined;
}

function resolveImplementationAuditAgainstReferenceBaseline(
  implementationAudit: Awaited<ReturnType<typeof auditImplementations>>,
  referenceBaselineFile: string,
): ReferenceBaselineResolution {
  if (!fs.existsSync(referenceBaselineFile)) {
    throw new Error(`Missing reference baseline file: ${referenceBaselineFile}`);
  }

  const referenceBaseline = readJson<DeployBaselineArtifact>(referenceBaselineFile);
  if (referenceBaseline.network !== "bnb-testnet") {
    throw new Error(
      `Reference baseline network mismatch: expected bnb-testnet, received ${referenceBaseline.network}`,
    );
  }

  const failingAudits = implementationAudit.audits.filter(
    (audit) => audit.status === "mismatch" || audit.status === "no-local-artifact",
  );
  const explainedFailures: string[] = [];
  const unresolvedFailures: string[] = [];

  for (const audit of failingAudits) {
    const baselineContract = referenceBaseline.contracts[audit.name];
    if (!baselineContract) {
      unresolvedFailures.push(`${audit.name}: missing from reference baseline`);
      continue;
    }

    const addressMatches = baselineContract.address.toLowerCase() === audit.address.toLowerCase();
    const proxyMatches = baselineContract.isProxy === audit.isProxy;
    const implementationMatches = (baselineContract.implementationAddress ?? null) === (audit.implementationAddress ?? null);
    const exactHashMatches = baselineContract.codeHash === audit.codeHash;
    const normalizedHashMatches = baselineContract.normalizedCodeHash === audit.normalizedCodeHash;

    if (addressMatches && proxyMatches && implementationMatches && (exactHashMatches || normalizedHashMatches)) {
      explainedFailures.push(
        `${audit.name}: onchain ${audit.isProxy ? "implementation" : "runtime"} matches reference baseline ${path.relative(ROOT, referenceBaselineFile)} releaseId=${referenceBaseline.releaseId}`,
      );
      continue;
    }

    const reasons: string[] = [];
    if (!addressMatches) {
      reasons.push(`address baseline=${baselineContract.address} current=${audit.address}`);
    }
    if (!proxyMatches) {
      reasons.push(`proxy baseline=${baselineContract.isProxy} current=${audit.isProxy}`);
    }
    if (!implementationMatches) {
      reasons.push(
        `implementation baseline=${baselineContract.implementationAddress ?? "<none>"} current=${audit.implementationAddress ?? "<none>"}`,
      );
    }
    if (!exactHashMatches && !normalizedHashMatches) {
      reasons.push(
        `hash baseline=${baselineContract.codeHash ?? "<none>"} normalized=${baselineContract.normalizedCodeHash ?? "<none>"} current=${audit.codeHash} normalized=${audit.normalizedCodeHash}`,
      );
    }
    unresolvedFailures.push(`${audit.name}: ${reasons.join("; ")}`);
  }

  return {
    referenceBaselineFile: path.relative(ROOT, referenceBaselineFile),
    releaseId: referenceBaseline.releaseId ?? null,
    matchedContractCount: explainedFailures.length,
    explainedFailures,
    unresolvedFailures,
  };
}

async function main() {
  const dryRun = envFlag("RELEASE_SYNC_DRY_RUN", false);
  const skipBuild = envFlag("RELEASE_SYNC_SKIP_BUILD", false);
  const skipDeploy = envFlag("RELEASE_SYNC_SKIP_DEPLOY", false);
  const skipGenerate = envFlag("RELEASE_SYNC_SKIP_GENERATE", false);
  const skipFork = envFlag("RELEASE_SYNC_SKIP_FORK", false);
  const skipLive = envFlag("RELEASE_SYNC_SKIP_LIVE", false);
  const ensureCriticalRolesFlag = envFlag("RELEASE_SYNC_ENSURE_CRITICAL_ROLES", false);
  const referenceBaselineFile = resolveReferenceBaselineFile();
  const releaseId = envStr("RELEASE_SYNC_RELEASE_ID") ?? `bnb-testnet-${nowId()}`;
  const generatedAt = new Date().toISOString();
  const runDir = path.join(ROOT, "scripts", "tests", "logs", `manual-bnb-sync-verify-${nowId()}`);
  ensureDir(runDir);

  const summary: RunSummary = {
    runDir,
    steps: [],
  };

  try {
    if (!skipBuild) {
      const logFile = path.join(runDir, "01-build.log");
      if (dryRun) {
        fs.writeFileSync(logFile, "[dry-run] pnpm -s run compile && pnpm -s run typecheck && pnpm -s run e2e:typecheck\n", "utf8");
      } else {
        const result = spawnSync("zsh", ["-lc", "pnpm -s run compile && pnpm -s run typecheck && pnpm -s run e2e:typecheck"], {
          cwd: ROOT,
          env: process.env,
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
        });
        fs.writeFileSync(logFile, `${result.stdout || ""}${result.stderr || ""}`, "utf8");
        if (result.status !== 0) {
          throw new Error(`build checks failed. See ${logFile}`);
        }
      }
      appendStep(summary, { id: "01-build", label: "compile-typecheck-test", command: "pnpm -s run compile && pnpm -s run typecheck && pnpm -s run e2e:typecheck", logFile, status: "passed" });
    } else {
      appendStep(summary, { id: "01-build", label: "compile-typecheck-test", status: "skipped" });
    }

    const deployPreflightLog = path.join(runDir, "02-deploy-preflight.log");
    runCommand({
      label: "deploy preflight",
      command: "pnpm",
      args: ["-s", "run", "deploy:preflight:bnb-testnet"],
      logFile: deployPreflightLog,
      dryRun,
    });
    appendStep(summary, { id: "02-deploy-preflight", label: "deploy-preflight", command: "pnpm -s run deploy:preflight:bnb-testnet", logFile: deployPreflightLog, status: "passed" });

    if (!skipDeploy) {
      const deployLog = path.join(runDir, "03-deploy.log");
      runCommand({
        label: "deploy or upgrade",
        command: "pnpm",
        args: ["-s", "run", "deploy:bnb-testnet"],
        logFile: deployLog,
        dryRun,
      });
      appendStep(summary, { id: "03-deploy", label: "deploy-or-upgrade", command: "pnpm -s run deploy:bnb-testnet", logFile: deployLog, status: "passed" });
    } else {
      appendStep(summary, { id: "03-deploy", label: "deploy-or-upgrade", status: "skipped" });
    }

    if (!fs.existsSync(CORE_FILE)) {
      throw new Error(`Missing deploy output: ${CORE_FILE}`);
    }
    const core = readJson<AddressMap>(CORE_FILE);

    if (!skipGenerate) {
      refreshDerivedArtifacts(core, releaseId, generatedAt);
      validateDerivedArtifacts();
      appendStep(summary, { id: "04-refresh-derived", label: "refresh-core-manifest-mocksuite-frontend", status: "passed", detail: `${path.relative(ROOT, MANIFEST_FILE)}, ${path.relative(ROOT, MOCK_SUITE_FILE)}, ${path.relative(ROOT, CANONICAL_FRONTEND_FILE)}, ${path.relative(ROOT, FRONTEND_RELEASE_FILE)}` });

      const generationCommands = [
        { id: "05-module-keys", label: "generate-module-keys", command: "pnpm", args: ["-s", "run", "generate:module-keys"] },
        { id: "06-contract-errors", label: "generate-contract-errors", command: "pnpm", args: ["-s", "run", "generate:contract-errors"] },
        { id: "07-abi-docs", label: "generate-abi-docs", command: "pnpm", args: ["-s", "run", "docs:abi"] },
      ];
      for (const item of generationCommands) {
        const logFile = path.join(runDir, `${item.id}.log`);
        runCommand({ label: item.label, command: item.command, args: item.args, logFile, dryRun });
        appendStep(summary, { id: item.id, label: item.label, command: `${item.command} ${item.args.join(" ")}`, logFile, status: "passed" });
      }
    } else {
      validateDerivedArtifacts();
      appendStep(summary, { id: "04-refresh-derived", label: "refresh-core-manifest-mocksuite-frontend", status: "skipped" });
    }

    const { provider } = resolveRoleAddresses(core);
    if (!dryRun) {
      await auditRegistryRoutes(core, provider);
      auditFrontendAgainstCore(core);
      const implementationAudit = await auditImplementations(core, provider);
      const implementationAuditFile = path.join(runDir, "implementation-audit.json");
      writeJson(implementationAuditFile, implementationAudit);
      writeDeployBaseline({ core, releaseId, generatedAt, implementationAudit });
      const archivedBaselineFile = archiveDeployBaseline(releaseId);
      appendStep(summary, {
        id: "08-baseline",
        label: "write-deploy-baseline",
        status: "passed",
        detail: `${path.relative(ROOT, BASELINE_FILE)} archived=${path.relative(ROOT, archivedBaselineFile)}`,
      });

      let referenceBaselineResolution: ReferenceBaselineResolution | undefined;
      if (referenceBaselineFile) {
        referenceBaselineResolution = resolveImplementationAuditAgainstReferenceBaseline(
          implementationAudit,
          referenceBaselineFile,
        );
        const referenceBaselineAuditFile = path.join(runDir, "implementation-audit-reference-baseline.json");
        writeJson(referenceBaselineAuditFile, referenceBaselineResolution);
        appendStep(summary, {
          id: "08-reference-baseline",
          label: "reference-baseline-implementation-audit",
          status: referenceBaselineResolution.unresolvedFailures.length === 0 ? "passed" : "failed",
          detail: `${referenceBaselineResolution.referenceBaselineFile} explained=${referenceBaselineResolution.explainedFailures.length} unresolved=${referenceBaselineResolution.unresolvedFailures.length}`,
        });
      }

      const unresolvedImplementationFailures = referenceBaselineResolution
        ? referenceBaselineResolution.unresolvedFailures
        : implementationAudit.failures;
      if (unresolvedImplementationFailures.length > 0) {
        const explainedBlock = referenceBaselineResolution && referenceBaselineResolution.explainedFailures.length > 0
          ? `\nReference baseline explained ${referenceBaselineResolution.explainedFailures.length} contract(s) from ${referenceBaselineResolution.referenceBaselineFile} (releaseId=${referenceBaselineResolution.releaseId ?? "<unknown>"}):\n${referenceBaselineResolution.explainedFailures.join("\n")}`
          : "";
        throw new Error(
          `Implementation hash audit failed against current checkout.${explainedBlock}\nUnresolved failures:\n${unresolvedImplementationFailures.join("\n")}`,
        );
      }
      if (ensureCriticalRolesFlag) {
        const criticalRoleRepair = await ensureCriticalRoles(core, provider);
        writeJson(path.join(runDir, "role-repair.json"), criticalRoleRepair);
        appendStep(summary, {
          id: "08-role-repair",
          label: "ensure-critical-roles",
          status: "passed",
          detail: `granted=${criticalRoleRepair.repaired.length} already=${criticalRoleRepair.alreadyGranted.length}`,
        });
      }
      const roleAudit = await auditCriticalRoles(core, provider);
      writeJson(path.join(runDir, "role-audit.json"), roleAudit);

      const orderEngineAuditLog = path.join(runDir, "08-order-engine-consistency.log");
      runCommand({
        label: "order engine deployment consistency audit",
        command: "pnpm",
        args: ["-s", "run", "debug:audit-order-engine-deployment-consistency:bnb-testnet"],
        logFile: orderEngineAuditLog,
      });
      appendStep(summary, {
        id: "08-order-engine-consistency",
        label: "order-engine-deployment-consistency",
        command: "pnpm -s run debug:audit-order-engine-deployment-consistency:bnb-testnet",
        logFile: orderEngineAuditLog,
        status: "passed",
      });

      const liveRoleAuditLog = path.join(runDir, "08-live-role-readiness.log");
      runCommand({
        label: "live role readiness audit",
        command: "pnpm",
        args: ["-s", "run", "audit:live-role-readiness:bnb-testnet"],
        logFile: liveRoleAuditLog,
      });
      appendStep(summary, {
        id: "08-live-role-readiness",
        label: "live-role-readiness-audit",
        command: "pnpm -s run audit:live-role-readiness:bnb-testnet",
        logFile: liveRoleAuditLog,
        status: "passed",
      });
    }
    appendStep(summary, { id: "08-audits", label: "registry-frontend-implementation-role-audits", status: "passed" });

    if (!skipFork) {
      const logFile = path.join(runDir, "09-fork.log");
      runCommand({
        label: "fork release gates",
        command: "pnpm",
        args: ["-s", "run", "test:live:release-gates:fork:bnb-testnet"],
        logFile,
        dryRun,
      });
      appendStep(summary, { id: "09-fork", label: "fork-release-gates", command: "pnpm -s run test:live:release-gates:fork:bnb-testnet", logFile, status: "passed" });
    } else {
      appendStep(summary, { id: "09-fork", label: "fork-release-gates", status: "skipped" });
    }

    if (!skipLive) {
      const liveEnv = {
        LIVE_TEST_NETWORK: "bnbTestnet",
        LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG: "1",
        LIVE_NETWORK_ATTEMPT_TIMEOUT_MS: "0",
        LIVE_NETWORK_MAX_ATTEMPTS: process.env.LIVE_NETWORK_MAX_ATTEMPTS ?? "6",
        LIVE_NETWORK_BASE_DELAY_MS: process.env.LIVE_NETWORK_BASE_DELAY_MS ?? "2000",
        LIVE_RUNNER_NETWORK_MAX_ATTEMPTS: process.env.LIVE_RUNNER_NETWORK_MAX_ATTEMPTS ?? "4",
        LIVE_AUTO_GRANT_RUNTIME_ROLES: process.env.LIVE_AUTO_GRANT_RUNTIME_ROLES ?? "0",
        LIVE_FAIL_ON_MISSING_RUNTIME_ROLES: process.env.LIVE_FAIL_ON_MISSING_RUNTIME_ROLES ?? "1",
        LIVE_STRICT_FEE_ROUTER_GATE: process.env.LIVE_STRICT_FEE_ROUTER_GATE ?? "1",
        LIVE_STRICT_BLOCKS_ONLY_DATAPUSH: process.env.LIVE_STRICT_BLOCKS_ONLY_DATAPUSH ?? "1",
        LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: process.env.LIVE_STRICT_BLOCKS_ONLY_PREMATURITY ?? "0",
        LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS: process.env.LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS ?? "6",
        LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS: process.env.LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS ?? "1200",
        LIVE_FUNDS_FLOW_FRESH_BORROWER_NATIVE_ETH: process.env.LIVE_FUNDS_FLOW_FRESH_BORROWER_NATIVE_ETH ?? "0.001",
        LIVE_FUNDS_FLOW_FRESH_LENDER_NATIVE_ETH: process.env.LIVE_FUNDS_FLOW_FRESH_LENDER_NATIVE_ETH ?? "0.001",
        LIVE_BNB_MIN_GAS_PRICE_WEI: process.env.LIVE_BNB_MIN_GAS_PRICE_WEI ?? "1000000000",
      };

      const gate9Log = path.join(runDir, "10-gate9.log");
      runCommand({
        label: "gate 9 blocks-only funds-chain",
        command: "pnpm",
        args: ["-s", "run", "test:live:release-gate9:bnb-testnet"],
        logFile: gate9Log,
        extraEnv: {
          ...liveEnv,
          LIVE_TEST_NETWORK: "bnbTestnet",
        },
        dryRun,
      });
      appendStep(summary, { id: "10-gate9", label: "live-gate9-blocks-only", command: "pnpm -s run test:live:release-gate9:bnb-testnet", logFile: gate9Log, status: "passed" });

      const gate10Log = path.join(runDir, "11-gate10.log");
      runCommand({
        label: "gate 10 ops extension modules",
        command: "pnpm",
        args: ["-s", "run", "test:live:release-gate10:bnb-testnet"],
        logFile: gate10Log,
        extraEnv: {
          ...liveEnv,
          LIVE_TEST_NETWORK: "bnbTestnet",
        },
        dryRun,
      });
      appendStep(summary, { id: "11-gate10", label: "live-gate10-ops-extension", command: "pnpm -s run test:live:release-gate10:bnb-testnet", logFile: gate10Log, status: "passed" });
    } else {
      appendStep(summary, { id: "10-gate9", label: "live-gate9-blocks-only", status: "skipped" });
      appendStep(summary, { id: "11-gate10", label: "live-gate10-ops-extension", status: "skipped" });
    }

    writeSummary(runDir, summary, { status: "passed", releaseId, generatedAt, frontendReleaseFile: path.relative(ROOT, FRONTEND_RELEASE_FILE) });
    console.log(`RUN_DIR=${runDir}`);
    console.log("status=passed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendStep(summary, { id: "failed", label: "failed", status: "failed", detail: message });
    writeSummary(runDir, summary, { status: "failed", error: message, releaseId, generatedAt, frontendReleaseFile: path.relative(ROOT, FRONTEND_RELEASE_FILE) });
    console.error(message);
    process.exitCode = 1;
  }
}

void main();