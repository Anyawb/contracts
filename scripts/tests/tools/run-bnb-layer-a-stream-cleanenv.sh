#!/usr/bin/env zsh
set -euo pipefail

cd "$(dirname "$0")/../../.."

# Clear inherited RPC/env selectors that may shadow runbook defaults.
unset BNB_TESTNET_RPC_URL
unset BNB_TESTNET_URL
unset BSC_TESTNET_RPC_URL
unset BSC_TESTNET_URL
unset BNB_TESTNET_RPC_POOL
unset BSC_TESTNET_RPC_POOL
unset LIVE_RPC_POOL

set -a
[[ -f .env ]] && source ./.env
set +a

: "${LIVE_RPC_POOL:=https://bsc-testnet.bnbchain.org,https://bsc-testnet-dataseed.bnbchain.org,https://bsc-prebsc-dataseed.bnbchain.org}"
export LIVE_NETWORK_ATTEMPT_TIMEOUT_MS="${LIVE_NETWORK_ATTEMPT_TIMEOUT_MS:-0}"
export LIVE_NETWORK_RETRY_ON_TIMEOUT="${LIVE_NETWORK_RETRY_ON_TIMEOUT:-0}"

# Pin single-url vars to the first pool endpoint to keep Hardhat network resolution deterministic.
first_rpc="${LIVE_RPC_POOL%%,*}"
export BNB_TESTNET_RPC_URL="$first_rpc"
export BSC_TESTNET_RPC_URL="$first_rpc"

reward_manager_artifact="artifacts/src/Reward/RewardManager.sol/RewardManager.json"
if [[ ! -f "$reward_manager_artifact" ]]; then
	echo "[Preflight] missing $reward_manager_artifact, running compile"
	pnpm -s run compile
fi

exec pnpm -s run test:live:release-gates:bnb-testnet:layer-a:stream
