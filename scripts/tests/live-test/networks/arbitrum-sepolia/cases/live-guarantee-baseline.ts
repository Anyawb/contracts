import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";
import { runLiveDomainPreflight } from "../core/_liveDomainPreflight";

type GuaranteeLayer = "runtime" | "observability";

function resolveMode(): GuaranteeLayer | "all" {
  const raw = process.env.LIVE_GUARANTEE_BASELINE_LAYER?.trim().toLowerCase();
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

async function runLayer(layer: GuaranteeLayer) {
  console.log(`=== Live Guarantee Layer: ${layer} ===`);
  if (layer === "runtime") {
    await runLiveModule("./live-guarantee-flow");
    return;
  }
  await runLiveModule("./live-guarantee-events-datapush");
}

async function main() {
  await runLiveDomainPreflight("guarantee");
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