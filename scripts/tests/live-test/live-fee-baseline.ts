import { runWithNetworkRetry } from "./_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "./_scriptStatus";
import { runLiveDomainPreflight } from "./_liveDomainPreflight";

type FeeLayer = "runtime" | "observability";

function resolveMode(): FeeLayer | "all" {
  const raw = process.env.LIVE_FEE_BASELINE_LAYER?.trim().toLowerCase();
  if (raw === "runtime" || raw === "observability" || raw === "all") {
    return raw;
  }
  return "all";
}

async function runLiveModule(modulePath: string) {
  const mod = await import(modulePath) as { liveScriptPromise?: Promise<void> };
  if (!mod.liveScriptPromise) {
    throw new Error(`${modulePath} does not export liveScriptPromise`);
  }
  await mod.liveScriptPromise;
}

async function runLayer(layer: FeeLayer) {
  console.log(`=== Live Fee Layer: ${layer} ===`);
  if (layer === "runtime") {
    await runLiveModule("./live-fee-accounting");
    return;
  }
  await runLiveModule("./live-fee-prepaid-gate");
  await runLiveModule("./live-fee-remaining-gate");
  await runLiveModule("./live-fee-dynamic-gate");
}

async function main() {
  await runLiveDomainPreflight("fee");
  const mode = resolveMode();
  if (mode === "all") {
    await runLayer("runtime");
    await runLayer("observability");
  } else {
    await runLayer(mode);
  }
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);