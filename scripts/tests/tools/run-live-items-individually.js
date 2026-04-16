const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const workspaceRoot = process.cwd();
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const logDir = path.join(workspaceRoot, "scripts/tests/logs", `live-individual-rerun-${timestamp}`);
const summaryFile = path.join(logDir, "summary.log");
const wrapperPath = path.join(workspaceRoot, "scripts/tests/tools/run-live-script-with-sweep.js");
const network = process.env.LIVE_TEST_NETWORK;
if (!network || !network.trim()) {
  throw new Error("LIVE_TEST_NETWORK is required for live individual reruns");
}
process.env.LIVE_TEST_NETWORK = network;
const {
  seedCase,
  liquidationSeedCase,
  liveTestCases,
  seededLiquidationCaseLabels,
} = require("./live-test-cases");
const seedRequired = (process.env.LIVE_INDIVIDUAL_SEED_REQUIRED?.trim() || "") === "1";
const networkRetryPatterns = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "socket hang up",
  "other side closed",
  "Headers Timeout Error",
];
const maxNetworkAttempts = Number(process.env.LIVE_RUNNER_NETWORK_MAX_ATTEMPTS || 2);

fs.mkdirSync(logDir, { recursive: true });

function appendBlock(title, lines) {
  appendSummary(`--- ${title} ---`);
  for (const line of lines) {
    appendSummary(line);
  }
  appendSummary(`--- end ${title} ---`);
}

function readTailLines(filePath, maxLines = 60) {
  if (!filePath || filePath === "unknown" || !fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);
}

function appendFailureArtifacts(label, filePath, artifactLabel) {
  const tailLines = readTailLines(filePath);
  if (tailLines.length === 0) {
    return;
  }
  appendBlock(`${label} ${artifactLabel} tail`, tailLines);
}

function appendSummary(line) {
  fs.appendFileSync(summaryFile, `${line}\n`);
}

function isRetryableNetworkFailureText(text) {
  if (!text) {
    return false;
  }
  const normalized = String(text);
  return networkRetryPatterns.some((pattern) => normalized.includes(pattern));
}

function writeSectionHeader(title) {
  appendSummary(`=== ${title} ===`);
}

function parseSeededLiquidationEnv(logFile) {
  const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const orderId = content.match(/^SEEDED_LIQUIDATION_ORDER_ID=(.*)$/m)?.[1]?.trim();
  const acceptRiskTriggeredOrder = content.match(/^SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=(.*)$/m)?.[1]?.trim() ?? "1";
  if (!orderId) {
    return null;
  }
  return {
    LIQUIDATION_ORDER_ID: orderId,
    LIQUIDATION_FALLBACK_ORDER_ID: orderId,
    LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER: acceptRiskTriggeredOrder,
  };
}

function runCommand(label, command, extraEnv) {
  writeSectionHeader(`START ${label}`);
  const caseLogFile = path.join(logDir, `${label}.log`);
  let result;
  let attempt = 0;
  let combinedOutput = "";
  while (attempt < maxNetworkAttempts) {
    attempt += 1;
    result = spawnSync(command, {
      shell: true,
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 32,
      env: {
        ...process.env,
        ...extraEnv,
        FULL_LIVE_LOGDIR: logDir,
      },
    });
    combinedOutput = `${result.stdout || ""}${result.stderr || ""}`;
    fs.writeFileSync(caseLogFile, combinedOutput);
    if (result.status === 0 || !isRetryableNetworkFailureText(combinedOutput) || attempt >= maxNetworkAttempts) {
      break;
    }
    appendSummary(`RETRY(network ${attempt}/${maxNetworkAttempts}) ${label}`);
  }
  appendSummary(`${result.status === 0 ? "PASS" : `FAIL(${result.status ?? 1})`} ${label}`);
  appendSummary(`LOGFILE=${caseLogFile}`);
  if (result.status !== 0) {
    appendFailureArtifacts(label, caseLogFile, "log");
  }
  return result;
}

