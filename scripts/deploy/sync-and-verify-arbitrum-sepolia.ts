import fs from "fs";
import path from "path";

import { JsonRpcProvider } from "ethers";

import {
  buildFrontendReleaseArtifact,
  type AddressMap,
  EVM_NAME_TO_KEY,
  writeFrontendArtifacts,
} from "./utils/evm-frontend-release";
import { writeDeployBaseline } from "./utils/deploy-baseline";
import { arbitrumSepoliaNetworkConfig } from "../config/networks";

const ROOT = process.cwd();
const NETWORK = arbitrumSepoliaNetworkConfig.slug;
const DEPLOY_FILE = path.join(ROOT, "scripts", "deployments", "arbitrum-sepolia.json");
const MANIFEST_FILE = path.join(ROOT, "scripts", "deployments", "arbitrum-sepolia.manifest.json");
const BASELINE_FILE = path.join(ROOT, "scripts", "deployments", "arbitrum-sepolia.baseline.json");
const MOCK_SUITE_FILE = path.join(ROOT, "scripts", "deployments", "arbitrum-sepolia.mock-suite.json");
const FRONTEND_FILE = path.join(ROOT, "frontend-config", "contracts-arbitrum-sepolia.ts");
const CANONICAL_FRONTEND_FILE = path.join(ROOT, "frontend-config", "networks", "arbitrum-sepolia.ts");
const FRONTEND_RELEASE_FILE = path.join(ROOT, "frontend-config", "networks", "arbitrum-sepolia.release.json");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const EIP1967_IMPLEMENTATION_SLOT = "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";
const NO_CODE_ALLOWED = new Set(["GovernanceGuardian"]);
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

function resolveRpcUrl() {
  return process.env.ARBITRUM_SEPOLIA_RPC_URL?.trim()
    || process.env.ARBITRUM_SEPOLIA_URL?.trim()
    || "https://sepolia-rollup.arbitrum.io/rpc";
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

async function main() {
  if (!fs.existsSync(DEPLOY_FILE)) {
    throw new Error(`Missing deploy output: ${DEPLOY_FILE}`);
  }

  const core = readJson<AddressMap>(DEPLOY_FILE);
  const generatedAt = new Date().toISOString();
  const releaseId = process.env.RELEASE_SYNC_RELEASE_ID?.trim() || `${NETWORK}-${nowId()}`;
  const baselineSourceFiles = {
    deployOutputFile: path.relative(ROOT, DEPLOY_FILE),
    manifestFile: path.relative(ROOT, MANIFEST_FILE),
    baselineFile: path.relative(ROOT, BASELINE_FILE),
    mockSuiteFile: path.relative(ROOT, MOCK_SUITE_FILE),
    frontendConfigFile: path.relative(ROOT, CANONICAL_FRONTEND_FILE),
    frontendReleaseFile: path.relative(ROOT, FRONTEND_RELEASE_FILE),
  };

  await writeDeployBaseline({
    filePath: BASELINE_FILE,
    rootDir: ROOT,
    artifactsDir: ARTIFACTS_DIR,
    network: NETWORK,
    chainId: arbitrumSepoliaNetworkConfig.chainId,
    releaseId,
    generatedAt,
    registry: core.Registry,
    core,
    sourceFiles: baselineSourceFiles,
    nameToKey: EVM_NAME_TO_KEY,
    provider: new JsonRpcProvider(resolveRpcUrl()),
    eip1967ImplementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    noCodeAllowed: NO_CODE_ALLOWED,
    artifactAliases: IMPLEMENTATION_ARTIFACT_ALIASES,
  });

  const releaseArtifact = buildFrontendReleaseArtifact({
    network: NETWORK,
    chainId: arbitrumSepoliaNetworkConfig.chainId,
    releaseId,
    generatedAt,
    registry: core.Registry,
    sourceFiles: baselineSourceFiles,
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
    displayLabel: "Arbitrum Sepolia",
    network: NETWORK,
    chainId: arbitrumSepoliaNetworkConfig.chainId,
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL?.trim()
      || process.env.ARBITRUM_SEPOLIA_URL?.trim()
      || "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: arbitrumSepoliaNetworkConfig.explorerBaseUrl ?? "https://sepolia.arbiscan.io",
  });

  console.log(`releaseId=${releaseId}`);
  console.log(`baselineFile=${path.relative(ROOT, BASELINE_FILE)}`);
  console.log(`frontendReleaseFile=${path.relative(ROOT, FRONTEND_RELEASE_FILE)}`);
  console.log(`frontendConfigFile=${path.relative(ROOT, CANONICAL_FRONTEND_FILE)}`);
  console.log(`manifestFile=${path.relative(ROOT, MANIFEST_FILE)}`);
}

void main();