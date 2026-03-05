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

async function ensurePriceForEmission(opts: {
  registry: any;
  assetAddr: string;
  decimals: number;
}) {
  const { registry, assetAddr, decimals } = opts;
  const oracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const oracle = (await ethers.getContractAt(
    [
      "function getPrice(address) view returns (uint256,uint256,uint256)",
      "function updatePrice(address,uint256,uint256)",
      "function setPrice(address,uint256,uint256,uint256)",
      "function configureAsset(address,string,uint256,uint256)",
      "function setAssetActive(address,bool)",
    ],
    oracleAddr
  )) as any;

  try {
    const [price] = (await oracle.getPrice(assetAddr)) as [bigint, bigint, bigint];
    if (price > 0n) return;
  } catch {
    // continue to best-effort write
  }

  const block = await ethers.provider.getBlockNumber();
  const priceUsd8 = 100_000_000n;

  try {
    await (await oracle.updatePrice(assetAddr, priceUsd8, BigInt(block))).wait();
    return;
  } catch {
    // ignore
  }

  try {
    await (await oracle.setPrice(assetAddr, priceUsd8, BigInt(block), BigInt(decimals))).wait();
    return;
  } catch {
    // ignore
  }
}

async function hasPriceForEmission(opts: { registry: any; assetAddr: string }): Promise<boolean> {
  const { registry, assetAddr } = opts;
  const oracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const oracle = (await ethers.getContractAt(
    ["function getPrice(address) view returns (uint256,uint256,uint256)", "function getPriceData(address) view returns (tuple(uint256 price,uint256 blockNumber,uint256 assetDecimals,bool isValid))"],
    oracleAddr
  )) as any;
  try {
    const [price] = (await oracle.getPrice(assetAddr)) as [bigint, bigint, bigint];
    return price > 0n;
  } catch {
    try {
      const data = (await oracle.getPriceData(assetAddr)) as { price: bigint; isValid: boolean };
      return !!data?.isValid && (data.price ?? 0n) > 0n;
    } catch {
      return false;
    }
  }
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

    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const rmAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const rvAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const gfmAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const lenderPoolAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
    const assetAddr = await resolveAssetAddr(registry);
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;

    const easyEmissionControllerAddr = (await registry.getModule(key("EASY_EMISSION_CONTROLLER"))) as string;
    const easyEmissionController =
      easyEmissionControllerAddr && easyEmissionControllerAddr !== ethers.ZeroAddress
        ? ((await ethers.getContractAt("EasyEmissionController", easyEmissionControllerAddr)) as any)
        : null;

    const rm = (await ethers.getContractAt("RewardManager", rmAddr)) as any;
    const rv = (await ethers.getContractAt("RewardView", rvAddr)) as any;
    const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;

    const ONE_EASY = 10n ** BigInt(await easyToken.decimals());

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

    const mintEasyViaEmission = async (opts: {
      borrowerAddr: string;
      orderId: number;
      amount: bigint;
      maturityBlock: number;
    }): Promise<any | null> => {
      if (!easyEmissionController) return null;
      await network.provider.send("hardhat_impersonateAccount", [rmAddr]);
      await network.provider.send("hardhat_setBalance", [rmAddr, "0x56BC75E2D63100000"]); // 100 ETH
      const rmSigner = await ethers.getSigner(rmAddr);
      const tx = await easyEmissionController
        .connect(rmSigner)
        .onLoanEventByOrderWithLender(
          opts.borrowerAddr,
          lenderPoolAddr,
          assetAddr,
          BigInt(opts.orderId),
          opts.amount,
          BigInt(opts.maturityBlock),
          1
        );
      return await tx.wait();
    };

    const eligibleAmount = ethers.parseUnits("1000", 6); // boundary: eligible
    const maturity = (await ethers.provider.getBlockNumber()) + 7_200; // +~1 day (block-based)

    const topUpEasyBalance = async (opts: {
      userAddr: string;
      minBalance: bigint;
      orderIdBase: number;
      maxRounds: number;
    }): Promise<boolean> => {
      for (let i = 0; i < opts.maxRounds; i++) {
        const balNow = (await easyToken.balanceOf(opts.userAddr)) as bigint;
        if (balNow >= opts.minBalance) return true;
        const orderId = opts.orderIdBase + i;
        await (await rm.connect(orderEngineSigner).onLoanEventByOrder(opts.userAddr, orderId, eligibleAmount, maturity, 0)).wait();
        await (await rm.connect(orderEngineSigner).onLoanEventByOrder(opts.userAddr, orderId, eligibleAmount, maturity, 1)).wait();
        await mintEasyViaEmission({
          borrowerAddr: opts.userAddr,
          orderId,
          amount: eligibleAmount,
          maturityBlock: maturity,
        });
      }
      const finalBal = (await easyToken.balanceOf(opts.userAddr)) as bigint;
      return finalBal >= opts.minBalance;
    };

    const user = await pickCleanUser(await ethers.getSigners(), easyToken, allowDirty);
    const bal0 = (await easyToken.balanceOf(user.address)) as bigint;
    const sum0 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const burned0 = sum0[1] as bigint;
    const penalty0 = sum0[2] as bigint;
    penalty0;
    const [easyEarned0] = (await rv.connect(user).getUserEasyEarnedWithMeta(user.address)) as [bigint, bigint, boolean];

    // ---- Earn main path (order-based): level multiplier + dynamic reward ----
    await ensurePriceForEmission({ registry, assetAddr, decimals: 6 });
    const priceAvailable = await hasPriceForEmission({ registry, assetAddr });
    const minterRole = ethers.id("MINTER_ROLE");
    let minterOk = false;
    if (easyEmissionControllerAddr && easyEmissionControllerAddr !== ethers.ZeroAddress) {
      try {
        minterOk = (await easyToken.hasRole(minterRole, easyEmissionControllerAddr)) as boolean;
      } catch {
        minterOk = false;
      }
    }
    const mintingAvailable = !!easyEmissionController && minterOk && priceAvailable;
    // Governance sets user level + earn params via SSOT path (RewardManager -> RewardConfig/EarnConfig).
    await (await rm.connect(deployer).updateUserLevel(user.address, 3)).wait();
    await (await rm.connect(deployer).setLevelMultiplier(3, 20_000)).wait(); // 2x
    await (await rm.connect(deployer).setDynamicRewardParams(ONE_EASY, 2_000)).wait(); // +20% when >= 1 Easy

    // Borrow(outcome=0): lock Easy for orderId.
    const orderIdEarn = Math.floor(Date.now() / 1000); // stable-ish and non-zero
    await (await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdEarn, eligibleAmount, maturity, 0)).wait();

    // Repay on-time full(outcome=1): mint Easy (amount depends on config + splits).
    const tx = await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdEarn, eligibleAmount, maturity, 1);
    const receipt = await tx.wait();

    let bal1 = (await easyToken.balanceOf(user.address)) as bigint;
    let mintReceipt: any = receipt;
    if (bal1 <= bal0 && easyEmissionController) {
      const fallbackReceipt = await mintEasyViaEmission({
        borrowerAddr: user.address,
        orderId: orderIdEarn,
        amount: eligibleAmount,
        maturityBlock: maturity,
      });
      if (fallbackReceipt) mintReceipt = fallbackReceipt;
      bal1 = (await easyToken.balanceOf(user.address)) as bigint;
    }

    const [easyEarned1] = (await rv.connect(user).getUserEasyEarnedWithMeta(user.address)) as [bigint, bigint, boolean];
    assertOk(easyEarned1 >= easyEarned0, "RewardView.easyEarned must be monotonic non-decreasing");

    if (bal1 > bal0) {
      const pushed = parseDataPushedTypeHashes(mintReceipt, rvAddr);
      const EASY_MINTED = key("EASY_MINTED").toLowerCase();
      if (!pushed.includes(EASY_MINTED)) {
        throw new Error("[Reward] EASY_MINTED DataPushed not observed; mint path may be miswired");
      }
    } else {
      const reason = !easyEmissionController
        ? "EASY_EMISSION_CONTROLLER missing"
        : !minterOk
        ? "EasyToken MINTER_ROLE not granted"
        : !priceAvailable
        ? "price unavailable"
        : "unknown";
      throw new Error(`[Reward] EasyToken balance did not increase; ${reason}`);
    }

    // ---- Late penalty scales with locked Easy (multiplier affects base) ----
    // Disable dynamic; keep 2x multiplier, set late penalty to 5%.
    await (await rm.connect(deployer).setDynamicRewardParams(0n, 0n)).wait();
    await (await rm.connect(deployer).setPenaltyBps(0, 500)).wait(); // 5%

    const orderIdLate = orderIdEarn + 1;
    await (await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdLate, eligibleAmount, maturity, 0)).wait(); // lock 2 Easy
    // Ensure "insufficient balance" deterministically by burning most of the user's Easy via GFM first (so late path records penalty debt).
    await network.provider.send("hardhat_impersonateAccount", [gfmAddr]);
    await network.provider.send("hardhat_setBalance", [gfmAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const gfmSigner = await ethers.getSigner(gfmAddr);
    const balBeforeLate = (await easyToken.balanceOf(user.address)) as bigint;
    if (balBeforeLate > 0n) {
      // burn to 0 (or close) so late burn fails and falls back to penaltyLedger.
      await (await rm.connect(gfmSigner).applyPenalty(user.address, balBeforeLate)).wait();
    }
    const sumLate0 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penaltyLate0 = sumLate0[2] as bigint;

    const txLate = await rm.connect(orderEngineSigner).onLoanEventByOrder(user.address, orderIdLate, eligibleAmount, maturity, 3);
    const rcptLate = await txLate.wait();
    const sumLate1 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penaltyLate1 = sumLate1[2] as bigint;
    const expectedPenalty = (ONE_EASY * 2n * 500n) / 10_000n; // 2 Easy * 5% = 0.1 Easy
    assertOk(penaltyLate1 - penaltyLate0 === expectedPenalty, "late penaltyLedger delta mismatch (expected 0.1 Easy for 2x)");
    const pushedLate = parseDataPushedTypeHashes(rcptLate, rvAddr);
    const PENALTY_LEDGER = key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase();
    assertOk(
      pushedLate.includes(PENALTY_LEDGER),
      "expected RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED) on late repay (insufficient balance)"
    );

    // ---- Penalty path: impersonate GFM and burn Easy ----
    // 1) burn exactly 1 Easy (should succeed)
    // NOTE: Under dirty state, user may already have >0 Easy; we only assert deltas.
    // Ensure user has at least 1 Easy to burn (late scenario above may have forced balance to 0).
    const balPreBurn = (await easyToken.balanceOf(user.address)) as bigint;
    if (balPreBurn < ONE_EASY) {
      // Mint via order flow until on-chain balance reaches >= 1 Easy.
      // NOTE: RewardManagerCore repays penalty ledger first, so one mint cycle may not fully reflect on balance.
      await (await rm.connect(deployer).updateUserLevel(user.address, 1)).wait();
      await (await rm.connect(deployer).setLevelMultiplier(1, 10_000)).wait(); // 1x
      await (await rm.connect(deployer).setDynamicRewardParams(0n, 0n)).wait(); // disable dynamic

      const ok = await topUpEasyBalance({
        userAddr: user.address,
        minBalance: ONE_EASY,
        orderIdBase: orderIdLate + 1000,
        maxRounds: 5,
      });
      if (!ok) {
        throw new Error("[Reward] cannot reach 1 Easy for burn test; mint path failed");
      }
    }

    const burnBal0 = (await easyToken.balanceOf(user.address)) as bigint;
    let burnBal1 = burnBal0;
    let burned2 = burned0;
    if (burnBal0 >= ONE_EASY) {
      const txBurn = await rm.connect(gfmSigner).applyPenalty(user.address, ONE_EASY);
      const rcptBurn = await txBurn.wait();
      burnBal1 = (await easyToken.balanceOf(user.address)) as bigint;
      const sum2 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
      burned2 = sum2[1] as bigint;
      assertOk(burnBal1 === burnBal0 - ONE_EASY, "expected burn to reduce balance by 1 Easy");
      assertOk(burned2 - burned0 >= ONE_EASY, "RewardView.totalBurned delta mismatch");
      const pushedBurn = parseDataPushedTypeHashes(rcptBurn, rvAddr);
      const REWARD_BURNED = key("REWARD_BURNED").toLowerCase();
      assertOk(pushedBurn.includes(REWARD_BURNED), "expected RewardView.DataPushed(REWARD_BURNED) on applyPenalty burn");
    } else {
      throw new Error("[Reward] insufficient Easy for applyPenalty burn test");
    }

    // 2) penalty ledger path (force insufficient balance deterministically, even on dirty chains)
    // Use amount > current balance so EasyToken.burn reverts and RMCore falls back to penalty ledger.
    const debtEasy = burnBal1 + ONE_EASY;
    const sumDebt0 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penaltyDebt0 = sumDebt0[2] as bigint;
    const txDebt = await rm.connect(gfmSigner).applyPenalty(user.address, debtEasy);
    const rcptDebt = await txDebt.wait();
    const sum3 = await rv.connect(user).getUserRewardSummaryWithMeta(user.address);
    const penalty3 = sum3[2] as bigint;
    assertOk(penalty3 - penaltyDebt0 === debtEasy, "expected penalty ledger to increase by debtEasy");
    const pushedDebt = parseDataPushedTypeHashes(rcptDebt, rvAddr);
    assertOk(
      pushedDebt.includes(PENALTY_LEDGER),
      "expected RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED) on applyPenalty debt"
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

        // Ensure user has enough Easy to spend even if penaltyLedger exists.
        const minSpendBal = ONE_EASY * 2n;
        await topUpEasyBalance({
          userAddr: user.address,
          minBalance: minSpendBal,
          orderIdBase: orderIdLate + 10_000,
          maxRounds: 30,
        });

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
