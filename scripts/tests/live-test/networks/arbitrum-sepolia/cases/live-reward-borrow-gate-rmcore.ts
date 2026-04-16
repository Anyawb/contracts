import { runLiveRewardBorrowGateAudit } from "../../../../tools/live-reward-borrow-gate-audit";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

async function main() {
  await runLiveRewardBorrowGateAudit();
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
