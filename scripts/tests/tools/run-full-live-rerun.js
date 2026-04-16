const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Wallet } = require("ethers");
const { loadNetworkProfile } = require("./shared/network-profile");

const workspaceRoot = process.cwd();
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const logdir = path.join(workspaceRoot, "scripts/tests/logs", `full-live-rerun-${timestamp}`);
const summary = path.join(logdir, "summary.log");
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
const network = process.env.LIVE_TEST_NETWORK;
if (!network || !network.trim()) {
  throw new Error("LIVE_TEST_NETWORK is required for full live reruns");
}
process.env.LIVE_TEST_NETWORK = network;
const profile = loadNetworkProfile(network);
const {
  seedCase,
  liquidationSeedCase,
  liveTestCases,
  seededLiquidationCaseLabels,
} = require("./live-test-cases");

const tests = [seedCase, ...liveTestCases];

fs.mkdirSync(logdir, { recursive: true });

const freshBorrowerStateFile = path.join(logdir, "fresh-borrowers.json");
const freshBorrowerMnemonic = Wallet.createRandom().mnemonic.phrase;

const sharedEnv = {
  ...process.env,
  ...profile,
  LIVE_FRESH_BORROWER_MNEMONIC: freshBorrowerMnemonic,
  LIVE_FRESH_BORROWER_STATE_FILE: freshBorrowerStateFile,
  FULL_LIVE_LOGDIR: logdir,
};

fs.writeFileSync(
  summary,
  [
    `LOGDIR=${logdir}`,
    "FRESH_BORROWER_MODE=generated-per-run",
    `LIVE_FRESH_BORROWER_STATE_FILE=${freshBorrowerStateFile}`,
    "LIVE_FRESH_BORROWER_MNEMONIC=generated",
    "",
  ].join("\n"),
);

let failCount = 0;

function appendSummary(line) {
  fs.appendFileSync(summary, `${line}\n`);
}

function isRetryableNetworkFailureText(text) {
  if (!text) {
    return false;
  }
  const normalized = String(text);
  return networkRetryPatterns.some((pattern) => normalized.includes(pattern));
}

function parseSeededLiquidationEnv(logfile) {
  const content = fs.existsSync(logfile) ? fs.readFileSync(logfile, "utf8") : "";
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

function runLoggedCommand(label, command, extraEnv = {}) {
  appendSummary(`=== START ${label} ===`);
  const logfile = path.join(logdir, `${label}.log`);
  let result;
  let combinedOutput = "";
  let attempt = 0;
  while (attempt < maxNetworkAttempts) {
    attempt += 1;
    result = spawnSync(command, {
      shell: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 32,
      cwd: workspaceRoot,
      env: {
        ...sharedEnv,
        ...extraEnv,
      },
    });
    combinedOutput = `${result.stdout || ""}${result.stderr || ""}`;
    fs.writeFileSync(logfile, combinedOutput);
    if (result.status === 0 || !isRetryableNetworkFailureText(combinedOutput) || attempt >= maxNetworkAttempts) {
      break;
    }
    appendSummary(`RETRY(network ${attempt}/${maxNetworkAttempts}) ${label}`);
  }

  const passed = result.status === 0;
  if (!passed) {
    failCount += 1;
  }
  appendSummary(`${passed ? "PASS" : `FAIL(${result.status ?? 1})`} ${label}`);
  appendSummary(`LOGFILE=${logfile}`);
  return { result, logfile };
}

function runSeededLiquidationCase(targetLabel) {
  const seedLabel = `${liquidationSeedCase[0]}-for-${targetLabel}`;
  const { result, logfile } = runLoggedCommand(seedLabel, liquidationSeedCase[1]);
  if (result.status !== 0) {
    appendSummary(`FAIL(seed) ${targetLabel}`);
    return null;
  }
  const env = parseSeededLiquidationEnv(logfile);
  if (!env) {
    failCount += 1;
    appendSummary(`FAIL(seed-parse) ${targetLabel}`);
    return null;
  }
  appendSummary(`SEEDED_LIQUIDATION_ORDER_ID=${env.LIQUIDATION_ORDER_ID}`);
  appendSummary(`SEEDED_LIQUIDATION_TARGET=${targetLabel}`);
  return env;
}

function runSweepOnce() {
  appendSummary("=== START sweep-fresh-borrowers ===");
  const sweepCommand = `pnpm -s exec hardhat run ${profile.LIVE_SWEEP_SCRIPT} --network ${profile.LIVE_SWEEP_NETWORK}`;
  const sweepResult = spawnSync(sweepCommand, {
    shell: true,
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    env: sharedEnv,
  });
  fs.writeFileSync(
    path.join(logdir, "sweep-fresh-borrowers.log"),
    `${sweepResult.stdout || ""}${sweepResult.stderr || ""}`,
  );
  const sweepPassed = sweepResult.status === 0;
  if (!sweepPassed) {
    failCount += 1;
  }
  appendSummary(`${sweepPassed ? "PASS" : `FAIL(${sweepResult.status ?? 1})`} sweep-fresh-borrowers`);
}

try {
  for (const [label, command] of tests) {
    let extraEnv = {};
    if (seededLiquidationCaseLabels.includes(label)) {
      const seededEnv = runSeededLiquidationCase(label);
      if (!seededEnv) {
        continue;
      }
      extraEnv = seededEnv;
    }
    runLoggedCommand(label, command, extraEnv);
  }
} finally {
  runSweepOnce();
}

appendSummary(`LOGDIR=${logdir}`);
appendSummary(`LIVE_FRESH_BORROWER_STATE_FILE=${freshBorrowerStateFile}`);
appendSummary(`TOTAL_FAILS=${failCount}`);
console.log(`LOGDIR=${logdir}`);
console.log("LIVE_FRESH_BORROWER_MODE=generated-per-run");
console.log(`LIVE_FRESH_BORROWER_STATE_FILE=${freshBorrowerStateFile}`);
console.log(`TOTAL_FAILS=${failCount}`);