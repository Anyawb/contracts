const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Wallet } = require("ethers");
const { loadNetworkProfile } = require("./shared/network-profile");

function getArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const label = getArg("--label");
const command = getArg("--command");
const network = getArg("--network") || process.env.LIVE_TEST_NETWORK;

if (!network || !network.trim()) {
  console.error("run-live-script-with-sweep: missing --network <network> or LIVE_TEST_NETWORK");
  process.exit(2);
}

const profile = loadNetworkProfile(network);

if (!label || !command) {
  console.error("Usage: node scripts/tests/tools/run-live-script-with-sweep.js --label <label> --command <command> [--network <network>]");
  process.exit(2);
}

const workspaceRoot = process.cwd();
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const runId = `${label}-${timestamp}`;
const logDir = path.join(workspaceRoot, "scripts/tests/logs", runId);
const stateFile = path.join(logDir, "fresh-borrowers.json");
const logFile = path.join(logDir, `${label}.log`);
const sweepCommand = `pnpm -s exec hardhat run ${profile.LIVE_SWEEP_SCRIPT} --network ${profile.LIVE_SWEEP_NETWORK}`;
const mnemonic = Wallet.createRandom().mnemonic.phrase;

fs.mkdirSync(logDir, { recursive: true });

const sharedEnv = {
  ...process.env,
  ...profile,
  LIVE_FRESH_BORROWER_MNEMONIC: mnemonic,
  LIVE_FRESH_BORROWER_STATE_FILE: stateFile,
  FULL_LIVE_LOGDIR: logDir,
};

function appendOutput(result) {
  fs.appendFileSync(logFile, `${result.stdout || ""}${result.stderr || ""}`);
}

fs.writeFileSync(
  logFile,
  [
    `[Wrapper] label=${label}`,
    `[Wrapper] runId=${runId}`,
    `[Wrapper] stateFile=${stateFile}`,
    `[Wrapper] command=${command}`,
    "",
  ].join("\n"),
);

const scriptResult = spawnSync(command, {
  shell: true,
  cwd: workspaceRoot,
  env: sharedEnv,
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 32,
});
appendOutput(scriptResult);

const sweepResult = spawnSync(sweepCommand, {
  shell: true,
  cwd: workspaceRoot,
  env: sharedEnv,
  encoding: "utf8",
  maxBuffer: 1024 * 1024 * 16,
});
appendOutput(sweepResult);

console.log(`RUN_ID=${runId}`);
console.log(`LOGFILE=${logFile}`);
console.log(`STATE_FILE=${stateFile}`);
console.log(`SCRIPT_STATUS=${scriptResult.status ?? 1}`);
console.log(`SWEEP_STATUS=${sweepResult.status ?? 1}`);

process.exit(scriptResult.status ?? 1);