process.env.LIVE_FEE_BASELINE_LAYER = "observability";

export const liveScriptPromise = import("./live-fee-baseline").then((mod) => mod.liveScriptPromise);