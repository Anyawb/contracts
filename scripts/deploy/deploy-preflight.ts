import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { deployProfiles, getLiveTestProfile } from "../config/profiles";
import {
  arbitrumSepoliaNetworkConfig,
  bnbTestnetNetworkConfig,
  type NetworkConfig,
} from "../config/networks";

type IssueLevel = "error" | "warn";

type Issue = {
  level: IssueLevel;
  network: string;
  check: string;
  detail: string;
};

type ScriptExpectation = {
  name: string;
  command: string;
};

type JsonExpectation = {
  kind: "json";
  label: string;
  path: string;
  requiredFields: string[];
};

type TextExpectation = {
  kind: "text";
  label: string;
  path: string;
  mustContain?: string[];
  mustNotContain?: string[];
};

type FileExpectation = JsonExpectation | TextExpectation;

type NetworkPreflightSpec = {
  key: string;
  display: string;
  slug: string;
  config: NetworkConfig;
  deployEntryFile: string;
  deployEntryImportTarget: string;
  coreDeployFile: string;
  manifestFile: string;
  mockSuiteDeployFile?: string;
  frontendConfigFile: string;
  generatedAssetsFile: string;
  generatedMockAssetPackFile: string;
  packageScripts: ScriptExpectation[];
  deployFiles: FileExpectation[];
  runtimeArtifacts: FileExpectation[];
  forkFiles: FileExpectation[];
};

const GLOBAL_SCRIPT_EXPECTATIONS: ScriptExpectation[] = [
  {
    name: 'deploy:preflight',
    command: 'ts-node --project ./tsconfig.scripts.json scripts/deploy/deploy-preflight.ts',
  },
];

