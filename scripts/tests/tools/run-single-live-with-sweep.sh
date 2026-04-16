#!/usr/bin/env zsh

setopt errexit pipefail

if [[ "$#" -lt 3 || "$2" != "--" ]]; then
  echo "usage: $0 <label> -- <command...>" >&2
  exit 64
fi

extract_network_name() {
  local args=("$@")
  local index=1
  while (( index <= $#args )); do
    if [[ "${args[index]}" == "--network" && $((index + 1)) -le $#args ]]; then
      print -- "${args[index + 1]}"
      return 0
    fi
    if [[ "${args[index]}" == --network=* ]]; then
      print -- "${args[index]#--network=}"
      return 0
    fi
    index=$((index + 1))
  done
  return 1
}

LABEL="$1"
shift 2

COMMAND_ARGS=("$@")
NETWORK_NAME="${LIVE_TEST_NETWORK:-$(extract_network_name "${COMMAND_ARGS[@]}") }"
NETWORK_NAME="${NETWORK_NAME%% }"

if [[ -z "$NETWORK_NAME" ]]; then
  echo "run-single-live-with-sweep: missing --network <network> in command or LIVE_TEST_NETWORK" >&2
  exit 64
fi

RUN_TS="$(date +%Y%m%d%H%M%S)"
RUN_DIR="scripts/tests/logs/manual-${LABEL}-${RUN_TS}"
mkdir -p "$RUN_DIR"

pnpm -s ts-node --project ./tsconfig.scripts.json scripts/tests/tools/shared/network-profile.ts env --network "$NETWORK_NAME" > "$RUN_DIR/network-profile.env"

cleanup() {
  if [[ "${CLEANUP_DONE:-0}" == "1" ]]; then
    return
  fi
  CLEANUP_DONE=1
  setopt localoptions noerrexit nopipefail
  if [[ -f "$RUN_DIR/fresh.env" ]]; then
    set -a
    source .env
    source "$RUN_DIR/network-profile.env"
    source "$RUN_DIR/fresh.env"
    set +a

    if [[ "$LIVE_PROFILE_NETWORK" == "bnbTestnet" ]]; then
      local cleanup_pool_raw cleanup_selected
      cleanup_pool_raw="${LIVE_RPC_POOL:-${BNB_TESTNET_RPC_POOL:-${BSC_TESTNET_RPC_POOL:-}}}"
      cleanup_selected=""
      if [[ -n "$cleanup_pool_raw" ]]; then
        local -a cleanup_parsed
        cleanup_parsed=(${(s:,:)cleanup_pool_raw})
        for cleanup_candidate in "${cleanup_parsed[@]}"; do
          cleanup_candidate="${cleanup_candidate//[[:space:]]/}"
          if [[ "$cleanup_candidate" == http://* || "$cleanup_candidate" == https://* ]]; then
            cleanup_selected="$cleanup_candidate"
            break
          fi
        done
      fi
      if [[ -n "$cleanup_selected" ]]; then
        export BNB_TESTNET_RPC_URL="$cleanup_selected"
        export BSC_TESTNET_RPC_URL="$cleanup_selected"
        echo "[RPCPool][cleanup] selected=$cleanup_selected" | tee -a "$RUN_DIR/sweep.log"
      fi
    fi

    export LIVE_FRESH_BORROWER_STATE_FILE="$PWD/$RUN_DIR/fresh-borrowers.json"
    pnpm -s exec hardhat run "$LIVE_SWEEP_SCRIPT" --network "$LIVE_SWEEP_NETWORK" \
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
CLI_LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS-}"

set -a
source .env
source "$RUN_DIR/network-profile.env"
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
export LIVE_NETWORK_RETRY_ON_TIMEOUT="${LIVE_NETWORK_RETRY_ON_TIMEOUT:-0}"
if [[ -n "$CLI_LIVE_RUNNER_NETWORK_MAX_ATTEMPTS" ]]; then
  export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="$CLI_LIVE_RUNNER_NETWORK_MAX_ATTEMPTS"
else
  export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS="${LIVE_RUNNER_NETWORK_MAX_ATTEMPTS:-2}"
fi

LOGFILE="$RUN_DIR/${LABEL}.log"

is_retryable_network_failure() {
  local logfile="$1"
  [[ -f "$logfile" ]] || return 1
  local retry_on_timeout
  retry_on_timeout="${LIVE_RUNNER_RETRY_ON_TIMEOUT:-${LIVE_NETWORK_RETRY_ON_TIMEOUT:-0}}"
  if [[ "$retry_on_timeout" == "1" || "$retry_on_timeout" == "true" || "$retry_on_timeout" == "yes" || "$retry_on_timeout" == "on" ]]; then
    grep -Eq 'ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|socket hang up|other side closed|Headers Timeout Error|Connect Timeout Error|Unable to complete request at this time\.|ProviderError: Unable to complete request at this time\.|code: -32001| timed out after ' "$logfile"
    return $?
  fi
  grep -Eq 'ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|socket hang up|other side closed|Headers Timeout Error|Connect Timeout Error|Unable to complete request at this time\.|ProviderError: Unable to complete request at this time\.|code: -32001' "$logfile"
}

build_rpc_pool() {
  local -a pool=()
  local raw_pool="${LIVE_RPC_POOL:-${BNB_TESTNET_RPC_POOL:-${BSC_TESTNET_RPC_POOL:-}}}"

  if [[ -n "$raw_pool" ]]; then
    local -a parsed
    parsed=(${(s:,:)raw_pool})
    for candidate in "${parsed[@]}"; do
      local normalized
      normalized="${candidate//[[:space:]]/}"
      if [[ -n "$normalized" ]]; then
        pool+=("$normalized")
      fi
    done
  else
    local primary
    local secondary
    primary="${BNB_TESTNET_RPC_URL:-}"
    secondary="${BSC_TESTNET_RPC_URL:-}"
    primary="${primary//[[:space:]]/}"
    secondary="${secondary//[[:space:]]/}"
    if [[ -n "$primary" ]]; then
      pool+=("$primary")
    fi
    if [[ -n "$secondary" && "$secondary" != "$primary" ]]; then
      pool+=("$secondary")
    fi
  fi

  print -rl -- "${pool[@]}"
}

attempt=1
local -a rpc_pool=()
export LIVE_RELEASE_RESUME_ON_RETRY="${LIVE_RELEASE_RESUME_ON_RETRY:-1}"
if [[ "$LIVE_PROFILE_NETWORK" == "bnbTestnet" ]]; then
  while IFS= read -r endpoint; do
    if [[ "$endpoint" == http://* || "$endpoint" == https://* ]]; then
      rpc_pool+=("$endpoint")
    fi
  done < <(build_rpc_pool)
fi

while true; do
  : > "$LOGFILE"
  if [[ "$LIVE_PROFILE_NETWORK" == "bnbTestnet" && ${#rpc_pool[@]} -gt 0 ]]; then
    local pool_index selected_rpc
    pool_index=$(( ((attempt - 1) % ${#rpc_pool[@]}) + 1 ))
    selected_rpc="${rpc_pool[$pool_index]}"
    export BNB_TESTNET_RPC_URL="$selected_rpc"
    export BSC_TESTNET_RPC_URL="$selected_rpc"
    echo "[RPCPool] attempt=${attempt} selected=${selected_rpc}" | tee -a "$LOGFILE"
  fi
  if "$@" 2>&1 | tee -a "$LOGFILE"; then
    break
  fi
  if [[ "${LIVE_RELEASE_RESUME_ON_RETRY:-0}" == "1" || "${LIVE_RELEASE_RESUME_ON_RETRY:-0}" == "true" || "${LIVE_RELEASE_RESUME_ON_RETRY:-0}" == "yes" || "${LIVE_RELEASE_RESUME_ON_RETRY:-0}" == "on" ]]; then
    if [[ -z "${LIVE_RELEASE_LOG_DIR:-}" ]]; then
      resume_log_dir=$(grep -m1 '^logDir=' "$LOGFILE" | sed 's/^logDir=//' || true)
      if [[ -n "$resume_log_dir" ]]; then
        export LIVE_RELEASE_LOG_DIR="$resume_log_dir"
        echo "[Resume] LIVE_RELEASE_LOG_DIR=$LIVE_RELEASE_LOG_DIR" | tee -a "$LOGFILE"
      fi
    fi
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

setopt noerrexit
(
  setopt errexit pipefail
  main "$@"
)
RUN_STATUS=$?
setopt errexit pipefail
cleanup
exit "$RUN_STATUS"