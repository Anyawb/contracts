import { sweepManagedFreshBorrowers } from "../core/_freshBorrowerManager";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

async function main() {
  await sweepManagedFreshBorrowers();
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});