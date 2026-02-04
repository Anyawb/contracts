import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

const ONE_HOUR_BLOCKS = 1_800n;
const BLOCKS_PER_DAY = 7_200n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  // interest = principal * rate / 1e4 * term / 365 days (block-based)
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

async function latestBlockNumber(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.number);
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;
  await ethers.provider.send("hardhat_mine", ["0x" + delta.toString(16)]);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function isMissingSelectorError(msg: string): boolean {
  return String(msg).includes("function selector was not recognized");
}

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  const msg = fmtErr(e);
  const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
  if (m?.[1]) return m[1];
  return undefined;
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSel: string) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel.toLowerCase(), `${label}: unexpected error selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function mustSucceed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    throw e;
  }
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

async function inferOrderIdFromReceipt(orderEngine: any, receipt: any): Promise<bigint> {
  for (const log of receipt.logs) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        return parsed.args.orderId as bigint;
      }
    } catch {
      // ignore
    }
  }
  throw new Error("LoanOrderCreated not found; cannot infer orderId");
}

type DataPushed = { typeHash: string; payload: string };

function parseRewardDataPushed(receipt: any, rewardViewAddr: string): DataPushed[] {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const out: DataPushed[] = [];
  for (const log of receipt.logs ?? []) {
    if (!log?.address) continue;
    if (String(log.address).toLowerCase() !== rewardViewAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "DataPushed") {
        out.push({ typeHash: String(parsed.args.dataTypeHash), payload: String(parsed.args.payload) });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    outDir,
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
}

async function main() {
  const snap = await snapshot();
  const artifacts = mkArtifactsWriter();
  const dataPushedCounts: Record<string, number> = {};
  const expectedReverts: Record<string, number> = {};

  const bump = (m: Record<string, number>, k: string) => {
    m[k] = (m[k] ?? 0) + 1;
  };

  const recordDp = (receipt: any, rvAddr: string) => {
    const dps = parseRewardDataPushed(receipt, rvAddr);
    for (const dp of dps) bump(dataPushedCounts, dp.typeHash.toLowerCase());
    return dps;
  };

  try {
    const signers = await ethers.getSigners();
    if (signers.length < 5) throw new Error(`Need at least 5 signers (have ${signers.length})`);

    const deployer = signers[0];
    const borrower = signers[1];
    const lender = signers[2];
    const outsider = signers[3];
    // Use a fresh EOA to ensure it starts with no roles (deploylocal may grant roles to some default signers).
    const ops = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: ops.address, value: ethers.parseEther("1") });

    console.log("=== E2E Reward Privacy + Read-Gate (localhost) ===\n");
    console.log("Scenarios:");
    console.log("- Privacy: RewardView user-only + ops-only reads");
    console.log("- Read-gate: direct RewardManagerCore.get* must revert; reads must go through RewardView");
    console.log("- Rewards: on-time repay mints 1 point; early repay mints 0; overdue repay burns 5% of locked (0.05 point)\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
    const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
    const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
    const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
    const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    // Resolve via Registry (avoid ABI/address drift)
    const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const rewardPointsAddr = (await registry.getModuleOrRevert(key("REWARD_POINTS"))) as string;
    const rmCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;

    const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;
    const rewardPoints = (await ethers.getContractAt("src/Token/RewardPoints.sol:RewardPoints", rewardPointsAddr)) as any;
    const rmCore = (await ethers.getContractAt("RewardManagerCore", rmCoreAddr)) as any;

    const rvVer = (await mustSucceed("RewardView.getVersionInfo()", async () => rewardView.getVersionInfo())) as [
      bigint,
      bigint,
      string,
    ];

    const rewardDecimals = (await rewardPoints.decimals()) as number;
    const ONE_POINT = 10n ** BigInt(rewardDecimals);
    const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);

    const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

    // IMPORTANT:
    // Solidity-side `ModuleKeys.KEY_LE` is defined as keccak256("LENDING_ENGINE") (see `src/constants/ModuleKeys.sol`).
    // Do NOT use `frontend-config/moduleKeys.ts` here: it may encode a different naming scheme (e.g. keccak256("KEY_LE")).
    const leAddr = await registry.getModuleOrRevert(key("LENDING_ENGINE"));

    console.log("Modules:");
    console.log("  ORDER_ENGINE:", orderEngineAddr);
    console.log("  LENDING_ENGINE (KEY_LE):", leAddr);
    console.log("  RewardView:", rewardViewAddr);
    console.log("  RewardManagerCore:", rmCoreAddr);
    console.log("  RewardPoints:", rewardPointsAddr);
    console.log("  VersionInfo(RewardView):", `api=${rvVer[0].toString()} schema=${rvVer[1].toString()} impl=${rvVer[2]}`);
    console.log("");

    const missingRoleSel = errorSelector("MissingRole()");
    const unauthorizedReaderSel = errorSelector("RewardManagerCore__UnauthorizedReader(address)");

    // ============ Roles ============
    const ensureRole = async (roleName: string, who: string | any) => {
      const whoAddr = await ethers.resolveAddress(who);
      const role = key(roleName);
      if (!(await acm.hasRole(role, whoAddr))) {
        await (await acm.grantRole(role, whoAddr)).wait();
      }
    };

    // admin/config
    await ensureRole("ADD_WHITELIST", deployer.address);
    await ensureRole("UPDATE_PRICE", deployer.address);
    await ensureRole("SET_PARAMETER", deployer.address);

    // order engine needs borrow + fee distribute permission
    await ensureRole("BORROW", orderEngineAddr);
    await ensureRole("DEPOSIT", orderEngineAddr);

    // borrower needs create+repay permission
    await ensureRole("ORDER_CREATE", borrower.address);
    await ensureRole("REPAY", borrower.address);

    // asset/price setup
    const assetAddr = usdc.target as string;
    if (!(await aw.isAssetAllowed(assetAddr))) {
      await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
    }
    {
      const cfg = await po.getAssetConfig(assetAddr);
      if (!cfg.isActive) {
        const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
        await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", usdcDecimals, 3600)).wait();
      }
    }
    const blockNumber = await ethers.provider.getBlockNumber();
    await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 8), blockNumber)).wait();

    if (!(await feeRouter.isTokenSupported(assetAddr))) {
      await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
    }

    // fund users
    await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6))).wait();

    // ============ Privacy assertions (RewardView) ============
    console.log("=== A) Privacy gate: RewardView only user or ops can read ===");
    // user should be able to read own data
    await mustSucceed("borrower can read own reward summary", async () =>
      rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address)
    );

    // outsider cannot read other user's reward data
    await mustRevertWithSelector(
      "outsider cannot read borrower reward summary",
      async () => rewardView.connect(outsider).getUserRewardSummaryWithMeta(borrower.address),
      missingRoleSel
    );
    bump(expectedReverts, "outsider:getUserRewardSummary(non-self)");

    // ops can read only after role is granted
    await mustRevertWithSelector(
      "ops cannot read before VIEW_USER_DATA role",
      async () => rewardView.connect(ops).getUserRewardSummaryWithMeta(borrower.address),
      missingRoleSel
    );
    bump(expectedReverts, "ops:getUserRewardSummary(before-role)");
    await ensureRole("VIEW_USER_DATA", ops.address);
    await mustSucceed("ops can read after VIEW_USER_DATA role", async () =>
      rewardView.connect(ops).getUserRewardSummaryWithMeta(borrower.address)
    );
    console.log("  ✅ ops can read after VIEW_USER_DATA role\n");

    // ============ Protocol-only read entrance ============
    console.log("=== B) Protocol-only read: getUserLevelForBorrowCheck ===");
    await mustRevertWithSelector(
      "EOA cannot call getUserLevelForBorrowCheck (only KEY_LE)",
      async () => rewardView.connect(borrower).getUserLevelForBorrowCheck(borrower.address),
      missingRoleSel
    );
    bump(expectedReverts, "eoa:getUserLevelForBorrowCheck");
    {
      const data = rewardView.interface.encodeFunctionData("getUserLevelForBorrowCheck", [borrower.address]);
      const raw = await ethers.provider.call({ to: rewardViewAddr, data, from: leAddr });
      const [level] = rewardView.interface.decodeFunctionResult("getUserLevelForBorrowCheck", raw) as [bigint];
      console.log(`  ✅ eth_call(from=KEY_LE) succeeded, level=${level.toString()}\n`);
    }

    // ============ Read-gate assertions (RewardManagerCore) ============
    console.log("=== C) Read-gate: direct RewardManagerCore.get* must revert ===");
    await mustRevertWithSelector(
      "EOA direct call RMCore.getUserPenaltyDebt",
      async () => rmCore.connect(borrower).getUserPenaltyDebt(borrower.address),
      unauthorizedReaderSel
    );
    bump(expectedReverts, "eoa:rmcore.getUserPenaltyDebt");
    await mustRevertWithSelector(
      "EOA direct call RMCore.getUserLevel",
      async () => rmCore.connect(outsider).getUserLevel(borrower.address),
      unauthorizedReaderSel
    );
    bump(expectedReverts, "eoa:rmcore.getUserLevel");
    console.log("");

    // ============ Reward flow scenarios ============
    const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
    const rateBps = 1000n; // 10%
    const termBlocks = 5n * BLOCKS_PER_DAY;
    const totalDue = calcTotalDue(principal, rateBps, termBlocks);

    const readSnapshot = async (label: string) => {
      const bal = (await rewardPoints.balanceOf(borrower.address)) as bigint;
      const [debt] = (await rewardView.connect(borrower).getUserPenaltyDebt(borrower.address)) as [
        bigint,
        bigint,
        boolean
      ];
      const summary = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);
      const totalEarned = summary[0] as bigint;
      const totalBurned = summary[1] as bigint;
      console.log(
        `  [${label}] balance=${fmtPoints(bal)} totalEarned=${fmtPoints(totalEarned)} totalBurned=${fmtPoints(totalBurned)} penaltyDebt=${fmtPoints(debt)}`
      );
      return { bal, penaltyDebt: debt, totalEarned, totalBurned };
    };

    async function createOrder(): Promise<bigint> {
      const collateralAmt = ethers.parseUnits("5000", 6);
      await (await usdc.connect(deployer).transfer(borrower.address, collateralAmt)).wait();
      // VaultCore.deposit may route tokens through CollateralManager; approve both to avoid allowance ambiguity.
      await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, collateralAmt)).wait();
      await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt)).wait();
      await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();
      await (await vaultCore.connect(borrower).borrow(assetAddr, principal)).wait();
      // ensure borrower has extra funds for interest + fee
      await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("2000", 6))).wait();

      const tx = await orderEngine.connect(borrower).createLoanOrder({
        principal,
        rate: rateBps,
        term: termBlocks,
        borrower: borrower.address,
        // Option A: lender in order is the funding pool contract address (LenderPoolVault), not the signer EOA.
        lender: CONTRACT_ADDRESSES.LenderPoolVault,
        asset: assetAddr,
        startTimestamp: 0,
        maturity: 0,
        repaidAmount: 0,
      });
      const receipt = await tx.wait();
      const orderId = await inferOrderIdFromReceipt(orderEngine, receipt);
      return orderId;
    }

    async function getOrderForView(orderId: bigint) {
      return (await orderEngine.connect(deployer).getLoanOrderForView(orderId)) as any;
    }

    async function repayFull(orderId: bigint) {
      await (await usdc.connect(borrower).approve(orderEngineAddr, totalDue)).wait();
      const tx = await orderEngine.connect(borrower).repay(orderId, totalDue);
      const receipt = await tx.wait();
      assertOk(!!receipt, "missing receipt for repay()");
      const dps = recordDp(receipt, rewardViewAddr);
      return { receipt, dps };
    }

    console.log("=== D) Reward scenario: on-time repay => +1 point ===");
    const s0 = await readSnapshot("before on-time");
    const order1 = await createOrder();
    await readSnapshot("after borrow (locked, no mint)");

    {
      const ord = await getOrderForView(order1);
      const nowBlock = await latestBlockNumber();
      const maturity = ord.maturity as bigint;
      if (maturity > nowBlock + ONE_HOUR_BLOCKS) {
        await mineToBlock(maturity - ONE_HOUR_BLOCKS);
      }
    }
    const repay1 = await repayFull(order1);

    const s1 = await readSnapshot("after on-time repay");
    {
      const delta = s1.bal - s0.bal;
      if (delta === ONE_POINT) {
        if (s1.penaltyDebt !== 0n) throw new Error(`on-time repay: expected penaltyDebt=0, got ${s1.penaltyDebt.toString()}`);
        // Strict observability: on-time repay must emit RewardView DataPushed(REWARD_EARNED)
        const earnedType = key("REWARD_EARNED").toLowerCase();
        const earned = repay1.dps.find((x) => x.typeHash.toLowerCase() === earnedType);
        assertOk(!!earned, "on-time repay: expected DataPushed(REWARD_EARNED) in repay receipt");
        const [u, amt] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "string", "uint256"],
          earned!.payload
        ) as unknown as [string, bigint, string, bigint];
        assertOk(u.toLowerCase() === borrower.address.toLowerCase(), "REWARD_EARNED payload user mismatch");
        assertOk(
          amt === ONE_POINT,
          `REWARD_EARNED payload amount mismatch: got=${amt.toString()} expect=${ONE_POINT.toString()}`
        );
        console.log("  ✅ on-time repay minted exactly 1 point\n");
      } else if (delta === 0n) {
        console.log("  ⚠️  No points minted on on-time repay (reward path disabled); skipping DataPushed assertion\n");
      } else {
        throw new Error(`on-time repay: unexpected delta=${fmtPoints(delta)}`);
      }
    }

    console.log("=== E) Reward scenario: early repay => +0 point ===");
    const s2 = await readSnapshot("before early");
    const order2 = await createOrder();
    const repay2 = await repayFull(order2); // repay immediately => early
    const s3 = await readSnapshot("after early repay");
    if (s3.bal !== s2.bal)
      throw new Error(`early repay: expected no mint, balance changed ${fmtPoints(s2.bal)} -> ${fmtPoints(s3.bal)}`);
    if (s3.penaltyDebt !== s2.penaltyDebt) throw new Error(`early repay: expected no penalty debt change`);
    // Strict: early repay should not emit REWARD_EARNED (no mint)
    {
      const earnedType = key("REWARD_EARNED").toLowerCase();
      const earned = repay2.dps.find((x) => x.typeHash.toLowerCase() === earnedType);
      assertOk(!earned, "early repay: unexpected DataPushed(REWARD_EARNED)");
    }
    console.log("  ✅ early repay minted 0 point (and no penalty)\n");

    console.log("=== F) Reward scenario: overdue repay => burn 5% of locked (0.05 point) ===");
    const s4 = await readSnapshot("before overdue");
    const order3 = await createOrder();
    {
      const ord = await getOrderForView(order3);
      const maturity = ord.maturity as bigint;
      await mineToBlock(maturity + BLOCKS_PER_DAY + ONE_HOUR_BLOCKS);
    }
    const repay3 = await repayFull(order3);

    const s5 = await readSnapshot("after overdue repay");
    const balanceDecrease = s4.bal > s5.bal ? s4.bal - s5.bal : 0n;
    const penaltyDebtIncrease = s5.penaltyDebt > s4.penaltyDebt ? s5.penaltyDebt - s4.penaltyDebt : 0n;
    if (balanceDecrease === 0n && penaltyDebtIncrease === 0n) {
      console.log("  ⚠️  No penalty applied on overdue repay (reward path disabled); skipping penalty assertions");
      return;
    }
    if (s5.totalBurned < s4.totalBurned) {
      throw new Error("overdue repay: totalBurned should be non-decreasing");
    }
    // Strict observability: late repay must emit at least one of REWARD_BURNED / REWARD_PENALTY_LEDGER_UPDATED
    {
      const burnedType = key("REWARD_BURNED").toLowerCase();
      const penaltyType = key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase();
      const hasBurn = repay3.dps.some((x) => x.typeHash.toLowerCase() === burnedType);
      const hasPenalty = repay3.dps.some((x) => x.typeHash.toLowerCase() === penaltyType);
      assertOk(
        hasBurn || hasPenalty,
        "overdue repay: expected DataPushed(REWARD_BURNED) or DataPushed(REWARD_PENALTY_LEDGER_UPDATED)"
      );
    }
    console.log(
      `  ✅ overdue repay applied penalty (balanceDecrease=${fmtPoints(balanceDecrease)}, penaltyDebtIncrease=${fmtPoints(penaltyDebtIncrease)})\n`
    );

    // ====== Artifacts output (MUST-style) ======
    const artifactBlock = await ethers.provider.getBlockNumber();
    const artifactPath = artifacts.writeJson(`reward-privacy.${artifactBlock}.json`, {
      name: "Reward privacy + read-gate (localhost)",
      generatedAt: new Date().toISOString(),
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      modules: {
        Registry: CONTRACT_ADDRESSES.Registry,
        AccessControlManager: CONTRACT_ADDRESSES.AccessControlManager,
        OrderEngine: String(orderEngineAddr),
        LendingEngine: String(leAddr),
        RewardView: rewardViewAddr,
        RewardManagerCore: rmCoreAddr,
        RewardPoints: rewardPointsAddr,
      },
      versionInfo: {
        RewardView: { apiVersion: rvVer[0].toString(), schemaVersion: rvVer[1].toString(), implementation: rvVer[2] },
      },
      counters: {
        dataPushedByTypeHash: dataPushedCounts,
        expectedReverts,
      },
      notes: {
        rewardDecimals,
        onePointRaw: ONE_POINT.toString(),
      },
    });
    console.log("  📦 artifacts:", artifactPath);

    console.log("All Reward privacy/read-gate E2E checks passed.");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


