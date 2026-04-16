import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

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

function resolveWrapperNetwork() {
  const configured = envStr("LIVE_RELEASE_NETWORK");
  if (configured && configured !== "arbitrumSepolia") {
    throw new Error(`live-release-gates-arbitrum-sepolia expects LIVE_RELEASE_NETWORK=arbitrumSepolia, got ${configured}`);
  }
  process.env.LIVE_RELEASE_NETWORK = "arbitrumSepolia";
  return "arbitrumSepolia";
}

function configureLocalhostSettlementEnv(network: string) {
  if (network !== "localhost" && network !== "hardhat") {
    return;
  }
  if (envStr("SETTLEMENT_TOKEN_ADDRESS")) {
    return;
  }

  const deployMapFile = path.join(process.cwd(), "scripts", "deployments", `${network}.json`);
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
  const network = resolveWrapperNetwork();
  const continueOnError = envBool("LIVE_RELEASE_CONTINUE_ON_ERROR", false);
  const logDir = path.join(process.cwd(), "scripts", "tests", "logs", `live-release-gates-${network}-${nowId()}`);
  fs.mkdirSync(logDir, { recursive: true });

  configureLocalhostSettlementEnv(network);

  if (network === "localhost" || network === "hardhat") {
    const prepStep: Step = {
      id: "00-localhost-bootstrap",
      label: "localhost live gate bootstrap",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/cases/prepare-live-gates-localhost.ts",
    };
    console.log("\n=== [bootstrap] localhost live gate bootstrap ===");
    const prepResult = runStep(prepStep, network, path.join(logDir, `${prepStep.id}.log`));
    if (prepResult.status !== 0) {
      console.error(`step failed: ${prepStep.label}`);
      console.error(`log=${prepResult.logFile}`);
      process.exit(1);
    }
  }

  const steps: Step[] = [
    {
      id: "01-platform-baseline",
      label: "platform end-to-end funds-chain baseline",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-baseline.ts",
    },
    {
      id: "02-fee-prepaid",
      label: "fee prepaid gate",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-prepaid-gate.ts",
      envHints: ["FEE_PREPAID_AMOUNT_UNITS", "FEE_PREPAID_TYPE_NAME"],
    },
    {
      id: "03-fee-remaining",
      label: "fee remaining gate",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-remaining-gate.ts",
      envHints: ["FEE_REMAINING_AMOUNT_UNITS"],
    },
    {
      id: "04-fee-dynamic",
      label: "fee dynamic gate",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-dynamic-gate.ts",
      envHints: ["FEE_DYNAMIC_AMOUNT_UNITS", "FEE_DYNAMIC_TYPE_NAME", "FEE_DYNAMIC_BPS", "ALLOW_DYNAMIC_FEE_WRITE=1 if feeType is not preconfigured"],
    },
    {
      id: "05-shortfall-ledger",
      label: "shortfall ledger state machine",
      file: "scripts/tests/live-test/networks/arbitrum-sepolia/live-shortfall-ledger.ts",
      envHints: [
        "LIVE_SHORTFALL_ORDER_ID or LIVE_SHORTFALL_SEED_LOG_FILE",
        "LIVE_SHORTFALL_ENABLE_WRITE_RECOVERY=1 for optional write-path checks",
      ],
    },
  ];

  console.log("=== Live Release Gates ===");
  console.log(`network=${network}`);
  console.log(`logDir=${logDir}`);
  console.log(`continueOnError=${continueOnError}`);

  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    console.log(`\n=== [${index + 1}/${steps.length}] ${step.label} ===`);
    const result = runStep(step, network, path.join(logDir, `${step.id}.log`));
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

  console.log("\n✅ all live release gates passed\n");
}

main().catch((error) => {
  console.error("\n❌ live-release-gates-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});