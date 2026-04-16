process.env.LIVE_REWARD_BASELINE_LAYER = "observability";

export const liveScriptPromise = import("./live-reward-baseline").then((mod) => mod.liveScriptPromise);