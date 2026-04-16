import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

type Step = {
  id: string;
  label: string;
  file: string;
  env?: Record<string, string>;
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

function runStep(step: Step, executionNetwork: string, logFile: string): Promise<StepResult> {
  const args = ["-s", "exec", "hardhat", "run", step.file, "--network", executionNetwork];
  fs.writeFileSync(logFile, "", "utf8");

  return new Promise((resolve) => {
    const child = spawn(pnpmBin(), args, {
      env: {
        ...process.env,
        ...step.env,
      },
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
      resolve({ step, status: 1, logFile });
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
  const logicalNetwork = envStr("LIVE_RELEASE_NETWORK", "bnbTestnet")!;
  const executionNetwork = envStr("LIVE_RELEASE_EXECUTION_NETWORK", logicalNetwork)!;
  if (logicalNetwork !== "bnbTestnet" || executionNetwork !== "bnbTestnet") {
    throw new Error(`layer-b release gates currently support bnbTestnet only (logical=${logicalNetwork} execution=${executionNetwork})`);
  }

  const continueOnError = envBool("LIVE_RELEASE_CONTINUE_ON_ERROR", false);
  const resumeOnRetry = envBool("LIVE_RELEASE_RESUME_ON_RETRY", true);
  const requestedLogDir = envStr("LIVE_RELEASE_LOG_DIR");
  const resolvedLogDir = requestedLogDir && requestedLogDir.length > 0
    ? requestedLogDir
    : path.join("scripts", "tests", "logs", `live-release-gates-layer-b-${logicalNetwork}-via-${executionNetwork}-${nowId()}`);
  process.env.LIVE_RELEASE_LOG_DIR = resolvedLogDir;

  const logDir = path.isAbsolute(resolvedLogDir)
    ? resolvedLogDir
    : path.join(process.cwd(), resolvedLogDir);
  const checkpointFile = path.join(logDir, "checkpoint.json");
  const checkpoint = readCheckpoint(checkpointFile);
  fs.mkdirSync(logDir, { recursive: true });

  const baseDir = "scripts/tests/live-test/networks/bnb-testnet";
  const steps: Step[] = [
    {
      id: "01-platform-architecture",
      label: "platform architecture routes",
      file: `${baseDir}/live-view-registry-routes.ts`,
    },
    {
      id: "02-fee-governance",
      label: "fee governance consistency",
      file: `${baseDir}/live-fee-config-governance.ts`,
    },
    {
      id: "03-reward-governance",
      label: "reward governance consistency",
      file: `${baseDir}/live-reward-config-governance.ts`,
    },
    {
      id: "04-guarantee-architecture",
      label: "guarantee release forfeit architecture",
      file: `${baseDir}/live-guarantee-events-datapush.ts`,
    },
    {
      id: "05-reserve-architecture",
      label: "reserve transfer architecture",
      file: `${baseDir}/live-cancel-reserve.ts`,
      env: {
        LIVE_STRICT_RESERVE_SINGLE_MODEL: "1",
        LIVE_STRICT_RESERVE_EXPECTED_MODEL: "transfer",
      },
      envHints: [
        "requires isolated reserve path under transfer-strict mode",
      ],
    },
    {
      id: "06-withdraw-boundary",
      label: "withdraw boundary consistency",
      file: `${baseDir}/live-withdraw-collateral.ts`,
    },
    {
      id: "07-view-contract-compat",
      label: "lending view contract compatibility",
      file: `${baseDir}/live-view-facade-gate.ts`,
    },
    {
      id: "08-liquidation-architecture",
      label: "liquidation registry preflight",
      file: `${baseDir}/live-liquidation-registry-preflight.ts`,
    },
    {
      id: "09-blocks-only-architecture",
      label: "blocks-only prematurity architecture",
      file: `${baseDir}/live-blocks-only-liquidation.ts`,
      env: {
        LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: "1",
      },
      envHints: [
        "requires confirmed pre-maturity proof; mature-before-proof is a hard fail in layer-b",
      ],
    },
    {
      id: "10-ops-extension-architecture",
      label: "ops extension governance boundaries",
      file: `${baseDir}/live-ops-extension-modules.ts`,
    },
  ];

  console.log("=== Live Release Gates Layer-B ===");
  console.log(`logicalNetwork=${logicalNetwork}`);
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
  console.log("\n=== Live Release Gates Layer-B Summary ===");
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