const NETWORK_SPECS: NetworkPreflightSpec[] = [
  {
    key: "arbitrumSepolia",
    display: "Arbitrum Sepolia",
    slug: "arbitrum-sepolia",
    config: arbitrumSepoliaNetworkConfig,
    deployEntryFile: "scripts/deploy/networks/arbitrum-sepolia/deploy.ts",
    deployEntryImportTarget: "../../deploy-arbitrum-sepolia",
    coreDeployFile: 'scripts/deployments/arbitrum-sepolia.json',
    manifestFile: 'scripts/deployments/arbitrum-sepolia.manifest.json',
    mockSuiteDeployFile: 'scripts/deployments/arbitrum-sepolia.mock-suite.json',
    frontendConfigFile: 'frontend-config/networks/arbitrum-sepolia.ts',
    generatedAssetsFile: 'deployments/assets.arbitrum-sepolia.mock.json',
    generatedMockAssetPackFile: 'deployments/mock-assets.arbitrum-sepolia.json',
    packageScripts: [
      {
        name: 'deploy:preflight:arbitrum-sepolia',
        command: 'ts-node --project ./tsconfig.scripts.json scripts/deploy/deploy-preflight.ts --network arbitrumSepolia',
      },
      {
        name: 'deploy:arbitrum-sepolia',
        command: 'hardhat run scripts/deploy/networks/arbitrum-sepolia/deploy.ts --network arbitrumSepolia',
      },
      {
        name: 'deploy:mock-assets:arbitrum-sepolia',
        command: 'hardhat run scripts/deploy/deploy-mock-asset-pack.ts --network arbitrumSepolia',
      },
      {
        name: 'export:rwa-price-catalog:arbitrum-sepolia',
        command: 'hardhat run scripts/deploy/export-rwa-price-catalog.ts --network arbitrumSepolia',
      },
      {
        name: 'seed:mock-asset-prices:arbitrum-sepolia',
        command: 'hardhat run scripts/deploy/seed-mock-asset-prices.ts --network arbitrumSepolia',
      },
    ],
    deployFiles: [
      {
        kind: "text",
        label: "Arbitrum deploy body",
        path: "scripts/deploy/deploy-arbitrum-sepolia.ts",
        mustContain: [
          'const ARBITRUM_SEPOLIA_CONFIG = {',
          'name: "arbitrum-sepolia"',
          'verifyApiKeyEnv: "ARBISCAN_API_KEY"',
        ],
        mustNotContain: [
          "DEPLOY_TARGET_CONFIG",
          "DEPLOY_TARGET_",
          "isBnbDeployTarget",
          '"bnb-testnet"',
        ],
      },
    ],
    runtimeArtifacts: [
      {
        kind: "json",
        label: "Arbitrum live deploy output",
        path: "scripts/deployments/arbitrum-sepolia.mock-suite.json",
        requiredFields: ["Registry"],
      },
      {
        kind: "json",
        label: "Arbitrum core deploy output",
        path: "scripts/deployments/arbitrum-sepolia.json",
        requiredFields: ["Registry"],
      },
      {
        kind: "json",
        label: "Arbitrum assets file",
        path: "deployments/assets.arbitrum-sepolia.mock.json",
        requiredFields: ["assets"],
      },
      {
        kind: "json",
        label: "Arbitrum mock asset pack",
        path: "deployments/mock-assets.arbitrum-sepolia.json",
        requiredFields: ["settlementToken", "assets"],
      },
      {
        kind: "text",
        label: "Arbitrum frontend network config",
        path: "frontend-config/networks/arbitrum-sepolia.ts",
      },
    ],
    forkFiles: [
      {
        kind: "text",
        label: "Arbitrum backend-required fork runner",
        path: "scripts/tests/fork-test/networks/arbitrum-sepolia/backend-required-block.autonode.ts",
        mustContain: ["live-warmup.ts", "arbitrum-sepolia"],
      },
      {
        kind: "text",
        label: "Arbitrum multi-stablecoin fork runner",
        path: "scripts/tests/fork-test/networks/arbitrum-sepolia/smoke-multi-stablecoin.autonode.ts",
      },
    ],
  },
  {
    key: "bnbTestnet",
    display: "BNB Testnet",
    slug: "bnb-testnet",
    config: bnbTestnetNetworkConfig,
    deployEntryFile: "scripts/deploy/networks/bnb-testnet/deploy.ts",
    deployEntryImportTarget: "../../deploy-bnb-testnet",
    coreDeployFile: 'scripts/deployments/bnb-testnet/core.json',
    manifestFile: 'scripts/deployments/bnb-testnet/manifest.json',
    mockSuiteDeployFile: 'scripts/deployments/bnb-testnet/mock-suite.json',
    frontendConfigFile: 'frontend-config/networks/bnb-testnet.ts',
    generatedAssetsFile: 'deployments/assets.bnb-testnet.mock.json',
    generatedMockAssetPackFile: 'deployments/mock-assets.bnb-testnet.json',
    packageScripts: [
      {
        name: 'deploy:preflight:bnb-testnet',
        command: 'ts-node --project ./tsconfig.scripts.json scripts/deploy/deploy-preflight.ts --network bnbTestnet',
      },
      {
        name: 'deploy:bnb-testnet',
        command: 'hardhat run scripts/deploy/networks/bnb-testnet/deploy.ts --network bnbTestnet',
      },
      {
        name: 'deploy:mock-assets:bnb-testnet',
        command: 'hardhat run scripts/deploy/deploy-mock-asset-pack.ts --network bnbTestnet',
      },
      {
        name: 'test:live:fork:bnb-testnet',
        command: 'ts-node --project ./tsconfig.scripts.json scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts',
      },
      {
        name: 'test:live:platform-baseline:fork:bnb-testnet',
        command: 'BNB_FORK_AUTONODE_CASES=platform-baseline ts-node --project ./tsconfig.scripts.json scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts',
      },
      {
        name: 'test:live:release-gates:fork:bnb-testnet',
        command: 'BNB_FORK_AUTONODE_CASES=release-gates ts-node --project ./tsconfig.scripts.json scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts',
      },
    ],
    deployFiles: [
      {
        kind: "text",
        label: "BNB deploy wrapper",
        path: "scripts/deploy/deploy-bnb-testnet.ts",
        mustContain: [
          "await import('./deploy-bnb-testnet-core');",
          "process.env.DEPLOY_OUTPUT_FILE = profile.outputs.coreDeployFile;",
          "process.env.MOCK_ASSET_PACK_OUTPUT = process.env.MOCK_ASSET_PACK_OUTPUT || resolveGeneratedMockPackOutput(profile);",
          "MOCK_ASSET_PACK_FILE: profile.inputs.mockAssetPackSpecFile,",
        ],
        mustNotContain: ["deploy-arbitrum-sepolia", "DEPLOY_TARGET_"],
      },
      {
        kind: "text",
        label: "BNB deploy core",
        path: "scripts/deploy/deploy-bnb-testnet-core.ts",
        mustContain: [
          'const BNB_TESTNET_CONFIG = {',
          'name: "bnb-testnet"',
          'verifyApiKeyEnv: "BSCSCAN_API_KEY"',
        ],
        mustNotContain: [
          "DEPLOY_TARGET_CONFIG",
          "DEPLOY_TARGET_",
          "Arbitrum Sepolia",
          "arbitrum-sepolia",
          "ARBISCAN_API_KEY",
        ],
      },
    ],
    runtimeArtifacts: [
      {
        kind: "json",
        label: "BNB deploy output",
        path: "scripts/deployments/bnb-testnet/core.json",
        requiredFields: ["Registry"],
      },
      {
        kind: "json",
        label: "BNB assets file",
        path: "deployments/assets.bnb-testnet.mock.json",
        requiredFields: ["assets"],
      },
      {
        kind: "json",
        label: "BNB mock asset pack",
        path: "deployments/mock-assets.bnb-testnet.json",
        requiredFields: ["settlementToken", "assets"],
      },
      {
        kind: "text",
        label: "BNB frontend network config",
        path: "frontend-config/networks/bnb-testnet.ts",
      },
    ],
    forkFiles: [
      {
        kind: "text",
        label: "BNB fork runner",
        path: "scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts",
        mustContain: [
          "const profile = getLiveTestProfile('bnbTestnet');",
          "DEPLOY_OUTPUT_FILE: process.env.DEPLOY_OUTPUT_FILE ?? profile.deployOutputFile",
          "ASSETS_FILE: process.env.ASSETS_FILE ?? profile.assetsFile",
          "MOCK_ASSET_PACK_OUTPUT: process.env.MOCK_ASSET_PACK_OUTPUT ?? profile.mockAssetsFile",
        ],
      },
      {
        kind: "text",
        label: "BNB runtime-role helper",
        path: "scripts/tests/fork-test/networks/bnb-testnet/prepare-runtime-roles.ts",
        mustContain: ["MOCK_ASSET_PACK_OUTPUT"],
      },
    ],
  },
];

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveWorkspacePath(relativePath: string): string {
  return path.resolve(process.cwd(), relativePath);
}

