#!/usr/bin/env bash
set -euo pipefail

# Real-chain CI template (arbitrum / arbitrum-sepolia)
#
# Required env:
# - PRIVATE_KEY                : signer private key (for txs, even read-only scripts still need a signer)
# - ARBITRUM_RPC_URL            (if network=arbitrum)
# - ARBITRUM_SEPOLIA_RPC_URL    (if network=arbitrumSepolia)
#
# Optional env (override deployments lookup):
# - REGISTRY_ADDRESS            : Registry address for the target network
# - VAULT_ROUTER_ADDRESS        : VaultRouter address (required by cache-refresh)
#
# Script toggles:
# - CI_NETWORK                  : "arbitrum" | "arbitrumSepolia" (overrides branch inference)
# - RUN_CACHE_REFRESH           : "1" to run cache-refresh (write path)
# - GRANT_ROLE                  : "1" to auto-grant VIEW_RISK_DATA if missing (write path)
# - REQUIRE_AUTHZ               : "0" to allow skipping authorized reads if role missing

resolve_branch() {
  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then echo "$GITHUB_REF_NAME"; return; fi
  if [[ -n "${GITHUB_HEAD_REF:-}" ]]; then echo "$GITHUB_HEAD_REF"; return; fi
  if [[ -n "${CI_COMMIT_REF_NAME:-}" ]]; then echo "$CI_COMMIT_REF_NAME"; return; fi
  if [[ -n "${BRANCH_NAME:-}" ]]; then echo "$BRANCH_NAME"; return; fi
  echo ""
}

infer_network() {
  local branch="$1"
  if [[ "$branch" == *"arbitrum-sepolia"* ]] || [[ "$branch" == *"sepolia"* ]]; then
    echo "arbitrumSepolia"
    return
  fi
  if [[ "$branch" == *"arbitrum"* ]]; then
    echo "arbitrum"
    return
  fi
  echo "arbitrumSepolia"
}

NETWORK="${CI_NETWORK:-}"
if [[ -z "$NETWORK" ]]; then
  BRANCH="$(resolve_branch)"
  NETWORK="$(infer_network "$BRANCH")"
fi

if [[ "$NETWORK" != "arbitrum" && "$NETWORK" != "arbitrumSepolia" ]]; then
  echo "ERROR: unsupported CI_NETWORK=$NETWORK (expected arbitrum or arbitrumSepolia)" >&2
  exit 1
fi

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  echo "ERROR: missing PRIVATE_KEY" >&2
  exit 1
fi

if [[ "$NETWORK" == "arbitrum" ]]; then
  if [[ -z "${ARBITRUM_RPC_URL:-}" ]]; then
    echo "ERROR: missing ARBITRUM_RPC_URL" >&2
    exit 1
  fi
else
  if [[ -z "${ARBITRUM_SEPOLIA_RPC_URL:-}" ]]; then
    echo "ERROR: missing ARBITRUM_SEPOLIA_RPC_URL" >&2
    exit 1
  fi
fi

echo "== Real-chain CI =="
echo "  network=$NETWORK"
echo "  run_cache_refresh=${RUN_CACHE_REFRESH:-0}"
echo ""

# Read-path (recommended baseline)
READ_ONLY=1 pnpm -s exec hardhat run "scripts/tests/verify-config-ssot-local.ts" --network "$NETWORK"
GRANT_ROLE=${GRANT_ROLE:-0} REQUIRE_AUTHZ=${REQUIRE_AUTHZ:-1} pnpm -s exec hardhat run "scripts/tests/view-schemeu-smoke-local.ts" --network "$NETWORK"
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run "scripts/tests/viewcache-smoke-local.ts" --network "$NETWORK"

# Write-path (requires maintainer/admin rights)
if [[ "${RUN_CACHE_REFRESH:-0}" == "1" ]]; then
  ENABLE_WRITE=1 pnpm -s exec hardhat run "scripts/tests/cache-refresh-local.ts" --network "$NETWORK"
else
  echo "[skip] cache-refresh-local (set RUN_CACHE_REFRESH=1 to enable)"
fi