function runWrappedCase(label, command, extraEnv = {}) {
  writeSectionHeader(`START ${label}`);
  let result;
  let combined = "";
  let stateFile = "unknown";
  let caseLogFile = "unknown";
  let sweepStatus = "unknown";
  let wrapperLogFile = "unknown";
  let attempt = 0;
  while (attempt < maxNetworkAttempts) {
    attempt += 1;
    result = spawnSync(
      process.execPath,
      [wrapperPath, "--label", label, "--command", command, "--network", network],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 32,
        env: {
          ...process.env,
          ...extraEnv,
          FULL_LIVE_LOGDIR: logDir,
        },
      },
    );
    const wrapperStdout = result.stdout || "";
    const wrapperStderr = result.stderr || "";
    combined = `${wrapperStdout}${wrapperStderr}`;
    stateFile = combined.match(/^STATE_FILE=(.*)$/m)?.[1] ?? "unknown";
    caseLogFile = combined.match(/^LOGFILE=(.*)$/m)?.[1] ?? "unknown";
    sweepStatus = combined.match(/^SWEEP_STATUS=(.*)$/m)?.[1] ?? "unknown";
    wrapperLogFile = "unknown";
    if (combined.trim()) {
      wrapperLogFile = path.join(logDir, `${label}.wrapper.log`);
      fs.writeFileSync(wrapperLogFile, combined);
    }
    const caseOutput = caseLogFile !== "unknown" && fs.existsSync(caseLogFile)
      ? fs.readFileSync(caseLogFile, "utf8")
      : "";
    const retryableFailure = result.status !== 0
      && (isRetryableNetworkFailureText(combined) || isRetryableNetworkFailureText(caseOutput));
    if (!retryableFailure || attempt >= maxNetworkAttempts) {
      break;
    }
    appendSummary(`RETRY(network ${attempt}/${maxNetworkAttempts}) ${label}`);
  }
  appendSummary(`${result.status === 0 ? "PASS" : `FAIL(${result.status ?? 1})`} ${label}`);
  appendSummary(`LOGFILE=${caseLogFile}`);
  appendSummary(`STATE_FILE=${stateFile}`);
  appendSummary(`SWEEP_STATUS=${sweepStatus}`);
  if (combined.trim()) {
    appendSummary(`WRAPPER_LOGFILE=${wrapperLogFile}`);
  }
  if (result.status !== 0) {
    appendFailureArtifacts(label, caseLogFile, "case log");
    appendFailureArtifacts(label, wrapperLogFile, "wrapper log");
  }
  return {
    ...result,
    caseLogFile,
    stateFile,
    wrapperLogFile,
  };
}

function runSeededLiquidationCase(targetLabel) {
  const seedLabel = `${liquidationSeedCase[0]}-for-${targetLabel}`;
  const result = runWrappedCase(seedLabel, liquidationSeedCase[1]);
  if (result.status !== 0) {
    appendSummary(`FAIL(seed) ${targetLabel}`);
    appendSummary(`SEED_LABEL=${seedLabel}`);
    return { status: result.status ?? 1, env: null };
  }
  const env = parseSeededLiquidationEnv(result.caseLogFile);
  if (!env) {
    appendSummary(`FAIL(seed-parse) ${targetLabel}`);
    appendSummary(`SEED_LABEL=${seedLabel}`);
    appendFailureArtifacts(seedLabel, result.caseLogFile, "seed parse log");
    return { status: 1, env: null };
  }
  appendSummary(`SEEDED_LIQUIDATION_ORDER_ID=${env.LIQUIDATION_ORDER_ID}`);
  appendSummary(`SEEDED_LIQUIDATION_TARGET=${targetLabel}`);
  return { status: 0, env };
}

let failCount = 0;

fs.writeFileSync(
  summaryFile,
  [
    `LOGDIR=${logDir}`,
    "MODE=individual-live-cases",
    "FRESH_BORROWER_MODE=generated-per-case",
    "",
  ].join("\n"),
);

const seedResult = runCommand(seedCase[0], seedCase[1], {});
if (seedResult.status !== 0) {
  failCount += 1;
  appendSummary(`SEED_FAILED_CONTINUE=${seedRequired ? "false" : "true"}`);
  if (seedRequired) {
    appendSummary(`TOTAL_FAILS=${failCount}`);
    console.log(`LOGDIR=${logDir}`);
    console.log(`TOTAL_FAILS=${failCount}`);
    process.exit(seedResult.status ?? 1);
  }
}

for (const [label, command] of liveTestCases) {
  let extraEnv = {};
  if (seededLiquidationCaseLabels.includes(label)) {
    const seeded = runSeededLiquidationCase(label);
    if (seeded.status !== 0 || !seeded.env) {
      failCount += 1;
      continue;
    }
    extraEnv = seeded.env;
  }
  const result = runWrappedCase(label, command, extraEnv);
  if (result.status !== 0) {
    failCount += 1;
  }
}

appendSummary(`TOTAL_FAILS=${failCount}`);
console.log(`LOGDIR=${logDir}`);
console.log("MODE=individual-live-cases");
console.log(`TOTAL_FAILS=${failCount}`);
process.exit(failCount === 0 ? 0 : 1);