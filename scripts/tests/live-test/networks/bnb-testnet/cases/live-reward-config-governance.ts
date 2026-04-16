import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { key } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import {
  expectStaticRevert,
  loadRewardModules,
  prepareRewardGovernanceCompatibility,
  readEasyEmissionParamsSnapshot,
} from "../core/_rewardLive";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

async function hasAnyRole(acm: any, address: string, names: string[]) {
  for (const name of names) {
    if ((await acm.hasRole(key(name), address)) as boolean) {
      return true;
    }
  }
  return false;
}

async function tryIdempotentWrite(label: string, preview: () => Promise<unknown>, write: () => Promise<any>) {
  try {
    await preview();
  } catch (error) {
    console.log(`  [Notice] skip ${label}: ${String((error as any)?.shortMessage ?? (error as any)?.message ?? error)}`);
    return false;
  }
  await (await write()).wait();
  return true;
}

async function pickUnauthorizedSigner(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>) {
  for (const signer of [ctx.lender, ctx.viewer, ctx.borrower]) {
    if (!signer) continue;
    if (String(signer.address).toLowerCase() === ctx.relayer.address.toLowerCase()) {
      continue;
    }
    const hasSetParameter = await hasAnyRole(ctx.acm, signer.address, ["ACTION_SET_PARAMETER", "SET_PARAMETER"]);
    const hasEmergency = await hasAnyRole(ctx.acm, signer.address, ["ACTION_REWARD_CONFIG_EMERGENCY", "REWARD_CONFIG_EMERGENCY"]);
    if (!hasSetParameter && !hasEmergency) {
      return signer;
    }
  }
  return null;
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Reward Config Governance",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });
  const reward = await loadRewardModules(ctx);
  const governanceCompatibility = await prepareRewardGovernanceCompatibility(reward.easyEmissionConfig.target as string);
  const legacyEasyEmissionConfig = governanceCompatibility.legacyEasyEmissionConfig;

  const dynamicBefore = (await reward.rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
  const levelBefore = (await reward.rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];
  const emissionBefore = await readEasyEmissionParamsSnapshot(reward.easyEmissionConfig.target as string);
  const emissionViewBefore = legacyEasyEmissionConfig
    ? null
    : ((await reward.rewardView.getEasyEmissionParamsWithMeta()) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean]);
  const featurePage = (await reward.featureRegistry.listFeatureKeys(0n, 1n)) as [string[], bigint];
  const featureKeys = Array.from(featurePage[0] ?? []);
  const featureKey = featureKeys.length > 0 ? featureKeys[0] : null;
  const featureBefore = featureKey
    ? ((await reward.featureRegistry.getFeature(featureKey)) as [number, boolean, string])
    : null;
  const unauthorizedSigner = await pickUnauthorizedSigner(ctx);

  if (unauthorizedSigner) {
    await expectStaticRevert("RewardManager.setDynamicRewardParams gate", () =>
      reward.rewardManager.connect(unauthorizedSigner).setDynamicRewardParams.staticCall(dynamicBefore[0], dynamicBefore[1]));
    await expectStaticRevert("RewardManager.setLevelMultiplier gate", () =>
      reward.rewardManager.connect(unauthorizedSigner).setLevelMultiplier.staticCall(1, levelBefore[0]));
    await expectStaticRevert("EasyEmissionConfig.setEmissionParams gate", () =>
      reward.easyEmissionConfig.connect(unauthorizedSigner).setEmissionParams.staticCall(
        emissionBefore.thresholdValue,
        emissionBefore.mintPer1000Usd,
        emissionBefore.kNum,
        emissionBefore.kDen,
      ));
    if (featureKey && featureBefore) {
      await expectStaticRevert("RewardConfig.setFeature gate", () =>
        reward.rewardConfig.connect(unauthorizedSigner).setFeature.staticCall(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]));
      await expectStaticRevert("FeatureRegistry.setFeature emergency gate", () =>
        reward.featureRegistry.connect(unauthorizedSigner).setFeature.staticCall(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]));
    }
  } else {
    console.log("  [Notice] no distinct unauthorized signer found; skipping negative caller-gate coverage for reward governance");
  }

  const hasSetParameter = await hasAnyRole(ctx.acm, ctx.relayer.address, ["ACTION_SET_PARAMETER", "SET_PARAMETER"]);
  const hasEmergency = await hasAnyRole(ctx.acm, ctx.relayer.address, [
    "ACTION_REWARD_CONFIG_EMERGENCY",
    "REWARD_CONFIG_EMERGENCY",
  ]);

  if (!hasSetParameter) {
    console.log(`  [Notice] relayer ${ctx.relayer.address} lacks ACTION_SET_PARAMETER; governance coverage is limited to negative caller-gate checks`);
    logLiveScriptSuccess(__filename);
    return;
  }

  const wroteDynamic = await tryIdempotentWrite(
    "RewardManager.setDynamicRewardParams idempotent write",
    () => reward.rewardManager.connect(ctx.relayer).setDynamicRewardParams.staticCall(dynamicBefore[0], dynamicBefore[1]),
    () => reward.rewardManager.connect(ctx.relayer).setDynamicRewardParams(dynamicBefore[0], dynamicBefore[1]),
  );
  const wroteLevel = await tryIdempotentWrite(
    "RewardManager.setLevelMultiplier idempotent write",
    () => reward.rewardManager.connect(ctx.relayer).setLevelMultiplier.staticCall(1, levelBefore[0]),
    () => reward.rewardManager.connect(ctx.relayer).setLevelMultiplier(1, levelBefore[0]),
  );
  const wroteEmission = await tryIdempotentWrite(
    "EasyEmissionConfig.setEmissionParams idempotent write",
    () => reward.easyEmissionConfig.connect(ctx.relayer).setEmissionParams.staticCall(
      emissionBefore.thresholdValue,
      emissionBefore.mintPer1000Usd,
      emissionBefore.kNum,
      emissionBefore.kDen,
    ),
    () => reward.easyEmissionConfig.connect(ctx.relayer).setEmissionParams(
      emissionBefore.thresholdValue,
      emissionBefore.mintPer1000Usd,
      emissionBefore.kNum,
      emissionBefore.kDen,
    ),
  );

  if (featureKey && featureBefore) {
    await tryIdempotentWrite(
      "RewardConfig.setFeature idempotent write",
      () => reward.rewardConfig.connect(ctx.relayer).setFeature.staticCall(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]),
      () => reward.rewardConfig.connect(ctx.relayer).setFeature(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]),
    );
    if (hasEmergency) {
      await tryIdempotentWrite(
        "FeatureRegistry.setFeature idempotent write",
        () => reward.featureRegistry.connect(ctx.relayer).setFeature.staticCall(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]),
        () => reward.featureRegistry.connect(ctx.relayer).setFeature(featureKey, featureBefore[0], featureBefore[1], featureBefore[2]),
      );
    }
  }

  const dynamicAfter = (await reward.rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
  const levelAfter = (await reward.rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];
  const emissionAfter = await readEasyEmissionParamsSnapshot(reward.easyEmissionConfig.target as string);
  const emissionViewAfter = legacyEasyEmissionConfig
    ? null
    : ((await reward.rewardView.getEasyEmissionParamsWithMeta()) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean]);

  if (wroteDynamic && (dynamicAfter[0] !== dynamicBefore[0] || dynamicAfter[1] !== dynamicBefore[1])) {
    throw new Error("dynamic reward params changed after idempotent governance write");
  }
  if (wroteLevel && levelAfter[0] !== levelBefore[0]) {
    throw new Error("level multiplier changed after idempotent governance write");
  }
  if (
    wroteEmission && (
    emissionAfter.thresholdValue !== emissionBefore.thresholdValue
    || emissionAfter.mintPer1000Usd !== emissionBefore.mintPer1000Usd
    || emissionAfter.kNum !== emissionBefore.kNum
    || emissionAfter.kDen !== emissionBefore.kDen
    )
  ) {
    throw new Error("EasyEmissionConfig values changed after idempotent governance write");
  }
  if (
    wroteEmission && emissionViewBefore && emissionViewAfter && (
    emissionViewAfter[0] !== emissionBefore.thresholdValue
    || emissionViewAfter[1] !== emissionBefore.mintPer1000Usd
    || emissionViewAfter[2] !== emissionBefore.kNum
    || emissionViewAfter[3] !== emissionBefore.kDen
    )
  ) {
    throw new Error("RewardView easy emission cache drifted after idempotent governance write");
  }
  if (wroteDynamic && dynamicAfter[2] < dynamicBefore[2]) {
    throw new Error("dynamic reward cache block regressed after governance write");
  }
  if (wroteLevel && levelAfter[1] < levelBefore[1]) {
    throw new Error("level multiplier cache block regressed after governance write");
  }

  console.log(
    `  [RewardGovernance] hasSetParameter=${String(hasSetParameter)} hasEmergency=${String(hasEmergency)} featureKey=${featureKey ?? "none"} unauthorizedSigner=${unauthorizedSigner?.address ?? "none"} legacyEasyEmissionConfig=${String(legacyEasyEmissionConfig)} shape=${governanceCompatibility.shape}`,
  );
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
