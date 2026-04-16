#!/usr/bin/env zsh

setopt errexit pipefail

NETWORK_NAME="${LIVE_TEST_NETWORK:-}"
if [[ -z "$NETWORK_NAME" ]]; then
  echo "run-round2-acceptance: LIVE_TEST_NETWORK is required" >&2
  exit 64
fi

RUN_TS="$(date +%Y%m%d%H%M%S)"
RUN_DIR="scripts/tests/logs/manual-round2-acceptance-${RUN_TS}"
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
export LIVE_AUTO_GRANT_RUNTIME_ROLES="${LIVE_AUTO_GRANT_RUNTIME_ROLES:-0}"
export LIVE_FAIL_ON_MISSING_RUNTIME_ROLES="${LIVE_FAIL_ON_MISSING_RUNTIME_ROLES:-1}"
export LIVE_STRICT_FEE_ROUTER_GATE="${LIVE_STRICT_FEE_ROUTER_GATE:-1}"
export MOCK_ASSET_PACK_OUTPUT="${MOCK_ASSET_PACK_OUTPUT:-}"
export ASSETS_FILE="${ASSETS_FILE}"
export REGISTRY_ADDRESS="${REGISTRY_ADDRESS:-}"
export SETTLEMENT_TOKEN_ADDRESS="${SETTLEMENT_TOKEN_ADDRESS:-}"
export SETTLEMENT_TOKEN_DECIMALS="${SETTLEMENT_TOKEN_DECIMALS:-}"
export ALLOW_LIQUIDATION_MANAGER_PAUSE="${ALLOW_LIQUIDATION_MANAGER_PAUSE}"
export ALLOW_DYNAMIC_FEE_WRITE="${ALLOW_DYNAMIC_FEE_WRITE:-0}"
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS}"

run_network_case() {
  local label="$1"
  local case_name="$2"
  run_step "$label" pnpm -s exec hardhat run "scripts/tests/live-test/networks/${LIVE_PROFILE_SLUG}/${case_name}.ts" --network "$LIVE_PROFILE_NETWORK"
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
  run_network_case "02-platform-baseline" "live-platform-baseline"
  echo "RUN_DIR=$RUN_DIR"
  exit 0
fi

extract_seed_value() {
  local key_name="$1"
  local logfile="$2"
  sed -n "s/^${key_name}=//p" "$logfile" | tail -n 1
}

run_network_case "00a-seed-dryrun-liquidation" "seed-liquidatable-order"
export LIQUIDATION_ORDER_ID="$(extract_seed_value SEEDED_LIQUIDATION_ORDER_ID "$RUN_DIR/00a-seed-dryrun-liquidation.log")"
export LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER="$(extract_seed_value SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER "$RUN_DIR/00a-seed-dryrun-liquidation.log")"
if [[ -z "$LIQUIDATION_ORDER_ID" ]]; then
  echo "failed to parse dryrun LIQUIDATION_ORDER_ID from $RUN_DIR/00a-seed-dryrun-liquidation.log" >&2
  exit 1
fi
run_network_case "00-dryrun" "live-release-dryrun"
run_network_case "01-settlement-role-bridge" "live-settlement-role-bridge"
run_network_case "02-view-consistency" "live-view-consistency-gate"
run_network_case "03-guarantee-flow" "live-guarantee-flow"
run_network_case "04-guarantee-events" "live-guarantee-events-datapush"
run_network_case "05-batch-liquidation-pressure" "live-batch-liquidation-pressure"

run_network_case "06a-seed-liquidation" "seed-liquidatable-order"
export LIQUIDATION_ORDER_ID="$(extract_seed_value SEEDED_LIQUIDATION_ORDER_ID "$RUN_DIR/06a-seed-liquidation.log")"
export LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER="$(extract_seed_value SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER "$RUN_DIR/06a-seed-liquidation.log")"
if [[ -z "$LIQUIDATION_ORDER_ID" ]]; then
  echo "failed to parse LIQUIDATION_ORDER_ID from $RUN_DIR/06a-seed-liquidation.log" >&2
  exit 1
fi
run_network_case "06-liquidation" "live-liquidation"

run_network_case "07a-seed-liquidation-fallback" "seed-liquidatable-order"
export LIQUIDATION_FALLBACK_ORDER_ID="$(extract_seed_value SEEDED_LIQUIDATION_ORDER_ID "$RUN_DIR/07a-seed-liquidation-fallback.log")"
if [[ -z "$LIQUIDATION_FALLBACK_ORDER_ID" ]]; then
  echo "failed to parse LIQUIDATION_FALLBACK_ORDER_ID from $RUN_DIR/07a-seed-liquidation-fallback.log" >&2
  exit 1
fi
export LIQUIDATION_ORDER_ID="$LIQUIDATION_FALLBACK_ORDER_ID"
run_network_case "07-liquidation-fallback" "live-liquidation-fallback"

unset LIQUIDATION_ORDER_ID
unset LIQUIDATION_FALLBACK_ORDER_ID
unset LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER

run_network_case "08-withdraw" "live-withdraw-collateral"
run_network_case "09-cancel-reserve" "live-cancel-reserve"
run_network_case "10-fee-accounting" "live-fee-accounting"
run_network_case "11-release-gates" "live-release-gates"

echo "RUN_DIR=$RUN_DIR"