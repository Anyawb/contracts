process.env.LIVE_FEE_BASELINE_LAYER = "runtime";

export const liveScriptPromise = import("./live-fee-baseline").then((mod) => mod.liveScriptPromise);