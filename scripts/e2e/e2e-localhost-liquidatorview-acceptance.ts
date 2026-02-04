import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function isMissingSelectorError(msg: string): boolean {
  return msg.includes("function selector was not recognized");
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

function extractCustomErrorSigFromMessage(e: any): string | undefined {
  const msg = fmtErr(e);
  const m = String(msg).match(/custom error\s+'([^']+)'/);
  if (!m?.[1]) return undefined;
  const raw = m[1].trim();
  return raw.includes("(") ? raw : `${raw}()`;
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSel: string) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const data = extractRevertData(e);
    let sel: string | undefined;
    if (data && data.startsWith("0x") && data.length >= 10) {
      sel = data.slice(0, 10).toLowerCase();
    } else {
      const sig = extractCustomErrorSigFromMessage(e);
      if (sig) sel = errorSelector(sig).toLowerCase();
    }
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

async function main() {
  const snap = await snapshot();
  try {
    const [deployer] = await ethers.getSigners();

    console.log("=== E2E LiquidatorView Acceptance (ARCH 4.10) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    // Module addresses
    const liqViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
    const liqView = (await ethers.getContractAt("LiquidatorView", liqViewAddr)) as any;

    const liqMgrAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
    const payoutMgrAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  LiquidatorView:", liqViewAddr);
    console.log("  LiquidationManager (writer):", liqMgrAddr);
    console.log("  LiquidationPayoutManager (writer):", payoutMgrAddr);

    // ====== MUST: single-point push + strict writer gating ======
    const INVALID_CALLER_SEL = errorSelector("InvalidCaller()");
    const MISSING_ROLE_SEL = errorSelector("MissingRole()");

    const randomCaller = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: randomCaller.address, value: ethers.parseEther("1") });

    await mustRevertWithSelector(
      "pushLiquidationUpdate from non-business module",
      async () =>
        liqView
          .connect(randomCaller)
          .pushLiquidationUpdate(randomCaller.address, ethers.ZeroAddress, ethers.ZeroAddress, 0n, 0n, randomCaller.address, 0n, 0n),
      INVALID_CALLER_SEL
    );

    await mustRevertWithSelector(
      "pushBatchLiquidationUpdate from non-business module",
      async () =>
        liqView
          .connect(randomCaller)
          .pushBatchLiquidationUpdate([randomCaller.address], [ethers.ZeroAddress], [ethers.ZeroAddress], [0n], [0n], randomCaller.address, [0n], 0n),
      INVALID_CALLER_SEL
    );

    await mustRevertWithSelector(
      "pushLiquidationPayout from non-business module",
      async () =>
        liqView
          .connect(randomCaller)
          .pushLiquidationPayout(
            randomCaller.address,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            randomCaller.address,
            0n,
            0n,
            0n,
            0n,
            0n
          ),
      INVALID_CALLER_SEL
    );

    // Impersonate authorized writers
    await network.provider.send("hardhat_impersonateAccount", [liqMgrAddr]);
    await network.provider.send("hardhat_setBalance", [liqMgrAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const liqMgr = await ethers.getSigner(liqMgrAddr);

    await network.provider.send("hardhat_impersonateAccount", [payoutMgrAddr]);
    await network.provider.send("hardhat_setBalance", [payoutMgrAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const payoutMgr = await ethers.getSigner(payoutMgrAddr);

    const dpTopic = liqView.interface.getEvent("DataPushed").topicHash;

    // Push single liquidation update and assert DataPushed type/payload
    const now1 = BigInt((await ethers.provider.getBlock("latest"))!.number);
    const user1 = ethers.Wallet.createRandom().address;
    const coll1 = CONTRACT_ADDRESSES.MockUSDC;
    const debt1 = CONTRACT_ADDRESSES.MockUSDT ?? CONTRACT_ADDRESSES.MockUSDC; // fallback if USDT not present in config
    const liq1 = ethers.Wallet.createRandom().address;

    const tx1 = await mustSucceed("authorized pushLiquidationUpdate", async () =>
      liqView.connect(liqMgr).pushLiquidationUpdate(user1, coll1, debt1, 123n, 456n, liq1, 7n, BigInt(now1))
    );
    const rc1 = await tx1.wait();
    assertOk(!!rc1, "missing receipt (pushLiquidationUpdate)");

    const logs1 = rc1.logs
      .filter((l: any) => l.address.toLowerCase() === liqViewAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(logs1.length >= 1, "expected DataPushed on pushLiquidationUpdate");

    const parsed1 = liqView.interface.parseLog({ topics: logs1[0].topics, data: logs1[0].data });
    assertOk(parsed1.args[0] === key("LIQUIDATION_UPDATE"), "unexpected dataTypeHash for liquidation update");
    const dec1 = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
      parsed1.args[1]
    );
    assertOk(dec1[0] === user1, "payload.user mismatch");
    assertOk(dec1[1] === coll1, "payload.collateralAsset mismatch");
    assertOk(dec1[2] === debt1, "payload.debtAsset mismatch");
    assertOk(dec1[3] === 123n && dec1[4] === 456n, "payload.amount mismatch");
    assertOk(dec1[5] === liq1, "payload.liquidator mismatch");
    assertOk(dec1[6] === 7n, "payload.bonus mismatch");
    assertOk(dec1[7] === now1, "payload.blockNumber mismatch");

    // Push payout update via payout manager and assert DataPushed type/payload
    const now2 = BigInt((await ethers.provider.getBlock("latest"))!.number);
    const tx2 = await mustSucceed("authorized pushLiquidationPayout (payout manager)", async () =>
      liqView
        .connect(payoutMgr)
        .pushLiquidationPayout(user1, coll1, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, liq1, 1n, 2n, 3n, 4n, BigInt(now2))
    );
    const rc2 = await tx2.wait();
    assertOk(!!rc2, "missing receipt (pushLiquidationPayout)");
    const logs2 = rc2.logs
      .filter((l: any) => l.address.toLowerCase() === liqViewAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(logs2.length >= 1, "expected DataPushed on pushLiquidationPayout");
    const parsed2 = liqView.interface.parseLog({ topics: logs2[0].topics, data: logs2[0].data });
    assertOk(parsed2.args[0] === key("LIQUIDATION_PAYOUT"), "unexpected dataTypeHash for liquidation payout");

    // ====== MUST: permissions not mixed (system vs risk vs user vs liquidation) ======
    // System-only read should succeed with VIEW_SYSTEM_DATA (already present from preflight)
    await mustSucceed("system read: getGlobalLiquidationView", async () => liqView.connect(deployer).getGlobalLiquidationView());

    // Risk read MUST require VIEW_RISK_DATA (not system)
    const ROLE_VIEW_RISK_DATA = key("VIEW_RISK_DATA");
    const hasRisk = (await acm.hasRole(ROLE_VIEW_RISK_DATA, deployer.address)) as boolean;
    if (!hasRisk) {
      await mustRevertWithSelector(
        "risk read without VIEW_RISK_DATA",
        async () => liqView.connect(deployer).getLiquidatorRiskAnalysis(ethers.ZeroAddress),
        MISSING_ROLE_SEL
      );
      await mustSucceed("grant VIEW_RISK_DATA to deployer", async () => acm.grantRole(ROLE_VIEW_RISK_DATA, deployer.address));
    }
    await mustSucceed("risk read with VIEW_RISK_DATA", async () => liqView.connect(deployer).getLiquidatorRiskAnalysis(ethers.ZeroAddress));

    // User-private read: requires VIEW_USER_DATA + (self or admin)
    const ROLE_VIEW_USER_DATA = key("VIEW_USER_DATA");
    const userSigner = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: userSigner.address, value: ethers.parseEther("1") });

    // Scheme U: self-read is allowed without VIEW_USER_DATA.
    await mustSucceed("user read (self) without VIEW_USER_DATA (Scheme U self-bypass)", async () =>
      liqView.connect(userSigner).getSeizableCollateralAmount(userSigner.address, CONTRACT_ADDRESSES.MockUSDC)
    );

    // Non-self read without admin should revert (MissingRole)
    await mustRevertWithSelector(
      "user read (non-self) without admin",
      async () => liqView.connect(userSigner).getSeizableCollateralAmount(deployer.address, CONTRACT_ADDRESSES.MockUSDC),
      MISSING_ROLE_SEL
    );

    // With VIEW_USER_DATA, a caller can read other users' user-dimensional data.
    const hadUserRole = (await acm.hasRole(ROLE_VIEW_USER_DATA, userSigner.address)) as boolean;
    if (!hadUserRole) {
      await mustSucceed("grant VIEW_USER_DATA to user", async () => acm.grantRole(ROLE_VIEW_USER_DATA, userSigner.address));
    }
    await mustSucceed("user read (non-self) with VIEW_USER_DATA", async () =>
      liqView.connect(userSigner).getSeizableCollateralAmount(deployer.address, CONTRACT_ADDRESSES.MockUSDC)
    );

    // Liquidation read requires VIEW_LIQUIDATION_DATA (not system/user)
    const ROLE_VIEW_LIQUIDATION_DATA = key("VIEW_LIQUIDATION_DATA");
    const hasLiq = (await acm.hasRole(ROLE_VIEW_LIQUIDATION_DATA, deployer.address)) as boolean;
    if (!hasLiq) {
      await mustRevertWithSelector(
        "liquidation read without VIEW_LIQUIDATION_DATA",
        async () => liqView.connect(deployer).calculateCollateralValue(CONTRACT_ADDRESSES.MockUSDC, 1n),
        MISSING_ROLE_SEL
      );
      await mustSucceed("grant VIEW_LIQUIDATION_DATA to deployer", async () => acm.grantRole(ROLE_VIEW_LIQUIDATION_DATA, deployer.address));
    }
    await mustSucceed("liquidation read with VIEW_LIQUIDATION_DATA", async () =>
      liqView.connect(deployer).calculateCollateralValue(CONTRACT_ADDRESSES.MockUSDC, 1n)
    );

    // ====== MUST: “freshness fields exist” for off-chain aggregated outputs ======
    // Placeholders should be internally consistent: lastLiquidationTime==0 => daysSinceLastLiquidation==0
    const pv = await mustSucceed("getLiquidatorProfitView", async () => liqView.connect(deployer).getLiquidatorProfitView(liq1));
    assertOk(pv.lastLiquidationTime === 0n, "placeholder lastLiquidationTime expected 0");
    assertOk(pv.daysSinceLastLiquidation === 0n, "daysSinceLastLiquidation must be 0 when lastLiquidationTime==0");

    await network.provider.send("hardhat_stopImpersonatingAccount", [liqMgrAddr]);
    await network.provider.send("hardhat_stopImpersonatingAccount", [payoutMgrAddr]);

    console.log("\n✅ LiquidatorView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

