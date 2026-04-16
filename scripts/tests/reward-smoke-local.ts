import { ethers, network } from "hardhat";
import { key } from "./_fundsFlowUtils";
import { envBool as envBoolShared, loadAddressMap, resolveAddress } from "./_addressResolver";

function envBool(name: string, defaultValue = false): boolean {
  // Keep local override semantics, but reuse the shared env parsing.
  return envBoolShared(name, defaultValue);
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function isMissingSelectorError(msg: string): boolean {
  return String(msg).includes("function selector was not recognized");
}

function extractRevertData(e: any): string | undefined {
  // Prefer structured revert data (deep scan), then fallback to parsing error message.
  const roots: Array<unknown> = [
    e?.info?.error?.data,
    e?.info?.error?.data?.data,
    e?.info?.error?.error?.data,
    e?.info?.error?.error?.data?.data,
    e?.error?.data,
    e?.error?.data?.data,
    e?.error?.error?.data,
    e?.error?.error?.data?.data,
    e?.data,
    e?.data?.data,
    e?.receipt?.revertReason,
  ];
  const seen = new Set<unknown>();
  const stack = roots.map((v) => ({ v, depth: 0 }));
  while (stack.length) {
    const cur = stack.pop()!;
    if (!cur.v || seen.has(cur.v) || cur.depth > 4) continue;
    seen.add(cur.v);
    if (typeof cur.v === "string" && cur.v.startsWith("0x")) return cur.v;
    if (typeof cur.v === "object") {
      const obj: any = cur.v;
      for (const k of ["data", "result", "returnData", "reason", "error", "value"]) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          stack.push({ v: obj[k], depth: cur.depth + 1 });
        }
      }
    }
  }
  // Fallback: parse known "return data: 0x...." fragments.
  const msg = String(e?.message ?? e?.shortMessage ?? String(e));
  const m = msg.match(/return data:\s*(0x[0-9a-fA-F]+)/);
  if (m?.[1]) return m[1];
  const m2 = msg.match(/(0x[0-9a-fA-F]{8})\b/);
  if (m2?.[1]) return m2[1];
  return undefined;
}

async function supportsHardhatRpc(): Promise<boolean> {
  try {
    await ethers.provider.send("hardhat_metadata", []);
    return true;
  } catch {
    return false;
  }
}

