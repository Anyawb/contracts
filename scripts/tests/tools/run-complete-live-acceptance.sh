#!/usr/bin/env zsh

setopt errexit pipefail

RUN_TS="$(date +%Y%m%d%H%M%S)"
RUN_DIR="scripts/tests/logs/manual-complete-live-acceptance-${RUN_TS}"
mkdir -p "$RUN_DIR"

record_child_run_dir() {
  local label="$1"
  local logfile="$2"
  local child_run_dir

  child_run_dir="$(sed -n 's/^RUN_DIR=//p' "$logfile" | tail -n 1)"
  if [[ -z "$child_run_dir" ]]; then
    echo "failed to parse child RUN_DIR from $logfile" >&2
    exit 1
  fi

  echo "${label}_RUN_DIR=${child_run_dir}" | tee -a "$RUN_DIR/child-runs.env" >/dev/null
}

run_batch() {
  local label="$1"
  local script_path="$2"
  local logfile="$RUN_DIR/${label}.log"

  zsh "$script_path" 2>&1 | tee "$logfile"
  record_child_run_dir "$label" "$logfile"
}

run_batch "00-round2-acceptance" "scripts/tests/tools/run-round2-acceptance.sh"
run_batch "01-remaining-acceptance" "scripts/tests/tools/run-remaining-live-acceptance.sh"

echo "RUN_DIR=$RUN_DIR"