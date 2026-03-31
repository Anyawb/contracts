import { ethers, network } from "hardhat";

export function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

const coder = ethers.AbiCoder.defaultAbiCoder();
const DATA_PUSH_TOPIC0 = ethers.keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)")).toLowerCase();
const PUSH_FAILED_IFACE = new ethers.Interface([
  "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
]);

export const DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = ethers.keccak256(
  ethers.toUtf8Bytes("REWARD_PENALTY_LEDGER_UPDATED")
);
export const REWARD_VIEW_OP_PENALTY_LEDGER = ethers.keccak256(ethers.toUtf8Bytes("PENALTY_LEDGER"));
export const REWARD_VIEW_UNAVAILABLE_REASON_HEX = ethers.hexlify(ethers.toUtf8Bytes("rewardView unavailable")).toLowerCase();

export function errorSelector(signature: string): string {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

export function getRevertSelector(input: any): string | undefined {
  const raw =
    typeof input === "string"
      ? input
      : typeof input?.data === "string"
        ? input.data
        : typeof input?.reason === "string"
          ? input.reason
          : undefined;
  if (!raw || !raw.startsWith("0x") || raw.length < 10) return undefined;
  return raw.slice(0, 10).toLowerCase();
}

export function extractDataPushed(receipt: any, emitter?: string): Array<{ dataTypeHash: string; payload: string }> {
  const out: Array<{ dataTypeHash: string; payload: string }> = [];
  for (const log of receipt?.logs || []) {
    const topics = (log.topics as string[]) || [];
    if (topics.length === 0) continue;
    if ((topics[0] as string).toLowerCase() !== DATA_PUSH_TOPIC0) continue;
    if (emitter && String(log.address ?? "").toLowerCase() !== emitter.toLowerCase()) continue;

    if (topics.length >= 2) {
      const dataTypeHash = (topics[1] as string).toLowerCase();
      const [payload] = coder.decode(["bytes"], log.data) as unknown as [string];
      out.push({ dataTypeHash, payload });
      continue;
    }

    const [dataTypeHash, payload] = coder.decode(["bytes32", "bytes"], log.data) as unknown as [string, string];
    out.push({ dataTypeHash: String(dataTypeHash).toLowerCase(), payload });
  }
  return out;
}

export function extractRewardViewPushFailed(
  receipt: any,
  emitter: string
): Array<{ user: string; rewardView: string; op: string; payload: string; reason: string }> {
  const out: Array<{ user: string; rewardView: string; op: string; payload: string; reason: string }> = [];
  for (const log of receipt?.logs || []) {
    if (String(log?.address ?? "").toLowerCase() !== emitter.toLowerCase()) continue;
    try {
      const parsed = PUSH_FAILED_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;
      out.push({
        user: String(parsed.args.user),
        rewardView: String(parsed.args.rewardView),
        op: String(parsed.args.op),
        payload: String(parsed.args.payload),
        reason: String(parsed.args.reason),
      });
    } catch {
      // ignore non-matching logs
    }
  }
  return out;
}

export function extractDataPushPayloads(receipt: any, typeHash: string, emitter?: string): string[] {
  const want = typeHash.toLowerCase();
  return extractDataPushed(receipt, emitter)
    .filter((p) => p.dataTypeHash.toLowerCase() === want)
    .map((p) => p.payload);
}

export function getLastDataPushPayload(receipt: any, typeHash: string, emitter?: string): string | undefined {
  const payloads = extractDataPushPayloads(receipt, typeHash, emitter);
  return payloads.length > 0 ? payloads[payloads.length - 1] : undefined;
}

export async function stopImpersonating(addr: string) {
  try {
    await network.provider.send("hardhat_stopImpersonatingAccount", [addr]);
  } catch {
    // best-effort
  }
}

async function deployUnavailableRewardView(deployer: any): Promise<string> {
  const factory = await ethers.getContractFactory("MockRewardViewUnavailable", deployer);
  const mock = await factory.deploy();
  await mock.waitForDeployment();
  return await mock.getAddress();
}

async function advanceRewardViewCacheTtl() {
  await network.provider.send("hardhat_mine", [ethers.toBeHex(1_801)]);
}

async function advanceBlocks(blocks: bigint) {
  if (blocks <= 0n) return;
  await network.provider.send("hardhat_mine", [ethers.toBeHex(blocks)]);
}

export async function runRewardExtendedChecks(opts: {
  registry: any;
  acm: any;
  deployer: any;
  waitTx: (p: Promise<any>, label: string) => Promise<any>;
  strictReward: boolean;
  rewardView: any | null;
  rewardViewAddr: string;
  easyEmissionConfig: any | null;
  easyEmissionConfigAddr: string;
  rewardAccrualManager: any | null;
  ramAddr: string;
  rmCoreAddr: string;
  artifactTarget?: Record<string, any>;
  artifactKey?: string;
  logNotice?: (msg: string) => void;
  log?: (msg: string) => void;
}) {
  const out: Record<string, any> = {
    ok: true,
    reasonDecode: { skipped: false },
    multiPushLastWins: { skipped: false },
    missingRewardViewBestEffort: { skipped: false },
  };

  const strictReward = opts.strictReward;
  const logNotice = opts.logNotice ?? (() => {});
  const log = opts.log ?? console.log;
  const artifactKey = opts.artifactKey ?? "reward_extended_checks";
  const unauthorizedWriterSel = errorSelector("RewardView__UnauthorizedWriter()");

  if (!opts.easyEmissionConfig || !opts.easyEmissionConfigAddr || opts.easyEmissionConfigAddr === ethers.ZeroAddress) {
    out.reasonDecode = { skipped: true, reason: "missing EASY_EMISSION_CONFIG in registry" };
    if (strictReward) throw new Error("[Reward] extended checks: missing EASY_EMISSION_CONFIG in registry");
    logNotice("  [Notice] [Reward] extended checks: missing EASY_EMISSION_CONFIG in registry");
  } else {
    const hasParam = (await opts.acm.hasRole(key("SET_PARAMETER"), opts.deployer.address)) as boolean;
    if (!hasParam) {
      out.reasonDecode = { skipped: true, reason: "deployer missing SET_PARAMETER" };
      if (strictReward) throw new Error("[Reward] extended checks: deployer missing SET_PARAMETER");
      logNotice("  [Notice] [Reward] extended checks: deployer missing SET_PARAMETER");
    } else {
      const wrong = ethers.Wallet.createRandom().address;
      await opts.waitTx(
        opts.registry.connect(opts.deployer).setModule(key("EASY_EMISSION_CONFIG"), wrong),
        "Reward extended: misconfigure EASY_EMISSION_CONFIG"
      );
      try {
        const txBad = await opts.easyEmissionConfig.connect(opts.deployer).setEmissionParams(10n, 11n, 12n, 13n);
        const rcptBad = await txBad.wait();

        const failed = extractRewardViewPushFailed(rcptBad, opts.easyEmissionConfigAddr);
        if (failed.length !== 1) {
          throw new Error(`[Reward] extended reasonDecode: expected 1 RewardViewPushFailed, got ${failed.length}`);
        }
        const selector = getRevertSelector(failed[0].reason);
        if (selector !== unauthorizedWriterSel) {
          throw new Error(
            `[Reward] extended reasonDecode: selector mismatch got=${selector} expect=${unauthorizedWriterSel}`
          );
        }

        out.reasonDecode = {
          skipped: false,
          txHash: txBad.hash,
          selector,
          expectedSelector: unauthorizedWriterSel,
          rewardView: failed[0].rewardView,
          op: failed[0].op,
        };
      } finally {
        await opts.waitTx(
          opts.registry.connect(opts.deployer).setModule(key("EASY_EMISSION_CONFIG"), opts.easyEmissionConfigAddr),
          "Reward extended: restore EASY_EMISSION_CONFIG"
        );
      }
    }
  }

  if (!opts.rewardAccrualManager || !opts.ramAddr || opts.ramAddr === ethers.ZeroAddress || !opts.rewardView || !opts.rewardViewAddr || opts.rewardViewAddr === ethers.ZeroAddress) {
    out.multiPushLastWins = { skipped: true, reason: "missing reward modules in registry" };
    if (strictReward) throw new Error("[Reward] extended checks: missing reward modules in registry");
    logNotice("  [Notice] [Reward] extended checks: missing reward modules in registry");
  } else {
    const batchUser = ethers.Wallet.createRandom().address;
    const debt = 100n;
    const amount1 = 30n;
    const amount2 = 20n;
    const expectedRemaining = debt - amount1 - amount2;

    await network.provider.send("hardhat_impersonateAccount", [opts.rmCoreAddr]);
    await network.provider.send("hardhat_setBalance", [opts.rmCoreAddr, "0x56BC75E2D63100000"]);
    const rmcSigner = await ethers.getSigner(String(opts.rmCoreAddr));

    await opts.waitTx(
      opts.rewardAccrualManager.connect(rmcSigner).applyLateRepayPenalty(batchUser, debt, opts.rmCoreAddr),
      "Reward extended: seed penalty debt"
    );

    const BatchCallerF = await ethers.getContractFactory("MockRewardAccrualBatchCaller");
    const batchCaller = await BatchCallerF.connect(opts.deployer).deploy();
    await batchCaller.waitForDeployment();

    await opts.waitTx(
      opts.registry.connect(opts.deployer).setModule(key("REWARD_MANAGER_CORE"), await batchCaller.getAddress()),
      "Reward extended: set batch caller as RMCore"
    );

    try {
      const txBatch = await batchCaller.offsetTwice(
        opts.ramAddr,
        batchUser,
        amount1,
        amount2,
        "first",
        "second"
      );
      const rcptBatch = await txBatch.wait();

      const payloads = extractDataPushPayloads(rcptBatch, DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED, opts.rewardViewAddr);
      if (payloads.length < 2) {
        throw new Error(`[Reward] extended multiPush: expected >=2 penalty-ledger pushes, got ${payloads.length}`);
      }

      const lastPayload = getLastDataPushPayload(rcptBatch, DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED, opts.rewardViewAddr);
      if (!lastPayload) throw new Error("[Reward] extended multiPush: missing last penalty-ledger payload");

      const [payloadUser, pendingDebt, blockNumber] = coder.decode(
        ["address", "uint256", "uint256"],
        lastPayload
      ) as unknown as [string, bigint, bigint];

      if (payloadUser.toLowerCase() !== batchUser.toLowerCase()) {
        throw new Error("[Reward] extended multiPush: last payload user mismatch");
      }
      if (BigInt(pendingDebt) !== expectedRemaining) {
        throw new Error(
          `[Reward] extended multiPush: last payload debt mismatch got=${pendingDebt.toString()} expect=${expectedRemaining.toString()}`
        );
      }

      const summary = await opts.rewardView.connect(opts.deployer).getUserRewardSummaryWithMeta(batchUser);
      if ((summary[1] as bigint) !== expectedRemaining) {
        throw new Error(
          `[Reward] extended multiPush: RewardView pendingPenalty mismatch got=${summary[1].toString()} expect=${expectedRemaining.toString()}`
        );
      }

      out.multiPushLastWins = {
        skipped: false,
        txHash: txBatch.hash,
        pushCount: payloads.length,
        lastPayloadUser: payloadUser,
        lastPayloadDebt: pendingDebt.toString(),
        lastPayloadBlock: blockNumber.toString(),
        rewardViewPendingPenalty: summary[1].toString(),
      };
    } finally {
      await opts.waitTx(
        opts.registry.connect(opts.deployer).setModule(key("REWARD_MANAGER_CORE"), opts.rmCoreAddr),
        "Reward extended: restore RMCore"
      );
      await stopImpersonating(opts.rmCoreAddr);
    }
  }

  if (!opts.rewardAccrualManager || !opts.ramAddr || opts.ramAddr === ethers.ZeroAddress || !opts.rewardViewAddr || opts.rewardViewAddr === ethers.ZeroAddress) {
    out.missingRewardViewBestEffort = { skipped: true, reason: "missing reward modules in registry" };
    if (strictReward) throw new Error("[Reward] extended checks: missing reward modules for degradation path");
    logNotice("  [Notice] [Reward] extended checks: missing reward modules for degradation path");
  } else {
    const degradeUser = ethers.Wallet.createRandom().address;
    const seededDebt = 25n;
    const offsetAmount = 10n;
    const expectedRemaining = seededDebt - offsetAmount;

    await network.provider.send("hardhat_impersonateAccount", [opts.rmCoreAddr]);
    await network.provider.send("hardhat_setBalance", [opts.rmCoreAddr, "0x56BC75E2D63100000"]);
    const rmcSigner = await ethers.getSigner(String(opts.rmCoreAddr));

    await opts.waitTx(
      opts.rewardAccrualManager.connect(rmcSigner).applyLateRepayPenalty(degradeUser, seededDebt, opts.rmCoreAddr),
      "Reward extended: seed degrade penalty debt"
    );

    const unavailableRewardView = await deployUnavailableRewardView(opts.deployer);
    await opts.waitTx(
      opts.registry.connect(opts.deployer).setModule(key("REWARD_VIEW"), unavailableRewardView),
      "Reward extended: replace REWARD_VIEW with unavailable mock"
    );
    await advanceRewardViewCacheTtl();

    try {
      const txDegrade = await opts.rewardAccrualManager
        .connect(rmcSigner)
        .offsetPenaltyOnReward(degradeUser, offsetAmount, "reward-view-unavailable");
      const rcptDegrade = await txDegrade.wait();

      const failed = extractRewardViewPushFailed(rcptDegrade, opts.ramAddr);
      const penaltyFailed = failed.find((entry) => entry.op.toLowerCase() === REWARD_VIEW_OP_PENALTY_LEDGER.toLowerCase());
      if (!penaltyFailed) {
        throw new Error("[Reward] extended degrade: missing RewardViewPushFailed(PENALTY_LEDGER)");
      }

      const selector = getRevertSelector(penaltyFailed.reason);
      selector;

      const remaining = (await opts.rewardAccrualManager.getPenaltyDebt(degradeUser)) as bigint;
      if (remaining !== expectedRemaining) {
        throw new Error(
          `[Reward] extended degrade: penalty debt mismatch got=${remaining.toString()} expect=${expectedRemaining.toString()}`
        );
      }

      const reasonHex = ethers.hexlify(ethers.getBytes(penaltyFailed.reason)).toLowerCase();
      if (reasonHex !== REWARD_VIEW_UNAVAILABLE_REASON_HEX) {
        throw new Error(
          `[Reward] extended degrade: unexpected failure reason got=${reasonHex} expect=${REWARD_VIEW_UNAVAILABLE_REASON_HEX}`
        );
      }

      out.missingRewardViewBestEffort = {
        skipped: false,
        txHash: txDegrade.hash,
        op: penaltyFailed.op,
        rewardView: penaltyFailed.rewardView,
        unavailableRewardView,
        reasonHex,
        pendingPenaltyAfter: remaining.toString(),
        semantics:
          "main-path-success-is-authoritative; RewardView failure markers are observability signals and backend must reconcile while cache rollover is pending",
        rewardViewCacheDelayBlocks: "1800",
      };

      const immediateUser = ethers.Wallet.createRandom().address;
      await opts.waitTx(
        opts.rewardAccrualManager.connect(rmcSigner).applyLateRepayPenalty(immediateUser, seededDebt, opts.rmCoreAddr),
        "Reward extended: seed immediate penalty debt"
      );
      const txImmediate = await opts.rewardAccrualManager
        .connect(rmcSigner)
        .offsetPenaltyOnReward(immediateUser, offsetAmount, "reward-view-cache-pending");
      const rcptImmediate = await txImmediate.wait();
      const immediateFailed = extractRewardViewPushFailed(rcptImmediate, opts.ramAddr).filter(
        (entry) => entry.op.toLowerCase() === REWARD_VIEW_OP_PENALTY_LEDGER.toLowerCase()
      );
      const immediateRemaining = (await opts.rewardAccrualManager.getPenaltyDebt(immediateUser)) as bigint;
      if (immediateRemaining !== expectedRemaining) {
        throw new Error(
          `[Reward] extended degrade immediate: penalty debt mismatch got=${immediateRemaining.toString()} expect=${expectedRemaining.toString()}`
        );
      }

      out.missingRewardViewBestEffort.immediateBeforeCacheRollover = {
        txHash: txImmediate.hash,
        user: immediateUser,
        blockNumber: String(rcptImmediate?.blockNumber ?? 0),
        penaltyDebtAfter: immediateRemaining.toString(),
        rewardViewPushFailedCount: immediateFailed.length,
        expectedBehavior:
          "zero failure markers is acceptable before cache rollover because RewardView address caching does not affect the reward ledger result",
      };

      await advanceBlocks(1_801n);

      const delayedUser = ethers.Wallet.createRandom().address;
      await opts.waitTx(
        opts.rewardAccrualManager.connect(rmcSigner).applyLateRepayPenalty(delayedUser, seededDebt, opts.rmCoreAddr),
        "Reward extended: seed delayed penalty debt"
      );
      const txDelayed = await opts.rewardAccrualManager
        .connect(rmcSigner)
        .offsetPenaltyOnReward(delayedUser, offsetAmount, "reward-view-cache-rolled");
      const rcptDelayed = await txDelayed.wait();
      const delayedFailed = extractRewardViewPushFailed(rcptDelayed, opts.ramAddr).filter(
        (entry) => entry.op.toLowerCase() === REWARD_VIEW_OP_PENALTY_LEDGER.toLowerCase()
      );
      if (delayedFailed.length === 0) {
        throw new Error("[Reward] extended degrade delayed: expected RewardViewPushFailed(PENALTY_LEDGER) after cache rollover");
      }
      const delayedReasonHex = ethers.hexlify(ethers.getBytes(delayedFailed[delayedFailed.length - 1].reason)).toLowerCase();
      if (delayedReasonHex !== REWARD_VIEW_UNAVAILABLE_REASON_HEX) {
        throw new Error(
          `[Reward] extended degrade delayed: unexpected failure reason got=${delayedReasonHex} expect=${REWARD_VIEW_UNAVAILABLE_REASON_HEX}`
        );
      }
      const delayedRemaining = (await opts.rewardAccrualManager.getPenaltyDebt(delayedUser)) as bigint;
      if (delayedRemaining !== expectedRemaining) {
        throw new Error(
          `[Reward] extended degrade delayed: penalty debt mismatch got=${delayedRemaining.toString()} expect=${expectedRemaining.toString()}`
        );
      }

      out.missingRewardViewBestEffort.afterCacheRollover = {
        txHash: txDelayed.hash,
        user: delayedUser,
        blockNumber: String(rcptDelayed?.blockNumber ?? 0),
        penaltyDebtAfter: delayedRemaining.toString(),
        rewardViewPushFailedCount: delayedFailed.length,
        lastFailureReason: delayedReasonHex,
      };
    } finally {
      await opts.waitTx(
        opts.registry.connect(opts.deployer).setModule(key("REWARD_VIEW"), opts.rewardViewAddr),
        "Reward extended: restore REWARD_VIEW"
      );
      await advanceRewardViewCacheTtl();
      await stopImpersonating(opts.rmCoreAddr);
    }
  }

  if (opts.artifactTarget) opts.artifactTarget[artifactKey] = out;
  log(
    `  [Reward] extended checks: reasonDecode=${out.reasonDecode.skipped ? "skipped" : "ok"} multiPushLastWins=${out.multiPushLastWins.skipped ? "skipped" : "ok"} missingRewardViewBestEffort=${out.missingRewardViewBestEffort.skipped ? "skipped" : "ok"}`
  );
  return out;
}