function hexQuantity(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid hex quantity: ${n}`);
  return `0x${n.toString(16)}`;
}

async function mineBlocks(n: number) {
  // Hardhat JSON-RPC: hardhat_mine expects a hex quantity.
  try {
    await ethers.provider.send("hardhat_mine", [hexQuantity(n)]);
  } catch {
    // ignore on live networks (read-only paths should not rely on mining)
  }
}

async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const missingRoleSel = ethers.id("MissingRole()").slice(0, 10);
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(`[FAIL] ${label}: missing selector (ABI/deploy mismatch).`);
    }
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    assertOk(sel === missingRoleSel.toLowerCase() || msg.includes("MissingRole"), `[FAIL] ${label}: expected MissingRole()`);
    console.log(`  ✅ [revert MissingRole] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected MissingRole revert, but succeeded: ${label}`);
}

function parseDataPushedTypeHashes(receipt: any, rewardViewAddr?: string): string[] {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const topic0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
  const out: string[] = [];
  const logs = (receipt?.logs ?? []) as Array<{ address?: string; topics: string[]; data: string }>;
  for (const log of logs) {
    if (!log?.topics?.length) continue;
    if ((log.topics[0] ?? "").toLowerCase() !== topic0) continue;
    if (rewardViewAddr && (log.address ?? "").toLowerCase() !== rewardViewAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      out.push(((parsed?.args?.dataTypeHash as string) ?? "").toLowerCase());
    } catch {
      // ignore
    }
  }
  return out;
}

async function requireCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`[DeployCheck] ${label} has no code at ${address}`);
  }
}

async function pickCleanUser(signers: any[], easyToken: any, allowDirty: boolean) {
  for (const s of signers) {
    const bal = (await easyToken.balanceOf(s.address)) as bigint;
    if (bal === 0n) return s;
  }
  if (!allowDirty) {
    throw new Error("No clean signer found. Restart localhost node for a clean state, or set E2E_ALLOW_DIRTY_STATE=1.");
  }
  return signers[0];
}

async function resolveAssetAddr(registry: any): Promise<string> {
  const keys = ["SETTLEMENT_TOKEN", "MOCK_USDC", "USDC"];
  for (const k of keys) {
    try {
      const addr = (await registry.getModuleOrRevert(key(k))) as string;
      if (addr && addr !== ethers.ZeroAddress) return addr;
    } catch {
      // skip
    }
  }
  throw new Error("No settlement asset found (SETTLEMENT_TOKEN/MOCK_USDC/USDC). Check Registry bindings.");
}

async function main() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  // Avoid leaking state to other smoke steps by default.
  const KEEP_STATE = envBool("KEEP_STATE", false);
  const USE_SNAPSHOT = envBool("USE_SNAPSHOT", supportsHardhat && enableWrite && !KEEP_STATE);
  const snap = USE_SNAPSHOT ? ((await ethers.provider.send("evm_snapshot", [])) as string) : "";

  try {
    const allowDirty = envBool("E2E_ALLOW_DIRTY_STATE", false);
    const addressMap = loadAddressMap(network.name);
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

    if (readOnly || !enableWrite) {
      const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
      const rmAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
      const rvAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
      const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;
      const easyEmissionControllerAddr = (await registry.getModule(key("EASY_EMISSION_CONTROLLER"))) as string;
      const easyConsumptionAddr = (await registry.getModule(key("EASY_CONSUMPTION"))) as string;
      const easyRecycleDistributorAddr = (await registry.getModule(key("EASY_RECYCLE_DISTRIBUTOR"))) as string;

      await requireCode(registryAddr, "Registry");
      await requireCode(rmAddr, "RewardManager");
      await requireCode(rvAddr, "RewardView");
      await requireCode(easyTokenAddr, "EasyToken");
      if (easyEmissionControllerAddr && easyEmissionControllerAddr !== ethers.ZeroAddress) {
        await requireCode(easyEmissionControllerAddr, "EasyEmissionController");
      }
      if (easyConsumptionAddr && easyConsumptionAddr !== ethers.ZeroAddress) {
        await requireCode(easyConsumptionAddr, "EasyConsumption");
      }
      if (easyRecycleDistributorAddr && easyRecycleDistributorAddr !== ethers.ZeroAddress) {
        await requireCode(easyRecycleDistributorAddr, "EasyRecycleDistributor");
      }

      const rewardView = (await ethers.getContractAt(
        [
          "function getRegistry() view returns (address)",
          "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
          "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
          "function getDynamicRewardParamsWithMeta() view returns (uint256,uint256,uint256,bool)",
          "function getLevelMultiplierWithMeta(uint8 level) view returns (uint256,uint256,bool)",
        ],
        rvAddr
      )) as any;
      const easyToken = (await ethers.getContractAt(
        [
          "function decimals() view returns (uint8)",
          "function totalSupply() view returns (uint256)",
          "function balanceOf(address owner) view returns (uint256)",
          "function hasRole(bytes32 role, address account) view returns (bool)",
        ],
        easyTokenAddr
      )) as any;
      const recycleDistributor =
        easyRecycleDistributorAddr && easyRecycleDistributorAddr !== ethers.ZeroAddress
          ? ((await ethers.getContractAt(["function getRecipients() view returns (address,address)"], easyRecycleDistributorAddr)) as any)
          : null;

      const [viewer] = await ethers.getSigners();
      const MINTER_ROLE = ethers.id("MINTER_ROLE");

      console.log(`=== Reward smoke (${network.name}, read-only) ===`);
      console.log(`  Registry: ${registryAddr}`);
      console.log(`  RewardManager: ${rmAddr}`);
      console.log(`  RewardView: ${rvAddr}`);
      console.log(`  EasyToken: ${easyTokenAddr}`);
      if (easyEmissionControllerAddr && easyEmissionControllerAddr !== ethers.ZeroAddress) {
        console.log(`  EasyEmissionController: ${easyEmissionControllerAddr}`);
      }
      if (easyConsumptionAddr && easyConsumptionAddr !== ethers.ZeroAddress) {
        console.log(`  EasyConsumption: ${easyConsumptionAddr}`);
      }
      if (easyRecycleDistributorAddr && easyRecycleDistributorAddr !== ethers.ZeroAddress) {
        console.log(`  EasyRecycleDistributor: ${easyRecycleDistributorAddr}`);
      }

      const rewardViewRegistry = (await rewardView.getRegistry()) as string;
      assertOk(rewardViewRegistry.toLowerCase() === registryAddr.toLowerCase(), "RewardView registry mismatch");

      const rewardSummary = (await rewardView.getUserRewardSummaryWithMeta(viewer.address)) as [bigint, bigint, number, bigint, bigint, boolean];
      const easyEarnedMeta = (await rewardView.getUserEasyEarnedWithMeta(viewer.address)) as [bigint, bigint, boolean];
      const dynamicParams = (await rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
      const level1 = (await rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];
      let effectiveLevel1Multiplier = level1[0];
      if (effectiveLevel1Multiplier === 0n) {
        try {
          const earnConfigAddr = (await registry.getModuleOrRevert(key("REWARD_EARN_CONFIG"))) as string;
          const earnConfig = (await ethers.getContractAt("EarnConfig", earnConfigAddr)) as any;
          effectiveLevel1Multiplier = (await earnConfig.getLevelMultiplierBps(1)) as bigint;
          console.log(
            `  RewardEarnConfigFallback(L1): multiplierBps=${effectiveLevel1Multiplier.toString()} (RewardView cache invalid=${!level1[2]})`
          );
        } catch (e: any) {
          console.log(`  RewardEarnConfigFallback(L1) failed: ${fmtErr(e)}`);
        }
      }
      const easyDecimals = Number(await easyToken.decimals());
      const easySupply = (await easyToken.totalSupply()) as bigint;
      const viewerEasyBalance = (await easyToken.balanceOf(viewer.address)) as bigint;
      const emissionHasMinter =
        !!easyEmissionControllerAddr &&
        easyEmissionControllerAddr !== ethers.ZeroAddress &&
        ((await easyToken.hasRole(MINTER_ROLE, easyEmissionControllerAddr)) as boolean);

      console.log(`  Viewer: ${viewer.address}`);
      console.log(
        `  RewardSummary: burned=${rewardSummary[0].toString()} pendingPenalty=${rewardSummary[1].toString()} level=${rewardSummary[2]} cacheBlock=${rewardSummary[4].toString()} valid=${rewardSummary[5]}`
      );
      console.log(
        `  EasyEarnedMeta: earned=${easyEarnedMeta[0].toString()} cacheBlock=${easyEarnedMeta[1].toString()} valid=${easyEarnedMeta[2]}`
      );
      console.log(
        `  DynamicRewardParams: threshold=${dynamicParams[0].toString()} multiplierBps=${dynamicParams[1].toString()} cacheBlock=${dynamicParams[2].toString()} valid=${dynamicParams[3]}`
      );
      console.log(
        `  LevelMultiplier(L1): multiplierBps=${level1[0].toString()} cacheBlock=${level1[1].toString()} valid=${level1[2]}`
      );
      console.log(
        `  EasyToken: decimals=${easyDecimals} totalSupply=${easySupply.toString()} viewerBalance=${viewerEasyBalance.toString()}`
      );
      console.log(`  EmissionController has MINTER_ROLE: ${emissionHasMinter}`);

      assertOk(rewardSummary[0] >= 0n, "RewardView totalBurned read failed");
      assertOk(effectiveLevel1Multiplier > 0n, "Level 1 multiplier must be configured");
      assertOk(easySupply >= 0n, "EasyToken totalSupply read failed");

      if (recycleDistributor) {
        const [teamRecipient, ecoRecipient] = (await recycleDistributor.getRecipients()) as [string, string];
        assertOk(teamRecipient !== ethers.ZeroAddress, "EasyRecycleDistributor team recipient is zero");
        assertOk(ecoRecipient !== ethers.ZeroAddress, "EasyRecycleDistributor eco recipient is zero");
        console.log(`  EasyRecycleRecipients: team=${teamRecipient} eco=${ecoRecipient}`);
      }

      console.log("\n✅ reward-smoke-local (read-only) PASSED");
      return;
    }

    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const rmAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const rvAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const gfmAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const lenderPoolAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;

    const rm = (await ethers.getContractAt("RewardManager", rmAddr)) as any;
    const rv = (await ethers.getContractAt("RewardView", rvAddr)) as any;
    const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;

    const ONE_EASY = 10n ** BigInt(await easyToken.decimals());
    const MINTER_ROLE = ethers.id("MINTER_ROLE");

    const [deployer] = await ethers.getSigners();

    console.log(`=== Reward smoke (${network.name}) ===`);
    console.log(`  Registry: ${registryAddr}`);
    console.log(`  RewardManager: ${rmAddr}`);
    console.log(`  RewardView: ${rvAddr}`);
    console.log(`  EasyToken: ${easyTokenAddr}`);
    console.log(`  OrderEngine: ${orderEngineAddr}`);

    await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const orderEngineSigner = await ethers.getSigner(orderEngineAddr);

    const eligibleAmount = ethers.parseUnits("1000", 6); // boundary: eligible
    const maturity = (await ethers.provider.getBlockNumber()) + 7_200; // +~1 day (block-based)

    const ensureEasyBalance = async (opts: {
      userAddr: string;
      minBalance: bigint;
    }) => {
      const balNow = (await easyToken.balanceOf(opts.userAddr)) as bigint;
      if (balNow >= opts.minBalance) return balNow;

      const missing = opts.minBalance - balNow;
      const deployerIsMinter = (await easyToken.hasRole(MINTER_ROLE, deployer.address)) as boolean;
      if (!deployerIsMinter) {
        await (await easyToken.connect(deployer).grantRole(MINTER_ROLE, deployer.address)).wait();
      }

      await (await easyToken.connect(deployer).mint(opts.userAddr, missing)).wait();
      const finalBal = (await easyToken.balanceOf(opts.userAddr)) as bigint;
      assertOk(finalBal >= opts.minBalance, "[Reward] local Easy mint fallback did not reach requested balance");
      return finalBal;
    };

    const user = await pickCleanUser(await ethers.getSigners(), easyToken, allowDirty);
    const bal0 = (await easyToken.balanceOf(user.address)) as bigint;
    const sum0 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const burned0 = sum0[1] as bigint;
    const penalty0 = sum0[1] as bigint;
    penalty0;
    const [easyEarned0] = (await rv.connect(user).getUserEasyEarnedWithMeta(user.address)) as [bigint, bigint, boolean];

    // ---- Earn state path (order-based): config writes + lock/release must remain stable without price/emission ----
    await (await rm.connect(deployer).setLevelMultiplier(1, 10_000)).wait(); // baseline 1x for read-only smoke assumptions
    await (await rm.connect(deployer).updateUserLevel(user.address, 3)).wait();
    await (await rm.connect(deployer).setLevelMultiplier(3, 20_000)).wait(); // 2x
    await (await rm.connect(deployer).setDynamicRewardParams(ONE_EASY, 2_000)).wait(); // +20% when >= 1 Easy

    const orderIdEarn = Math.floor(Date.now() / 1000); // stable-ish and non-zero
    await (await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdEarn, eligibleAmount, maturity, 0)).wait();
    const tx = await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdEarn, eligibleAmount, maturity, 1);
    const receipt = await tx.wait();

    let bal1 = (await easyToken.balanceOf(user.address)) as bigint;
    const [easyEarned1] = (await rv.connect(user).getUserEasyEarnedWithMeta(user.address)) as [bigint, bigint, boolean];
    assertOk(easyEarned1 >= easyEarned0, "RewardView.easyEarned must be monotonic non-decreasing");

    if (bal1 > bal0) {
      const pushed = parseDataPushedTypeHashes(receipt, rvAddr);
      const EASY_MINTED = key("EASY_MINTED").toLowerCase();
      if (!pushed.includes(EASY_MINTED)) {
        throw new Error("[Reward] EASY_MINTED DataPushed not observed; mint path may be miswired");
      }
    } else {
      console.log("  ℹ️  earn mint assertion not enforced on localhost: smoke no longer depends on price/emission availability");
    }

    // ---- Late penalty scales with locked Easy (multiplier affects base) ----
    // Disable dynamic; keep 2x multiplier, set late penalty to 5%.
    await (await rm.connect(deployer).setDynamicRewardParams(0n, 0n)).wait();
    await (await rm.connect(deployer).setLatePenaltyBps(500)).wait(); // 5%

    const orderIdLate = orderIdEarn + 1;
    await (await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdLate, eligibleAmount, maturity, 0)).wait(); // lock 2 Easy
    // Ensure "insufficient balance" deterministically by burning most of the user's Easy via GFM first (so late path records penalty debt).
    await network.provider.send("hardhat_impersonateAccount", [gfmAddr]);
    await network.provider.send("hardhat_setBalance", [gfmAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const gfmSigner = await ethers.getSigner(gfmAddr);
    const balBeforeLate = (await easyToken.balanceOf(user.address)) as bigint;
    if (balBeforeLate > 0n) {
      // Drain balance directly so late burn fails deterministically and falls back to penaltyLedger.
      await (await easyToken.connect(user).transfer(deployer.address, balBeforeLate)).wait();
    }
    const sumLate0 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penaltyLate0 = sumLate0[1] as bigint;

    const txLate = await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdLate, eligibleAmount, maturity, 3);
    const rcptLate = await txLate.wait();
    const sumLate1 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penaltyLate1 = sumLate1[1] as bigint;
    const expectedPenalty = (ONE_EASY * 2n * 500n) / 10_000n; // 2 Easy * 5% = 0.1 Easy
    assertOk(penaltyLate1 - penaltyLate0 === expectedPenalty, "late penaltyLedger delta mismatch (expected 0.1 Easy for 2x)");
    const pushedLate = parseDataPushedTypeHashes(rcptLate, rvAddr);
    const PENALTY_LEDGER = key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase();
    assertOk(
      pushedLate.includes(PENALTY_LEDGER),
      "expected RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED) on late repay (insufficient balance)"
    );

    // ---- Liquidation penalty path: impersonate GFM and apply Reward-side penalty ----
    // Create a fresh borrow lock so liquidation penalty has a non-zero lockedEasy base.
    const orderIdPenalty = orderIdLate + 10_000;
    await (await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdPenalty, eligibleAmount, maturity, 0)).wait();

    const quotedPenalty = (await rm.quoteLiquidationPenalty(user.address)) as bigint;
    assertOk(quotedPenalty > 0n, "expected non-zero liquidation penalty quote");
    await ensureEasyBalance({ userAddr: user.address, minBalance: quotedPenalty });

    const burnBal0 = (await easyToken.balanceOf(user.address)) as bigint;
    let burnBal1 = burnBal0;
    let burned2 = burned0;
    if (burnBal0 >= quotedPenalty) {
      const txBurn = await rm.connect(gfmSigner).applyLiquidationPenalty(user.address);
      const rcptBurn = await txBurn.wait();
      burnBal1 = (await easyToken.balanceOf(user.address)) as bigint;
      const sum2 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
      burned2 = sum2[1] as bigint;
      assertOk(burnBal1 === burnBal0 - quotedPenalty, "expected burn to reduce balance by quoted liquidation penalty");
      assertOk(burned2 - burned0 >= quotedPenalty, "RewardView.totalBurned delta mismatch");
      const pushedBurn = parseDataPushedTypeHashes(rcptBurn, rvAddr);
      const REWARD_BURNED = key("REWARD_BURNED").toLowerCase();
      assertOk(pushedBurn.includes(REWARD_BURNED), "expected RewardView.DataPushed(REWARD_BURNED) on applyLiquidationPenalty burn");
    } else {
      throw new Error("[Reward] insufficient Easy for applyLiquidationPenalty burn test");
    }

    // 2) ledger-path: create a fresh lock, drain balance, then apply the newly quoted liquidation penalty.
    const orderIdPenaltyDebt = orderIdPenalty + 1;
    await (await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdPenaltyDebt, eligibleAmount, maturity, 0)).wait();
    if (burnBal1 > 0n) {
      await (await easyToken.connect(user).transfer(deployer.address, burnBal1)).wait();
    }
    const quotedPenaltyDebt = (await rm.quoteLiquidationPenalty(user.address)) as bigint;
    assertOk(quotedPenaltyDebt > 0n, "expected non-zero liquidation penalty quote for ledger path");
    const sumDebt0 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penaltyDebt0 = sumDebt0[1] as bigint;
    const txDebt = await rm.connect(gfmSigner).applyLiquidationPenalty(user.address);
    const rcptDebt = await txDebt.wait();
    const sum3 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penalty3 = sum3[1] as bigint;
    assertOk(penalty3 - penaltyDebt0 === quotedPenaltyDebt, "expected penalty ledger to increase by quoted liquidation penalty");
    const pushedDebt = parseDataPushedTypeHashes(rcptDebt, rvAddr);
    assertOk(
      pushedDebt.includes(PENALTY_LEDGER),
      "expected RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED) on applyLiquidationPenalty debt"
    );

    // Sanity: earned should not regress.
    const [easyEarnedEnd] = (await rv.connect(user).getUserEasyEarnedWithMeta(user.address)) as [bigint, bigint, boolean];
    assertOk(easyEarnedEnd >= easyEarned1, "easyEarned must be monotonic non-decreasing");
    // burned should be >= previous
    assertOk((sum3[1] as bigint) >= burned2, "burned must be monotonic non-decreasing");

    // ======================
    // EasyConsumption spend smoke (target-state)
    // ======================
    const RUN_EASY_CONSUMPTION_SMOKE = envBool("RUN_EASY_CONSUMPTION_SMOKE", true);
    if (RUN_EASY_CONSUMPTION_SMOKE) {
      console.log("\n=== EasyConsumption Spend Smoke ===");

      const econAddr = (await registry.getModule(key("EASY_CONSUMPTION"))) as string;
      const erdAddr = (await registry.getModule(key("EASY_RECYCLE_DISTRIBUTOR"))) as string;
      if (!econAddr || econAddr === ethers.ZeroAddress || !erdAddr || erdAddr === ethers.ZeroAddress) {
        console.log("  ⚠️  EASY_CONSUMPTION/EASY_RECYCLE_DISTRIBUTOR not bound; skipping spend smoke");
      } else {
        console.log(`EasyConsumption: ${econAddr}`);
        console.log(`EasyRecycleDistributor: ${erdAddr}`);

        const minSpendBal = ONE_EASY * 2n;
        await ensureEasyBalance({ userAddr: user.address, minBalance: minSpendBal });

        const bal0b = (await easyToken.balanceOf(user.address)) as bigint;
        if (bal0b < ONE_EASY) {
          throw new Error("[Reward] insufficient Easy for EasyConsumption spend smoke");
        }

        const econ = (await ethers.getContractAt("EasyConsumption", econAddr)) as any;
        await (await easyToken.connect(user).approve(econAddr, ONE_EASY)).wait();
        const tx2 = await econ.connect(user).consumeEasiMCall(user.address);
        const rcpt = await tx2.wait();
        const bal1b = (await easyToken.balanceOf(user.address)) as bigint;
        const delta = bal0b - bal1b;
        const erd = (await ethers.getContractAt("EasyRecycleDistributor", erdAddr)) as any;
        const [teamRecipient, ecoRecipient] = (await erd.getRecipients()) as [string, string];
        const teamAmount = (ONE_EASY * 15n) / 100n;
        const ecoAmount = ONE_EASY - ((ONE_EASY * 75n) / 100n) - teamAmount;
        let expectedDelta = ONE_EASY;
        if (teamRecipient.toLowerCase() === user.address.toLowerCase()) expectedDelta -= teamAmount;
        if (ecoRecipient.toLowerCase() === user.address.toLowerCase()) expectedDelta -= ecoAmount;
        assertOk(
          delta === expectedDelta,
          `EasyConsumption.consumeEasiMCall delta mismatch (bal0=${bal0b.toString()} bal1=${bal1b.toString()} delta=${delta.toString()} expected=${expectedDelta.toString()})`
        );

        const pushed = parseDataPushedTypeHashes(rcpt, rvAddr);
        assertOk(pushed.includes(key("EASY_SPENT").toLowerCase()), "expected DataPushed(EASY_SPENT) on consume");
        assertOk(
          pushed.includes(key("EASY_RECYCLED_SPLIT").toLowerCase()),
          "expected DataPushed(EASY_RECYCLED_SPLIT) on consume"
        );
        console.log("✅ EasyConsumption spend smoke ok (EASY_SPENT + EASY_RECYCLED_SPLIT)");
      }
    }

    console.log("\n✅ reward-smoke-local PASSED");
  } finally {
    if (USE_SNAPSHOT && !KEEP_STATE) {
      try {
        await network.provider.send("evm_revert", [snap]);
      } catch {
        // ignore on live networks
      }
    }
  }
}

main().catch((e) => {
  console.error("\n❌ reward-smoke-local FAILED\n");
  console.error(e);
  process.exitCode = 1;
});
