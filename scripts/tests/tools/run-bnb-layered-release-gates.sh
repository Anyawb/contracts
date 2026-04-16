#!/usr/bin/env zsh
set -euo pipefail

set -a
[[ -f .env ]] && source ./.env
set +a

RUN_DIR="${RUN_DIR:-scripts/tests/logs/manual-bnb-release-gates-layered-$(date +%Y%m%d%H%M%S)}"
ALLOW_LAYER_B_ON_LAYER_A_FAIL="${ALLOW_LAYER_B_ON_LAYER_A_FAIL:-0}"

mkdir -p "$RUN_DIR"
SUMMARY_FILE="$RUN_DIR/summary.txt"

printf 'RUN_DIR=%s\n' "$RUN_DIR" | tee "$SUMMARY_FILE"
printf 'ALLOW_LAYER_B_ON_LAYER_A_FAIL=%s\n' "$ALLOW_LAYER_B_ON_LAYER_A_FAIL" | tee -a "$SUMMARY_FILE"

run_layer() {
  local layer_name="$1"
  local script_name="$2"
  local layer_log="$RUN_DIR/${layer_name}.log"
  local rc=0

  printf '\n=== %s ===\n' "$layer_name" | tee -a "$SUMMARY_FILE"
  set -o pipefail
  pnpm -s run "$script_name" 2>&1 | tee "$layer_log"
  rc=$?
  set +o pipefail

  local child_run_dir
  child_run_dir=$(grep -m1 '^RUN_DIR=' "$layer_log" | sed 's/^RUN_DIR=//' || true)
  if [[ -n "$child_run_dir" ]]; then
    printf '%s_RUN_DIR=%s\n' "$layer_name" "$child_run_dir" | tee -a "$SUMMARY_FILE"
    if [[ -d "$child_run_dir" ]]; then
      ln -sfn "../../../../$child_run_dir" "$RUN_DIR/${layer_name}-artifacts"
    fi
  fi

  printf '%s_RC=%s\n' "$layer_name" "$rc" | tee -a "$SUMMARY_FILE"
  return "$rc"
}

layer_a_rc=0
layer_b_rc=0

if run_layer "layer-a" "test:live:release-gates:bnb-testnet:layer-a:stream"; then
  layer_a_rc=0
else
  layer_a_rc=$?
fi

if [[ "$layer_a_rc" -eq 0 || "$ALLOW_LAYER_B_ON_LAYER_A_FAIL" == "1" ]]; then
  if run_layer "layer-b" "test:live:release-gates:bnb-testnet:layer-b:stream"; then
    layer_b_rc=0
  else
    layer_b_rc=$?
  fi
else
  layer_b_rc=99
  printf 'layer-b_SKIPPED=1\n' | tee -a "$SUMMARY_FILE"
fi

overall_rc=0
if [[ "$layer_a_rc" -ne 0 ]]; then
  overall_rc="$layer_a_rc"
elif [[ "$layer_b_rc" -ne 0 && "$layer_b_rc" -ne 99 ]]; then
  overall_rc="$layer_b_rc"
elif [[ "$layer_b_rc" -eq 99 ]]; then
  overall_rc=1
fi

printf 'OVERALL_RC=%s\n' "$overall_rc" | tee -a "$SUMMARY_FILE"

if [[ "$overall_rc" -eq 0 ]]; then
  echo OK > "$RUN_DIR/OK.txt"
else
  echo FAIL > "$RUN_DIR/FAILED.txt"
fi

exit "$overall_rc"
