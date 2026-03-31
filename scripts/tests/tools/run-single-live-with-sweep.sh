#!/usr/bin/env zsh

setopt errexit pipefail

if [[ "$#" -lt 3 || "$2" != "--" ]]; then
  echo "usage: $0 <label> -- <command...>" >&2
  exit 64
fi

LABEL="$1"
shift 2

RUN_TS="$(date +%Y%m%d%H%M%S)"
RUN_DIR="scripts/tests/logs/manual-${LABEL}-${RUN_TS}"
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
      | tee "$RUN_DIR/sweep.log"
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

CLI_LIQUIDATION_ORDER_ID="${LIQUIDATION_ORDER_ID-}"
CLI_LIQUIDATION_FALLBACK_ORDER_ID="${LIQUIDATION_FALLBACK_ORDER_ID-}"
CLI_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER="${LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER-}"

set -a
source .env
source "$RUN_DIR/fresh.env"
set +a

if [[ -n "$CLI_LIQUIDATION_ORDER_ID" ]]; then
  export LIQUIDATION_ORDER_ID="$CLI_LIQUIDATION_ORDER_ID"
fi
if [[ -n "$CLI_LIQUIDATION_FALLBACK_ORDER_ID" ]]; then
  export LIQUIDATION_FALLBACK_ORDER_ID="$CLI_LIQUIDATION_FALLBACK_ORDER_ID"
fi
if [[ -n "$CLI_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER" ]]; then
  export LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER="$CLI_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER"
fi

export DEPLOY_OUTPUT_FILE="${DEPLOY_OUTPUT_FILE:-scripts/deployments/arbitrum-sepolia.mock-suite.json}"
export LIVE_USE_MOCK_ASSET_PACK="${LIVE_USE_MOCK_ASSET_PACK:-1}"
export LIVE_PRICE_MODE="${LIVE_PRICE_MODE:-bootstrap}"
export MOCK_ASSET_PACK_OUTPUT="${MOCK_ASSET_PACK_OUTPUT:-deployments/mock-assets.arbitrum-sepolia.json}"
export ASSETS_FILE="${ASSETS_FILE:-deployments/assets.arbitrum-sepolia.mock.json}"
export REGISTRY_ADDRESS="${REGISTRY_ADDRESS:-$(node -e 'process.stdout.write(require("./scripts/deployments/arbitrum-sepolia.mock-suite.json").Registry)')}"
export SETTLEMENT_TOKEN_ADDRESS="${SETTLEMENT_TOKEN_ADDRESS:-$(node -e 'process.stdout.write(require("./deployments/mock-assets.arbitrum-sepolia.json").settlementToken)')}"
export SETTLEMENT_TOKEN_DECIMALS="${SETTLEMENT_TOKEN_DECIMALS:-$(node -e 'const m=require("./deployments/mock-assets.arbitrum-sepolia.json"); process.stdout.write(String(m.settlementTokenDecimals ?? m.settlementTokenMeta?.decimals ?? 6))')}"
export ALLOW_LIQUIDATION_MANAGER_PAUSE="${ALLOW_LIQUIDATION_MANAGER_PAUSE:-1}"
export ALLOW_DYNAMIC_FEE_WRITE="${ALLOW_DYNAMIC_FEE_WRITE:-1}"
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS:-2}"

LOGFILE="$RUN_DIR/${LABEL}.log"

is_retryable_network_failure() {
  local logfile="$1"
  [[ -f "$logfile" ]] || return 1
  grep -Eq 'ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|socket hang up|other side closed|Headers Timeout Error' "$logfile"
}

attempt=1
while true; do
  : > "$LOGFILE"
  if "$@" 2>&1 | tee "$LOGFILE"; then
    break
  fi
  if (( attempt >= LIVE_RUNNER_NETWORK_MAX_ATTEMPTS )) || ! is_retryable_network_failure "$LOGFILE"; then
    exit 1
  fi
  echo "RETRY(network ${attempt}/${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS}) ${LABEL}" | tee -a "$LOGFILE"
  attempt=$((attempt + 1))
done

echo "RUN_DIR=$RUN_DIR"
echo "LOGFILE=$LOGFILE"
}

if main "$@"; then
  RUN_STATUS=0
else
  RUN_STATUS=$?
fi
cleanup
exit "$RUN_STATUS"