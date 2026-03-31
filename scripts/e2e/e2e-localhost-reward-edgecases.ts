import { ethers, network } from "hardhat";
import { runViewPreflight } from "./utils/view-preflight.ts";
import { envBool, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
const PUSH_FAILED_IFACE = new ethers.Interface([
  "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
]);
const UNAUTHORIZED_WRITER_SELECTOR = ethers.id("RewardView__UnauthorizedWriter()").slice(0, 10).toLowerCase();

function hasDataPush(receipt: any, emitter: string, typeHash: string): boolean {
  const logs = (receipt?.logs ?? []).filter((log: any) => {
    if ((log?.topics?.[0] || "").toLowerCase() !== DATA_PUSH_TOPIC0) return false;
    return String(log.address ?? "").toLowerCase() === emitter.toLowerCase();
  });
  return logs.some((log: any) => {
    const parsed = DATA_PUSH_IFACE.parseLog(log);
    if (!parsed) return false;
    return String(parsed.args.dataTypeHash).toLowerCase() === typeHash.toLowerCase();
  });
}

function getDataPushPayloads(receipt: any, emitter: string, typeHash: string): string[] {
  const logs = (receipt?.logs ?? []).filter((log: any) => {
    if ((log?.topics?.[0] || "").toLowerCase() !== DATA_PUSH_TOPIC0) return false;
    return String(log.address ?? "").toLowerCase() === emitter.toLowerCase();
  });
  return logs
    .map((log: any) => DATA_PUSH_IFACE.parseLog(log))
    .filter((parsed: any) => parsed)
    .map((parsed: any) => parsed.args)
    .filter((args: any) => String(args.dataTypeHash).toLowerCase() === typeHash.toLowerCase())
    .map((args: any) => args.payload as string);
}

function getRewardViewPushFailed(receipt: any, emitter: string): Array<{ reason: string }> {
  return (receipt?.logs ?? [])
    .filter((log: any) => String(log.address ?? "").toLowerCase() === emitter.toLowerCase())
    .map((log: any) => {
      try {
        const parsed = PUSH_FAILED_IFACE.parseLog(log);
        return parsed ? (parsed.args as any) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getErrorSelector(reasonBytes: string): string {
  const bytes = ethers.getBytes(reasonBytes);
  if (bytes.length < 4) return "0x";
  return ethers.hexlify(bytes.slice(0, 4));
}

export async function runRewardEdgecases() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);
  const strictDataPush = envBool("E2E_STRICT_DATAPUSH", false);

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  if (!supportsHardhat) {
    throw new Error("reward-edgecases requires localhost/hardhat for impersonation");
  }

  if (readOnly || !enableWrite) {
    throw new Error("reward-edgecases requires ENABLE_WRITE=1 (read-only mode is not supported)");
  }

  const snap = enableWrite ? await network.provider.send("evm_snapshot", []) : "";
  try {
    const [deployer] = await ethers.getSigners();

    console.log(`=== E2E Reward edgecases (${network.name}) ===`);
    console.log(`Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite} STRICT_DATAPUSH=${strictDataPush}\n`);

    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetForPriceCheck = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck,
      ensureViewPushRole: enableWrite,
      ensureHealthPushDeps: enableWrite,
    });

    const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const rewardManagerAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const rewardAccrualManagerAddr = (await registry.getModuleOrRevert(key("REWARD_ACCRUAL_MANAGER"))) as string;
    const rewardManagerCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const easyEmissionConfigAddr = (await registry.getModule(key("EASY_EMISSION_CONFIG"))) as string;

    const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;
    const rewardManager = (await ethers.getContractAt("RewardManager", rewardManagerAddr)) as any;
    const rewardAccrualManager = (await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

    const hasParam = (await acm.hasRole(key("SET_PARAMETER"), deployer.address)) as boolean;
    assertOk(hasParam, "missing SET_PARAMETER role for edgecases");

    // Normalize reward params to deterministic baseline.
    await (await rewardManager.connect(deployer).setLevelMultiplier(1, 10_000)).wait();
    await (await rewardManager.connect(deployer).setDynamicRewardParams(0n, 0n)).wait();
    await (await rewardManager.connect(deployer).setLatePenaltyBps(500n)).wait();

    await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]);
    const oe = await ethers.getSigner(orderEngineAddr);

    const baseOrderId = BigInt(Date.now());
    const maturity = BigInt((await ethers.provider.getBlockNumber()) + 7_200);
    const eligibleAmount = 1_000_000_000n; // 1000e6

    const userA = ethers.Wallet.createRandom().address;

    await (await rewardManager.connect(oe).onLoanEventByOrder(userA, baseOrderId, eligibleAmount, maturity, 0)).wait();
    const txLate1 = await rewardManager.connect(oe).onLoanEventByOrder(userA, baseOrderId, eligibleAmount, maturity, 3);
    const rcptLate1 = await txLate1.wait();

    const summary1 = await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userA);
    const pending1 = summary1[1] as bigint;
    const expectedPenalty = 5n * 10n ** 16n; // 1e18 * 5%
    assertOk(pending1 === expectedPenalty, `late penalty mismatch: got=${pending1.toString()}`);

    if (!hasDataPush(rcptLate1, rewardViewAddr, key("REWARD_PENALTY_LEDGER_UPDATED")) && strictDataPush) {
      throw new Error("missing DataPushed(REWARD_PENALTY_LEDGER_UPDATED) for late repay");
    }

    // Multi-order accumulates penalty ledger linearly.
    const order2 = baseOrderId + 1n;
    await (await rewardManager.connect(oe).onLoanEventByOrder(userA, order2, eligibleAmount, maturity, 0)).wait();
    await (await rewardManager.connect(oe).onLoanEventByOrder(userA, order2, eligibleAmount, maturity, 3)).wait();
    const summary2 = await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userA);
    const pending2 = summary2[1] as bigint;
    assertOk(pending2 === expectedPenalty * 2n, "multi-order penalty ledger mismatch");

    // Early full repay: no penalty.
    const userB = ethers.Wallet.createRandom().address;
    const order3 = baseOrderId + 2n;
    await (await rewardManager.connect(oe).onLoanEventByOrder(userB, order3, eligibleAmount, maturity, 0)).wait();
    await (await rewardManager.connect(oe).onLoanEventByOrder(userB, order3, eligibleAmount, maturity, 2)).wait();
    const summary3 = await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userB);
    assertOk(summary3[1] === 0n, "early repay should not increase penalty ledger");

    // Ineligible principal should not lock or penalize.
    const userC = ethers.Wallet.createRandom().address;
    const order4 = baseOrderId + 3n;
    const ineligibleAmount = 999_000_000n;
    await (await rewardManager.connect(oe).onLoanEventByOrder(userC, order4, ineligibleAmount, maturity, 0)).wait();
    await (await rewardManager.connect(oe).onLoanEventByOrder(userC, order4, ineligibleAmount, maturity, 3)).wait();
    const summary4 = await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userC);
    assertOk(summary4[1] === 0n, "ineligible principal should not update penalty ledger");

    // Idempotency: repay again should not change pending penalty.
    const before = (await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userA))[2] as bigint;
    await (await rewardManager.connect(oe).onLoanEventByOrder(userA, order2, eligibleAmount, maturity, 3)).wait();
    const after = (await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userA))[2] as bigint;
    assertOk(before === after, "replay repay should be ignored for the same orderId");

    // RewardViewPushFailed.reason decode (custom error selector) for EasyEmissionConfig
    if (easyEmissionConfigAddr && easyEmissionConfigAddr !== ethers.ZeroAddress) {
      const easyEmissionConfig = (await ethers.getContractAt("EasyEmissionConfig", easyEmissionConfigAddr)) as any;
      const originalEconf = easyEmissionConfigAddr;
      const wrong = ethers.Wallet.createRandom().address;

      await (await registry.connect(deployer).setModule(key("EASY_EMISSION_CONFIG"), wrong)).wait();

      const txBad = await easyEmissionConfig.connect(deployer).setEmissionParams(10n, 11n, 12n, 13n);
      const rcptBad = await txBad.wait();

      const failed = getRewardViewPushFailed(rcptBad, originalEconf);
      assertOk(failed.length === 1, "missing RewardViewPushFailed for EasyEmissionConfig");
      const selector = getErrorSelector(failed[0].reason as string);
      assertOk(selector === UNAUTHORIZED_WRITER_SELECTOR, "unexpected RewardViewPushFailed.reason selector");

      await (await registry.connect(deployer).setModule(key("EASY_EMISSION_CONFIG"), originalEconf)).wait();
    } else {
      console.log("  [Notice] EASY_EMISSION_CONFIG not bound; skip RewardViewPushFailed.reason check");
    }

    // Multiple DataPush in same tx: last payload wins
    const userD = ethers.Wallet.createRandom().address;
    const debt = 100n;

    await network.provider.send("hardhat_impersonateAccount", [rewardManagerCoreAddr]);
    await network.provider.send("hardhat_setBalance", [rewardManagerCoreAddr, "0x56BC75E2D63100000"]);
    const rmcSigner = await ethers.getSigner(rewardManagerCoreAddr);

    await (await rewardAccrualManager.connect(rmcSigner).applyLateRepayPenalty(userD, debt, rewardManagerCoreAddr)).wait();

    const BatchCallerF = await ethers.getContractFactory("MockRewardAccrualBatchCaller");
    const batchCaller = await BatchCallerF.deploy();
    await batchCaller.waitForDeployment();

    await (await registry.connect(deployer).setModule(key("REWARD_MANAGER_CORE"), await batchCaller.getAddress())).wait();

    const amount1 = 30n;
    const amount2 = 20n;
    const expectedRemaining = debt - amount1 - amount2;

    const txBatch = await batchCaller.offsetTwice(
      rewardAccrualManagerAddr,
      userD,
      amount1,
      amount2,
      "first",
      "second"
    );
    const rcptBatch = await txBatch.wait();

    const payloads = getDataPushPayloads(rcptBatch, rewardViewAddr, key("REWARD_PENALTY_LEDGER_UPDATED"));
    assertOk(payloads.length >= 2, "expected multiple penalty ledger pushes in one tx");

    const lastPayload = payloads[payloads.length - 1];
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], lastPayload);
    assertOk(decoded[0] === userD, "last penalty ledger payload user mismatch");
    assertOk(decoded[1] === expectedRemaining, "last penalty ledger payload debt mismatch");

    const summaryD = await rewardView.connect(deployer).getUserRewardSummaryWithMeta(userD);
    assertOk(summaryD[1] === expectedRemaining, "rewardView pendingPenalty mismatch after multi-push");

    await (await registry.connect(deployer).setModule(key("REWARD_MANAGER_CORE"), rewardManagerCoreAddr)).wait();

    console.log("\n✅ e2e-localhost-reward-edgecases PASSED\n");
  } finally {
    if (enableWrite) await network.provider.send("evm_revert", [snap]);
  }
}

async function main() {
  await runRewardEdgecases();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  main().catch((e) => {
    console.error("\n❌ e2e-localhost-reward-edgecases FAILED\n");
    console.error(e);
    process.exit(1);
  });
}