function readPackageScripts(): Record<string, string> {
  const packageJson = readJson('package.json');
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error('package.json has no scripts object');
  }

  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readText(relativePath: string): string {
  return fs.readFileSync(resolveWorkspacePath(relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

function pushIssue(
  issues: Issue[],
  level: IssueLevel,
  network: string,
  check: string,
  detail: string,
): void {
  issues.push({ level, network, check, detail });
}

function validateFileExpectation(
  spec: NetworkPreflightSpec,
  expectation: FileExpectation,
  issues: Issue[],
): void {
  const absolutePath = resolveWorkspacePath(expectation.path);
  if (!fs.existsSync(absolutePath)) {
    pushIssue(issues, "error", spec.display, expectation.label, `missing file: ${expectation.path}`);
    return;
  }

  if (expectation.kind === "json") {
    let parsed: Record<string, unknown>;
    try {
      parsed = readJson(expectation.path);
    } catch (error) {
      pushIssue(
        issues,
        "error",
        spec.display,
        expectation.label,
        `invalid json: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    for (const field of expectation.requiredFields) {
      const value = parsed[field];
      if (value === undefined || value === null) {
        pushIssue(issues, "error", spec.display, expectation.label, `missing field: ${field}`);
        continue;
      }
      if (field === "assets" && (!Array.isArray(value) || value.length === 0)) {
        pushIssue(issues, "error", spec.display, expectation.label, "assets must be a non-empty array");
      }
      if (field === "Registry" && typeof value !== "string") {
        pushIssue(issues, "error", spec.display, expectation.label, "Registry must be a string address");
      }
      if (field === "settlementToken" && typeof value !== "string") {
        pushIssue(issues, "error", spec.display, expectation.label, "settlementToken must be a string address");
      }
    }
    return;
  }

  const text = readText(expectation.path);
  for (const token of expectation.mustContain ?? []) {
    if (!text.includes(token)) {
      pushIssue(issues, "error", spec.display, expectation.label, `missing token: ${token}`);
    }
  }
  for (const token of expectation.mustNotContain ?? []) {
    if (text.includes(token)) {
      pushIssue(issues, "error", spec.display, expectation.label, `forbidden token present: ${token}`);
    }
  }
}

function resolveImportTarget(entryFile: string): string | undefined {
  const content = readText(entryFile);
  const match = content.match(/import\s+['"]([^'"]+)['"];?/);
  if (!match) {
    return undefined;
  }

  const rawTarget = match[1];
  const candidate = path.resolve(path.dirname(resolveWorkspacePath(entryFile)), `${rawTarget}.ts`);
  return path.relative(process.cwd(), candidate).replace(/\\/g, "/");
}

function parseNetworkArgs(argv: string[]): string[] {
  const token = argv.find((item) => item.startsWith("--network"));
  if (!token) {
    return NETWORK_SPECS.map((spec) => spec.key);
  }

  const value = token.includes("=")
    ? token.slice(token.indexOf("=") + 1)
    : argv[argv.indexOf(token) + 1];

  if (!value) {
    throw new Error("Missing value for --network");
  }

  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function runNetworkProfileCli(networkKey: string): Map<string, string> {
  const result = spawnSync(
    pnpmBin(),
    [
      "-s",
      "ts-node",
      "--project",
      "./tsconfig.scripts.json",
      "scripts/tests/tools/shared/network-profile.ts",
      "env",
      "--network",
      networkKey,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `network-profile exited with code ${result.status ?? 1}`);
  }

  const exportsMap = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    exportsMap.set(key, JSON.parse(rawValue));
  }
  return exportsMap;
}

function validateNetworkProfileEnv(spec: NetworkPreflightSpec, issues: Issue[]): void {
  const liveProfile = getLiveTestProfile(spec.key);
  let exportsMap: Map<string, string>;

  try {
    exportsMap = runNetworkProfileCli(spec.key);
  } catch (error) {
    pushIssue(
      issues,
      "error",
      spec.display,
      "network-profile env",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const requiredKeys = [
    "LIVE_PROFILE_NETWORK",
    "LIVE_PROFILE_SLUG",
    "LIVE_SWEEP_SCRIPT",
    "LIVE_SWEEP_NETWORK",
    "DEPLOY_OUTPUT_FILE",
    "ASSETS_FILE",
    "REGISTRY_ADDRESS",
    "SETTLEMENT_TOKEN_ADDRESS",
  ];

  if (liveProfile.mockAssetsFile) {
    requiredKeys.push("MOCK_ASSET_PACK_OUTPUT");
  }

  for (const key of requiredKeys) {
    if (!exportsMap.get(key)) {
      pushIssue(issues, "error", spec.display, "network-profile env", `missing export: ${key}`);
    }
  }

  const expectedPairs: Array<[string, string]> = [
    ["LIVE_PROFILE_NETWORK", liveProfile.networkKey],
    ["LIVE_PROFILE_SLUG", liveProfile.networkSlug],
    ["LIVE_SWEEP_SCRIPT", liveProfile.sweepScriptFile],
    ["LIVE_SWEEP_NETWORK", liveProfile.networkKey],
    ["DEPLOY_OUTPUT_FILE", liveProfile.deployOutputFile],
    ["ASSETS_FILE", liveProfile.assetsFile],
  ];

  if (liveProfile.mockAssetsFile) {
    expectedPairs.push(["MOCK_ASSET_PACK_OUTPUT", liveProfile.mockAssetsFile]);
  }

  for (const [key, expectedValue] of expectedPairs) {
    const actualValue = exportsMap.get(key);
    if (actualValue !== expectedValue) {
      pushIssue(
        issues,
        "error",
        spec.display,
        "network-profile env",
        `${key} mismatch: expected ${expectedValue}, got ${actualValue ?? "<missing>"}`,
      );
    }
  }

  for (const key of ["LIVE_SWEEP_SCRIPT", "DEPLOY_OUTPUT_FILE", "ASSETS_FILE", "MOCK_ASSET_PACK_OUTPUT"]) {
    const value = exportsMap.get(key);
    if (!value) continue;
    if (!fs.existsSync(resolveWorkspacePath(value))) {
      pushIssue(issues, "error", spec.display, "network-profile env", `referenced file does not exist: ${value}`);
    }
  }

  const deployOutputPath = exportsMap.get("DEPLOY_OUTPUT_FILE");
  const registryAddress = exportsMap.get("REGISTRY_ADDRESS");
  if (deployOutputPath && registryAddress && fs.existsSync(resolveWorkspacePath(deployOutputPath))) {
    const deployOutput = readJson(deployOutputPath);
    if (String(deployOutput.Registry ?? "") !== registryAddress) {
      pushIssue(issues, "error", spec.display, "network-profile env", "REGISTRY_ADDRESS does not match deploy output Registry");
    }
  }

  const mockAssetsPath = exportsMap.get("MOCK_ASSET_PACK_OUTPUT");
  const settlementTokenAddress = exportsMap.get("SETTLEMENT_TOKEN_ADDRESS");
  if (mockAssetsPath && settlementTokenAddress && fs.existsSync(resolveWorkspacePath(mockAssetsPath))) {
    const mockAssets = readJson(mockAssetsPath);
    if (String(mockAssets.settlementToken ?? "") !== settlementTokenAddress) {
      pushIssue(issues, "error", spec.display, "network-profile env", "SETTLEMENT_TOKEN_ADDRESS does not match mock asset pack settlementToken");
    }
  }
}

function validateDeployProfile(spec: NetworkPreflightSpec, issues: Issue[]): void {
  const deployProfile = deployProfiles[spec.key as keyof typeof deployProfiles];
  const liveProfile = getLiveTestProfile(spec.key);

  if (!deployProfile) {
    pushIssue(issues, "error", spec.display, "deploy profile", "missing deploy profile entry");
    return;
  }

  if (deployProfile.networkKey !== spec.key) {
    pushIssue(issues, "error", spec.display, "deploy profile", `networkKey mismatch: ${deployProfile.networkKey}`);
  }

  if (deployProfile.networkSlug !== spec.slug) {
    pushIssue(issues, "error", spec.display, "deploy profile", `networkSlug mismatch: ${deployProfile.networkSlug}`);
  }

  if (deployProfile.entrypoints.deployScriptFile !== spec.deployEntryFile) {
    pushIssue(
      issues,
      "error",
      spec.display,
      "deploy profile",
      `deployScriptFile mismatch: expected ${spec.deployEntryFile}, got ${deployProfile.entrypoints.deployScriptFile}`,
    );
  }

  if (deployProfile.outputs.coreDeployFile !== spec.coreDeployFile) {
    pushIssue(
      issues,
      'error',
      spec.display,
      'deploy profile',
      `coreDeployFile mismatch: expected ${spec.coreDeployFile}, got ${deployProfile.outputs.coreDeployFile}`,
    );
  }

  if (deployProfile.outputs.manifestFile !== spec.manifestFile) {
    pushIssue(
      issues,
      'error',
      spec.display,
      'deploy profile',
      `manifestFile mismatch: expected ${spec.manifestFile}, got ${deployProfile.outputs.manifestFile}`,
    );
  }

  if (deployProfile.outputs.mockSuiteDeployFile !== spec.mockSuiteDeployFile) {
    pushIssue(
      issues,
      'error',
      spec.display,
      'deploy profile',
      `mockSuiteDeployFile mismatch: expected ${spec.mockSuiteDeployFile ?? '<none>'}, got ${deployProfile.outputs.mockSuiteDeployFile ?? '<none>'}`,
    );
  }

  if (deployProfile.outputs.frontendConfigFile !== spec.frontendConfigFile) {
    pushIssue(
      issues,
      'error',
      spec.display,
      'deploy profile',
      `frontendConfigFile mismatch: expected ${spec.frontendConfigFile}, got ${deployProfile.outputs.frontendConfigFile ?? '<none>'}`,
    );
  }

  if (deployProfile.outputs.generatedAssetsFile !== spec.generatedAssetsFile) {
    pushIssue(
      issues,
      'error',
      spec.display,
      'deploy profile',
      `generatedAssetsFile mismatch: expected ${spec.generatedAssetsFile}, got ${deployProfile.outputs.generatedAssetsFile ?? '<none>'}`,
    );
  }

  if (deployProfile.outputs.generatedMockAssetPackFile !== spec.generatedMockAssetPackFile) {
    pushIssue(
      issues,
      'error',
      spec.display,
      'deploy profile',
      `generatedMockAssetPackFile mismatch: expected ${spec.generatedMockAssetPackFile}, got ${deployProfile.outputs.generatedMockAssetPackFile ?? '<none>'}`,
    );
  }

  if (spec.key === 'bnbTestnet') {
    const expectedInput = `deployments/assets/${spec.slug}/mock-assets.json`;
    if (deployProfile.inputs.mockAssetPackSpecFile !== expectedInput) {
      pushIssue(
        issues,
        'error',
        spec.display,
        'deploy profile',
        `mockAssetPackSpecFile mismatch: expected ${expectedInput}, got ${deployProfile.inputs.mockAssetPackSpecFile ?? '<none>'}`,
      );
    }
  }

  if (liveProfile.networkKey !== spec.key || liveProfile.networkSlug !== spec.slug) {
    pushIssue(issues, "error", spec.display, "live profile", "live profile key/slug mismatch");
  }
}

function validatePackageScripts(
  spec: NetworkPreflightSpec,
  packageScripts: Record<string, string>,
  issues: Issue[],
): void {
  for (const expectation of [...GLOBAL_SCRIPT_EXPECTATIONS, ...spec.packageScripts]) {
    const actual = packageScripts[expectation.name];
    if (!actual) {
      pushIssue(issues, 'error', spec.display, 'package scripts', `missing script: ${expectation.name}`);
      continue;
    }

    if (actual !== expectation.command) {
      pushIssue(
        issues,
        'error',
        spec.display,
        'package scripts',
        `${expectation.name} mismatch: expected ${expectation.command}, got ${actual}`,
      );
    }
  }
}

function validateEntryFile(spec: NetworkPreflightSpec, issues: Issue[]): void {
  const absolutePath = resolveWorkspacePath(spec.deployEntryFile);
  if (!fs.existsSync(absolutePath)) {
    pushIssue(issues, "error", spec.display, "deploy entry", `missing file: ${spec.deployEntryFile}`);
    return;
  }

  const resolvedTarget = resolveImportTarget(spec.deployEntryFile);
  const expectedTarget = path
    .relative(process.cwd(), path.resolve(path.dirname(absolutePath), `${spec.deployEntryImportTarget}.ts`))
    .replace(/\\/g, "/");

  if (resolvedTarget !== expectedTarget) {
    pushIssue(
      issues,
      "error",
      spec.display,
      "deploy entry",
      `entry import mismatch: expected ${expectedTarget}, got ${resolvedTarget ?? "<unresolved>"}`,
    );
  }
}

function validateSeedMockAssetPriceScript(issues: Issue[]): void {
  const content = readText("scripts/deploy/seed-mock-asset-prices.ts");
  const checks = [
    "const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();",
    'path.join(process.cwd(), "scripts", "deployments", slug, "core.json")',
    "const explicit = process.env.MOCK_ASSET_PACK_OUTPUT?.trim();",
  ];

  for (const token of checks) {
    if (!content.includes(token)) {
      pushIssue(issues, "error", "Shared", "seed-mock-asset-prices", `missing token: ${token}`);
    }
  }
}

function validateAmbientEnvDriftProtection(issues: Issue[]): void {
  const forkRunner = readText("scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts");
  const forkChecks = [
    "function sanitizeForkStepEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {",
    '"SETTLEMENT_TOKEN_ADDRESS"',
    '"BORROW_ASSET_ADDRESS"',
    '"COLLATERAL_ASSET_ADDRESS"',
    "const stepEnv = sanitizeForkStepEnv({",
  ];

  for (const token of forkChecks) {
    if (!forkRunner.includes(token)) {
      pushIssue(issues, "error", "BNB Testnet", "ambient env drift", `bnb fork runner missing token: ${token}`);
    }
  }

  const releaseGates = readText("scripts/tests/live-test/networks/bnb-testnet/cases/live-release-gates.ts");
  const releaseGateChecks = [
    "function configureLocalhostSettlementEnv(executionNetwork: string, logicalNetwork: string) {",
    "if (logicalNetwork !== executionNetwork) {",
    "configureLocalhostSettlementEnv(executionNetwork, network);",
  ];

  for (const token of releaseGateChecks) {
    if (!releaseGates.includes(token)) {
      pushIssue(issues, "error", "BNB Testnet", "ambient env drift", `release gates missing token: ${token}`);
    }
  }
}

function validateNetwork(spec: NetworkPreflightSpec): Issue[] {
  const issues: Issue[] = [];
  const packageScripts = readPackageScripts();

  if (spec.config.key !== spec.key || spec.config.slug !== spec.slug) {
    pushIssue(issues, "error", spec.display, "network config", "network config key/slug mismatch");
  }
  if (spec.config.chainId <= 0) {
    pushIssue(issues, "error", spec.display, "network config", `invalid chainId: ${spec.config.chainId}`);
  }
  if (spec.config.rpcEnvKeys.length === 0) {
    pushIssue(issues, "error", spec.display, "network config", "missing rpcEnvKeys");
  }

  validateDeployProfile(spec, issues);
  validatePackageScripts(spec, packageScripts, issues);
  validateEntryFile(spec, issues);
  validateNetworkProfileEnv(spec, issues);

  for (const expectation of spec.deployFiles) {
    validateFileExpectation(spec, expectation, issues);
  }
  for (const expectation of spec.runtimeArtifacts) {
    validateFileExpectation(spec, expectation, issues);
  }
  for (const expectation of spec.forkFiles) {
    validateFileExpectation(spec, expectation, issues);
  }

  return issues;
}

function printIssues(issues: Issue[]): void {
  if (issues.length === 0) {
    console.log("[OK] deploy preflight passed with no findings");
    return;
  }

  for (const issue of issues) {
    const tag = issue.level === "error" ? "ERROR" : "WARN";
    console.log(`[${tag}] ${issue.network} :: ${issue.check} :: ${issue.detail}`);
  }

  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const warnCount = issues.filter((issue) => issue.level === "warn").length;
  console.log(`Summary: ${errorCount} error(s), ${warnCount} warning(s)`);
}

function main(): void {
  const selectedNetworks = new Set(parseNetworkArgs(process.argv.slice(2)));
  const specs = NETWORK_SPECS.filter((spec) => selectedNetworks.has(spec.key) || selectedNetworks.has(spec.slug));
  if (specs.length === 0) {
    throw new Error(`No supported networks selected. Supported: ${NETWORK_SPECS.map((spec) => spec.key).join(", ")}`);
  }

  const issues = specs.flatMap((spec) => validateNetwork(spec));
  validateSeedMockAssetPriceScript(issues);
  validateAmbientEnvDriftProtection(issues);
  printIssues(issues);

  if (issues.some((issue) => issue.level === "error")) {
    process.exitCode = 1;
  }
}

main();