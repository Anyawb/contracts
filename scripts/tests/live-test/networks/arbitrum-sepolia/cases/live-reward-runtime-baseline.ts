process.env.LIVE_REWARD_BASELINE_LAYER = "runtime";

export const liveScriptPromise = import("./live-reward-baseline").then((mod) => mod.liveScriptPromise);