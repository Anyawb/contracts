import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

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
  resumed?: boolean;
};

type ReleaseCheckpoint = {
  completedStepIds: string[];
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

function readCheckpoint(checkpointFile: string): ReleaseCheckpoint {
  if (!fs.existsSync(checkpointFile)) {
    return { completedStepIds: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointFile, "utf8")) as Partial<ReleaseCheckpoint>;
    const completedStepIds = Array.isArray(parsed.completedStepIds)
      ? parsed.completedStepIds.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    return { completedStepIds };
  } catch {
    return { completedStepIds: [] };
  }
}

function writeCheckpoint(checkpointFile: string, checkpoint: ReleaseCheckpoint) {
  fs.writeFileSync(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
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

function runStep(step: Step, network: string, logFile: string): Promise<StepResult> {
  const args = ["-s", "exec", "hardhat", "run", step.file, "--network", network];
  fs.writeFileSync(logFile, "", "utf8");

  return new Promise((resolve) => {
    const child = spawn(pnpmBin(), args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const appendChunk = (chunk: Buffer, isStdErr: boolean) => {
      const text = chunk.toString();
      fs.appendFileSync(logFile, text, "utf8");
      if (isStdErr) {
        process.stderr.write(text);
      } else {
        process.stdout.write(text);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => appendChunk(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => appendChunk(chunk, true));

    child.on("error", (error) => {
      const text = `\n[runStep error] ${error instanceof Error ? error.message : String(error)}\n`;
      fs.appendFileSync(logFile, text, "utf8");
      process.stderr.write(text);
      resolve({
        step,
        status: 1,
        logFile,
      });
    });

    child.on("close", (code) => {
      resolve({
        step,
        status: code ?? 1,
        logFile,
      });
    });
  });
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
  const resumeOnRetry = envBool("LIVE_RELEASE_RESUME_ON_RETRY", true);
  const requestedLogDir = envStr("LIVE_RELEASE_LOG_DIR");
  const resolvedLogDir = requestedLogDir && requestedLogDir.length > 0
    ? requestedLogDir
    : path.join(
      process.cwd(),
      "scripts",
      "tests",
      "logs",
      `live-release-gates-${scriptNetwork}-via-${executionNetwork}-${nowId()}`,
    );
  process.env.LIVE_RELEASE_LOG_DIR = resolvedLogDir;
  const logDir = path.join(
    process.cwd(),
    resolvedLogDir,
  );
  const checkpointFile = path.join(logDir, "checkpoint.json");
  const checkpoint = readCheckpoint(checkpointFile);
  const scriptDir = networkScriptDir(scriptNetwork);
  fs.mkdirSync(logDir, { recursive: true });

  configureLocalhostSettlementEnv(executionNetwork, network);

  if ((executionNetwork === "localhost" || executionNetwork === "hardhat") && !skipLocalhostBootstrap) {
    const prepStep: Step = {
      id: "00-localhost-bootstrap",
      label: "localhost live gate bootstrap",
      file: "scripts/tests/live-test/networks/bnb-testnet/cases/prepare-live-gates-localhost.ts",
    };
    console.log("\n=== [bootstrap] localhost live gate bootstrap ===");
    const prepResult = await runStep(prepStep, executionNetwork, path.join(logDir, `${prepStep.id}.log`));
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
      id: "09-blocks-only-liquidation",
      label: "blocks-only maturity-delivery funds-chain",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-blocks-only-liquidation.ts`,
    },
    {
      id: "10-ops-extension-modules",
      label: "ops extension modules",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-ops-extension-modules.ts`,
    },
    {
      id: "11-shortfall-bootstrap-guard",
      label: "shortfall non-bootstrapping guard",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-shortfall-bootstrap-guard.ts`,
      envHints: [
        "localhost/fork execution network required for impersonation-based check",
      ],
    },
  ];

  console.log("=== Live Release Gates ===");
  console.log(`logicalNetwork=${network}`);
  console.log(`scriptNetwork=${scriptNetwork}`);
  console.log(`executionNetwork=${executionNetwork}`);
  console.log(`logDir=${logDir}`);
  console.log(`continueOnError=${continueOnError}`);
  console.log(`resumeOnRetry=${resumeOnRetry}`);
  if (resumeOnRetry && checkpoint.completedStepIds.length > 0) {
    console.log(`resume.completedSteps=${checkpoint.completedStepIds.join(",")}`);
  }

  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    const stepLogFile = path.join(logDir, `${step.id}.log`);
    if (resumeOnRetry && checkpoint.completedStepIds.includes(step.id) && fs.existsSync(stepLogFile)) {
      console.log(`\n=== [${index + 1}/${steps.length}] ${step.label} (resume: skipped, already passed) ===`);
      results.push({
        step,
        status: 0,
        logFile: stepLogFile,
        resumed: true,
      });
      continue;
    }

    console.log(`\n=== [${index + 1}/${steps.length}] ${step.label} ===`);
    const result = await runStep(step, executionNetwork, stepLogFile);
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
    } else if (!checkpoint.completedStepIds.includes(step.id)) {
      checkpoint.completedStepIds.push(step.id);
      writeCheckpoint(checkpointFile, checkpoint);
    }
  }

  const failed = results.filter((item) => item.status !== 0);
  console.log("\n=== Live Release Gates Summary ===");
  for (const result of results) {
    const marker = result.status === 0 ? "PASS" : "FAIL";
    const resumeTag = result.resumed ? " (resumed)" : "";
    console.log(`${marker} ${result.step.label}${resumeTag} log=${result.logFile}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);