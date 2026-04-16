import { runWithNetworkRetry } from "../tests/live-test/networks/arbitrum-sepolia/core/_networkRetry";
import { resolveLiveScriptId } from "../tests/live-test/networks/arbitrum-sepolia/core/_scriptStatus";

async function runLiquidationFallbackParity(): Promise<void> {
  const modulePath = "../tests/live-test/networks/arbitrum-sepolia/cases/live-liquidation-fallback";
  const module = (await import(modulePath)) as {
    liveScriptPromise?: Promise<void>;
    runLiquidationFallbackParity?: () => Promise<void>;
  };
  if (module.liveScriptPromise) {
    await module.liveScriptPromise;
    return;
  }
  if (typeof module.runLiquidationFallbackParity !== "function") {
    throw new Error(`Missing liveScriptPromise/runLiquidationFallbackParity export from ${modulePath}`);
  }
  await module.runLiquidationFallbackParity();
}

export const liveScriptPromise = runWithNetworkRetry(
  resolveLiveScriptId(__filename),
  runLiquidationFallbackParity,
);