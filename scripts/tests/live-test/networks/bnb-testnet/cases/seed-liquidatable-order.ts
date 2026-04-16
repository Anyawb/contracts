import { seedLiquidatableOrder } from "../core/_liquidationSeed";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

async function main() {
  await seedLiquidatableOrder();
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});