import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

type Step = {
  id: string;
  label: string;
  file: string;
  envHints?: string[];
};

type StepResult = {
  step: Step;
  status: number;
  logFile: string;
};

function networkScriptDir(network: string) {
  switch (network) {
    case "bnbTestnet":
      return "bnb-testnet";
    case "arbitrumSepolia":
      return "arbitrum-sepolia";
    default:
      throw new Error(`unsupported LIVE_RELEASE network: ${network}`);
  }
}

function requireNetworkEnv(name: string): string {
  const value = envStr(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envStr(name: string, def?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const value = raw.trim();
  return value.length ? value : def;
}

function envBool(name: string, def = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function nowId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

function configureLocalhostSettlementEnv(executionNetwork: string, logicalNetwork: string) {
  if (executionNetwork !== "localhost" && executionNetwork !== "hardhat") {
    return;
  }
  if (logicalNetwork !== executionNetwork) {
    return;
  }
  if (envStr("SETTLEMENT_TOKEN_ADDRESS")) {
    return;
  }

  const deployMapFile = path.join(process.cwd(), "scripts", "deployments", `${executionNetwork}.json`);
  const deployMap = JSON.parse(fs.readFileSync(deployMapFile, "utf8")) as Record<string, string>;
  const settlementToken = deployMap.MockUSDC ?? deployMap.SettlementToken;
  if (!settlementToken) {
    throw new Error(`unable to resolve localhost settlement token from ${deployMapFile}`);
  }

  process.env.SETTLEMENT_TOKEN_ADDRESS = settlementToken;
  process.env.SETTLEMENT_TOKEN_SYMBOL = envStr("SETTLEMENT_TOKEN_SYMBOL", "USDC")!;
  process.env.SETTLEMENT_TOKEN_SOURCE_ID = envStr(
    "SETTLEMENT_TOKEN_SOURCE_ID",
    envStr("SETTLEMENT_TOKEN_COINGECKO_ID", "usd-coin"),
  )!;
  process.env.SETTLEMENT_TOKEN_COINGECKO_ID = process.env.SETTLEMENT_TOKEN_SOURCE_ID;
  process.env.SETTLEMENT_TOKEN_DECIMALS = envStr("SETTLEMENT_TOKEN_DECIMALS", "6")!;
  process.env.SETTLEMENT_PRICE_VALUE = envStr("SETTLEMENT_PRICE_VALUE", "1")!;
}

function runStep(step: Step, network: string, logFile: string): StepResult {
  const args = ["-s", "exec", "hardhat", "run", step.file, "--network", network];
  const result = spawnSync(pnpmBin(), args, {
    env: process.env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(logFile, output, "utf8");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return {
    step,
    status: result.status ?? 1,
    logFile,
  };
}

async function main() {
  const network = requireNetworkEnv("LIVE_RELEASE_NETWORK");
  const executionNetwork = envStr("LIVE_RELEASE_EXECUTION_NETWORK", network)!;
  const scriptNetwork = envStr("LIVE_RELEASE_SCRIPT_NETWORK", network)!;
  if (scriptNetwork === "localhost" || scriptNetwork === "hardhat") {
    throw new Error(
      `LIVE_RELEASE_SCRIPT_NETWORK must be an explicit live wrapper network, received ${scriptNetwork}; choose bnbTestnet or arbitrumSepolia`,
    );
  }
  const continueOnError = envBool("LIVE_RELEASE_CONTINUE_ON_ERROR", false);
  const skipLocalhostBootstrap = envBool("LIVE_RELEASE_SKIP_LOCALHOST_BOOTSTRAP", false);
  const logDir = path.join(
    process.cwd(),
    "scripts",
    "tests",
    "logs",
    `live-release-gates-${scriptNetwork}-via-${executionNetwork}-${nowId()}`,
  );
  const scriptDir = networkScriptDir(scriptNetwork);
  fs.mkdirSync(logDir, { recursive: true });

  configureLocalhostSettlementEnv(executionNetwork, network);

  if ((executionNetwork === "localhost" || executionNetwork === "hardhat") && !skipLocalhostBootstrap) {
    const prepStep: Step = {
      id: "00-localhost-bootstrap",
      label: "localhost live gate bootstrap",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/cases/prepare-live-gates-localhost.ts",
    };
    console.log("\n=== [bootstrap] localhost live gate bootstrap ===");
    const prepResult = runStep(prepStep, executionNetwork, path.join(logDir, `${prepStep.id}.log`));
    if (prepResult.status !== 0) {
      console.error(`step failed: ${prepStep.label}`);
      console.error(`log=${prepResult.logFile}`);
      process.exit(1);
    }
  }

  const steps: Step[] = [
    {
      id: "01-platform-baseline",
      label: "platform full baseline",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-platform-baseline.ts`,
    },
    {
      id: "02-fee-baseline",
      label: "fee full baseline",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-fee-baseline.ts`,
    },
    {
      id: "03-reward-baseline",
      label: "reward full baseline",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-reward-baseline.ts`,
    },
    {
      id: "04-guarantee-baseline",
      label: "guarantee full baseline",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-guarantee-baseline.ts`,
    },
    {
      id: "05-cancel-reserve",
      label: "reserve cancel restore",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-cancel-reserve.ts`,
    },
    {
      id: "06-withdraw-collateral",
      label: "withdraw collateral",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-withdraw-collateral.ts`,
    },
    {
      id: "07-lending-engine-view",
      label: "lending engine view ssot",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-lending-engine-view.ts`,
    },
    {
      id: "08-liquidation",
      label: "legacy liquidation funds-chain",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-liquidation.ts`,
    },
    {
      id: "09-shortfall-ledger",
      label: "shortfall ledger state machine",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-shortfall-ledger.ts`,
      envHints: [
        "LIVE_SHORTFALL_ORDER_ID or LIVE_SHORTFALL_SEED_LOG_FILE",
        "LIVE_SHORTFALL_ENABLE_WRITE_RECOVERY=1 for optional write-path checks",
      ],
    },
    {
      id: "10-blocks-only-liquidation",
      label: "blocks-only maturity-delivery funds-chain",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-blocks-only-liquidation.ts`,
    },
    {
      id: "11-ops-extension-modules",
      label: "ops extension modules",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-ops-extension-modules.ts`,
    },
  ];

  console.log("=== Live Release Gates ===");
  console.log(`logicalNetwork=${network}`);
  console.log(`scriptNetwork=${scriptNetwork}`);
  console.log(`executionNetwork=${executionNetwork}`);
  console.log(`logDir=${logDir}`);
  console.log(`continueOnError=${continueOnError}`);

  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    console.log(`\n=== [${index + 1}/${steps.length}] ${step.label} ===`);
    const result = runStep(step, executionNetwork, path.join(logDir, `${step.id}.log`));
    results.push(result);
    if (result.status !== 0) {
      console.error(`step failed: ${step.label}`);
      console.error(`log=${result.logFile}`);
      if (step.envHints?.length) {
        console.error(`env hints: ${step.envHints.join("; ")}`);
      }
      if (!continueOnError) {
        break;
      }
    }
  }

  const failed = results.filter((item) => item.status !== 0);
  console.log("\n=== Live Release Gates Summary ===");
  for (const result of results) {
    console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${result.step.label} log=${result.logFile}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
