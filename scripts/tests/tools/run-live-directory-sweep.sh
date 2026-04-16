#!/usr/bin/env zsh

setopt errexit pipefail

NETWORK_NAME="${LIVE_TEST_NETWORK:-}"
if [[ -z "$NETWORK_NAME" ]]; then
  echo "run-live-directory-sweep: LIVE_TEST_NETWORK is required" >&2
  exit 64
fi

RUN_TS="$(date +%Y%m%d%H%M%S)"
RUN_DIR="scripts/tests/logs/manual-live-directory-sweep-${RUN_TS}"
mkdir -p "$RUN_DIR"

pnpm -s ts-node --project ./tsconfig.scripts.json scripts/tests/tools/shared/network-profile.ts env --network "$NETWORK_NAME" > "$RUN_DIR/network-profile.env"

cleanup() {
  set +e
  if [[ -f "$RUN_DIR/fresh.env" ]]; then
    set -a
    source .env
    source "$RUN_DIR/network-profile.env"
    source "$RUN_DIR/fresh.env"
    set +a
    export LIVE_FRESH_BORROWER_STATE_FILE="$PWD/$RUN_DIR/fresh-borrowers.json"
    pnpm -s exec hardhat run "$LIVE_SWEEP_SCRIPT" --network "$LIVE_SWEEP_NETWORK" \
      | tee "$RUN_DIR/99-sweep.log"
  fi
}

trap cleanup EXIT

export RUN_DIR
node - <<'NODE' > "$RUN_DIR/fresh.env"
const { Wallet } = require('ethers');
const path = require('path');

const phrase = Wallet.createRandom().mnemonic.phrase;
const stateFile = path.join(process.cwd(), process.env.RUN_DIR, 'fresh-borrowers.json');

console.log(`export LIVE_FRESH_BORROWER_MNEMONIC=${JSON.stringify(phrase)}`);
console.log(`export LIVE_FRESH_BORROWER_STATE_FILE=${JSON.stringify(stateFile)}`);
NODE

set -a
source .env
source "$RUN_DIR/network-profile.env"
source "$RUN_DIR/fresh.env"
set +a

export DEPLOY_OUTPUT_FILE="${DEPLOY_OUTPUT_FILE}"
export LIVE_USE_MOCK_ASSET_PACK="${LIVE_USE_MOCK_ASSET_PACK}"
export LIVE_PRICE_MODE="${LIVE_PRICE_MODE}"
export MOCK_ASSET_PACK_OUTPUT="${MOCK_ASSET_PACK_OUTPUT:-}"
export ASSETS_FILE="${ASSETS_FILE}"
export REGISTRY_ADDRESS="${REGISTRY_ADDRESS:-}"
export SETTLEMENT_TOKEN_ADDRESS="${SETTLEMENT_TOKEN_ADDRESS:-}"
export SETTLEMENT_TOKEN_DECIMALS="${SETTLEMENT_TOKEN_DECIMALS:-}"
export ALLOW_LIQUIDATION_MANAGER_PAUSE="${ALLOW_LIQUIDATION_MANAGER_PAUSE}"
export ALLOW_DYNAMIC_FEE_WRITE="${ALLOW_DYNAMIC_FEE_WRITE}"
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS}"

run_network_case() {
  local label="$1"
  local case_name="$2"
  run_step "$label" pnpm -s exec hardhat run "scripts/tests/live-test/networks/${LIVE_PROFILE_SLUG}/${case_name}.ts" --network "$LIVE_PROFILE_NETWORK"
}

run_shared_case() {
  local label="$1"
  local file="$2"
  run_step "$label" pnpm -s exec hardhat run "$file" --network "$LIVE_PROFILE_NETWORK"
}

is_retryable_network_failure() {
  local logfile="$1"
  [[ -f "$logfile" ]] || return 1
  grep -Eq 'ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|socket hang up|other side closed|Headers Timeout Error' "$logfile"
}

run_step() {
  local label="$1"
  shift
  local logfile="$RUN_DIR/${label}.log"
  local attempt=1
  local max_attempts="$LIVE_RUNNER_NETWORK_MAX_ATTEMPTS"

  while true; do
    : > "$logfile"
    if "$@" 2>&1 | tee "$logfile"; then
      return 0
    fi
    if (( attempt >= max_attempts )) || ! is_retryable_network_failure "$logfile"; then
      return 1
    fi
    echo "RETRY(network ${attempt}/${max_attempts}) ${label}" | tee -a "$logfile"
    attempt=$((attempt + 1))
  done
}

if [[ "$LIVE_PROFILE_NETWORK" == "bnbTestnet" ]]; then
  run_network_case "00-preflight" "live-preflight"
  run_network_case "01-settlement-role-bridge" "live-settlement-role-bridge"
  run_network_case "02-warmup" "live-warmup"
  run_network_case "03-platform-baseline" "live-platform-baseline"
  run_network_case "04-guarantee-baseline" "live-guarantee-baseline"
  run_network_case "05-release-gates-layer-a" "live-release-gates"
  run_network_case "06-release-gates-layer-b" "live-release-gates-layer-b"
  run_network_case "07-blocks-only-state-machine" "live-blocks-only-liquidation"
  echo "RUN_DIR=$RUN_DIR"
  exit 0
fi

run_network_case "00-view-facade-gate" "live-view-facade-gate"
run_network_case "01-fee-prepaid-gate" "live-fee-prepaid-gate"
run_network_case "02-fee-remaining-gate" "live-fee-remaining-gate"
run_network_case "03-fee-dynamic-gate" "live-fee-dynamic-gate"
run_network_case "04-ignite-minimal" "live-ignite-minimal"
run_network_case "05-prime-viewcache" "live-prime-viewcache"
run_shared_case "06-read-pressure" "scripts/tests/live-test/networks/arbitrum-sepolia/live-read-pressure.ts"
run_network_case "07-settlement-role-bridge" "live-settlement-role-bridge"
run_network_case "08-warmup" "live-warmup"
run_network_case "09-smoke-multi-stablecoin" "live-smoke-multi-stablecoin"

echo "RUN_DIR=$RUN_DIR"