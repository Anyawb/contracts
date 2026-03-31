#!/usr/bin/env zsh

setopt errexit pipefail

RUN_TS="$(date +%Y%m%d%H%M%S)"
RUN_DIR="scripts/tests/logs/manual-cross-live-matrix-${RUN_TS}"
mkdir -p "$RUN_DIR"

cleanup() {
  if [[ "${CLEANUP_DONE:-0}" == "1" ]]; then
    return
  fi
  CLEANUP_DONE=1
  setopt localoptions noerrexit nopipefail
  if [[ -f "$RUN_DIR/fresh.env" ]]; then
    set -a
    source .env
    source "$RUN_DIR/fresh.env"
    set +a
    export LIVE_FRESH_BORROWER_STATE_FILE="$PWD/$RUN_DIR/fresh-borrowers.json"
    pnpm -s exec hardhat run scripts/tests/live-test/sweep-fresh-borrowers.ts --network arbitrumSepolia \
      | tee "$RUN_DIR/99-sweep.log"
  fi
}

trap cleanup EXIT

main() {

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
source "$RUN_DIR/fresh.env"
set +a

export DEPLOY_OUTPUT_FILE="${DEPLOY_OUTPUT_FILE:-scripts/deployments/arbitrum-sepolia.mock-suite.json}"
export LIVE_USE_MOCK_ASSET_PACK="${LIVE_USE_MOCK_ASSET_PACK:-1}"
export LIVE_PRICE_MODE="${LIVE_PRICE_MODE:-bootstrap}"
export LIVE_AUTO_GRANT_RUNTIME_ROLES="${LIVE_AUTO_GRANT_RUNTIME_ROLES:-0}"
export LIVE_FAIL_ON_MISSING_RUNTIME_ROLES="${LIVE_FAIL_ON_MISSING_RUNTIME_ROLES:-1}"
export LIVE_STRICT_FEE_ROUTER_GATE="${LIVE_STRICT_FEE_ROUTER_GATE:-1}"
export MOCK_ASSET_PACK_OUTPUT="${MOCK_ASSET_PACK_OUTPUT:-deployments/mock-assets.arbitrum-sepolia.json}"
export ASSETS_FILE="${ASSETS_FILE:-deployments/assets.arbitrum-sepolia.mock.json}"
export REGISTRY_ADDRESS="${REGISTRY_ADDRESS:-$(node -e 'process.stdout.write(require("./scripts/deployments/arbitrum-sepolia.mock-suite.json").Registry)')}"
export SETTLEMENT_TOKEN_ADDRESS="${SETTLEMENT_TOKEN_ADDRESS:-$(node -e 'process.stdout.write(require("./deployments/mock-assets.arbitrum-sepolia.json").settlementToken)')}"
export SETTLEMENT_TOKEN_DECIMALS="${SETTLEMENT_TOKEN_DECIMALS:-$(node -e 'const m=require("./deployments/mock-assets.arbitrum-sepolia.json"); process.stdout.write(String(m.settlementTokenDecimals ?? m.settlementTokenMeta?.decimals ?? 6))')}"
export ALLOW_LIQUIDATION_MANAGER_PAUSE="${ALLOW_LIQUIDATION_MANAGER_PAUSE:-1}"
export ALLOW_DYNAMIC_FEE_WRITE="${ALLOW_DYNAMIC_FEE_WRITE:-0}"
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS:-2}"

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

extract_seed_value() {
  local key_name="$1"
  local logfile="$2"
  sed -n "s/^${key_name}=//p" "$logfile" | tail -n 1
}

run_step "00-view-consistency" pnpm -s exec hardhat run scripts/tests/live-test/live-view-consistency-gate-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "01-platform-baseline" pnpm -s exec hardhat run scripts/tests/live-test/live-platform-baseline-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "02-reward-boundary" pnpm -s exec hardhat run scripts/tests/live-test/live-view-reward-loanflow-boundary-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "03-reward-governance" pnpm -s exec hardhat run scripts/tests/live-test/live-reward-config-governance-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "04-reward-lender-view" pnpm -s exec hardhat run scripts/tests/live-test/live-reward-lender-view-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "05-reward-penalty-recycle-recovery" pnpm -s exec hardhat run scripts/tests/live-test/live-reward-penalty-recycle-recovery-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "06-reward-multi-borrower-stress" pnpm -s exec hardhat run scripts/tests/live-test/live-reward-multi-borrower-stress-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "07-ops-extension" pnpm -s exec hardhat run scripts/tests/live-test/live-ops-extension-modules-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "08-easy-staking" pnpm -s exec hardhat run scripts/tests/live-test/live-easy-staking-arbitrum-sepolia.ts --network arbitrumSepolia
run_step "09-batch-liquidation-pressure" pnpm -s exec hardhat run scripts/tests/live-test/live-batch-liquidation-pressure-arbitrum-sepolia.ts --network arbitrumSepolia

run_step "10a-seed-liquidation" pnpm -s exec hardhat run scripts/tests/live-test/seed-liquidatable-order-arbitrum-sepolia.ts --network arbitrumSepolia
export LIQUIDATION_ORDER_ID="$(extract_seed_value SEEDED_LIQUIDATION_ORDER_ID "$RUN_DIR/10a-seed-liquidation.log")"
export LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER="$(extract_seed_value SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER "$RUN_DIR/10a-seed-liquidation.log")"
if [[ -z "$LIQUIDATION_ORDER_ID" ]]; then
  echo "failed to parse LIQUIDATION_ORDER_ID from $RUN_DIR/10a-seed-liquidation.log" >&2
  exit 1
fi
run_step "10-single-liquidation" pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-arbitrum-sepolia.ts --network arbitrumSepolia

unset LIQUIDATION_ORDER_ID
unset LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER

echo "RUN_DIR=$RUN_DIR"
}

if main "$@"; then
  RUN_STATUS=0
else
  RUN_STATUS=$?
fi
cleanup
exit "$RUN_STATUS"
