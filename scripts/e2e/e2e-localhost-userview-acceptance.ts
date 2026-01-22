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

async function mustRevert(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    console.log(`  ✅ [revert as expected] ${label}: ${msg}`);
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

    console.log("=== E2E UserView Acceptance (ARCH 4.7) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const userViewAddr = (await registry.getModuleOrRevert(key("USER_VIEW"))) as string;
    const userView = (await ethers.getContractAt("UserView", userViewAddr)) as any;

    const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
    const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;

    const healthViewAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
    const healthView = (await ethers.getContractAt("HealthView", healthViewAddr)) as any;

    const statsAddr = (await registry.getModuleOrRevert(key("VAULT_STATISTICS"))) as string;
    const stats = (await ethers.getContractAt("StatisticsView", statsAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  UserView:", userViewAddr);
    console.log("  PositionView:", positionViewAddr);
    console.log("  HealthView:", healthViewAddr);
    console.log("  StatisticsView:", statsAddr);

    // ====== MUST: UserView is a facade: no push* write entrypoints ======
    const pushFns = userView.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => String(f.name))
      .filter((n: string) => n.toLowerCase().startsWith("push"));
    assertOk(pushFns.length === 0, `UserView MUST NOT expose push* functions, found: ${pushFns.join(",")}`);

    // ====== MUST: totals MUST NOT use asset=0 placeholder ======
    // We seed StatisticsView directly, and require UserView totals to match it.
    const ROLE_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
    const ROLE_ADMIN = key("ACTION_ADMIN");
    if (!(await acm.hasRole(ROLE_ADMIN, deployer.address)) && !(await acm.hasRole(ROLE_VIEW_SYSTEM_DATA, deployer.address))) {
      await acm.connect(deployer).grantRole(ROLE_VIEW_SYSTEM_DATA, deployer.address);
    }

    const user = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: user.address, value: ethers.parseEther("5") });

    await mustSucceed("StatisticsView.pushUserStatsUpdate seed", async () =>
      stats.connect(deployer).pushUserStatsUpdate(user.address, 1000n, 0n, 500n, 0n)
    );
    const [snapU, verU, , , isValidU, tsU] = (await stats.getUserSnapshotWithMeta(user.address)) as [
      any,
      bigint,
      bigint,
      string,
      boolean,
      bigint,
    ];
    assertOk(isValidU === true && tsU > 0n, "seeded user snapshot should be valid");

    const [tc, td, tValid, tTs, tVer] = (await mustSucceed("UserView.getUserTotalsWithMeta", async () =>
      userView.getUserTotalsWithMeta(user.address)
    )) as [bigint, bigint, boolean, bigint, bigint, bigint];
    assertOk(tc === snapU.collateral && td === snapU.debt, "UserView totals must match StatisticsView snapshot");
    assertOk(tValid === isValidU && tTs === tsU, "UserView totals meta must match StatisticsView meta");
    // version is non-zero (strict push increments); if older deployment, this would fail earlier via selector checks.
    assertOk(tVer === verU, "UserView totals version must match StatisticsView version");

    // Legacy helpers must match totals (and must not be derived from asset=0 semantics)
    assertOk(
      (await mustSucceed("UserView.getUserTotalCollateral", async () => userView.getUserTotalCollateral(user.address))) === tc,
      "getUserTotalCollateral mismatch"
    );
    assertOk(
      (await mustSucceed("UserView.getUserTotalDebt", async () => userView.getUserTotalDebt(user.address))) === td,
      "getUserTotalDebt mismatch"
    );

    // ====== MUST: UserView aggregate output matches downstream views (value + meta passthrough) ======
    // Seed PositionView + HealthView directly via their accepted push paths and compare UserView aggregation.
    const vaultRouterAddr = (await vaultCore.viewContractAddrVar()) as string;
    const ACTION_VIEW_PUSH = key("ACTION_VIEW_PUSH");
    if (!(await acm.hasRole(ACTION_VIEW_PUSH, vaultRouterAddr))) {
      await acm.connect(deployer).grantRole(ACTION_VIEW_PUSH, vaultRouterAddr);
    }
    await network.provider.send("hardhat_impersonateAccount", [vaultRouterAddr]);
    await network.provider.send("hardhat_setBalance", [vaultRouterAddr, "0x56BC75E2D63100000"]);
    const vaultRouterSigner = await ethers.getSigner(vaultRouterAddr);

    const asset = CONTRACT_ADDRESSES.MockUSDC;
    // Ensure asset is whitelisted for deposit path (some localhost deploy configs keep whitelist empty).
    const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
    const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
    if (!(await acm.hasRole(ACTION_ADD_WHITELIST, deployer.address))) {
      await acm.connect(deployer).grantRole(ACTION_ADD_WHITELIST, deployer.address);
    }
    if (!(await aw.isAssetAllowed(asset))) {
      await aw.connect(deployer).addAllowedAsset(asset);
    }

    // Bring ledger to a consistent state first; PositionView rejects pushes that don't match ledger.
    const usdc = (await ethers.getContractAt("MockERC20", asset)) as any;
    const cmAddr = CONTRACT_ADDRESSES.CollateralManager;
    const depAmt = ethers.parseUnits("1000", 6);
    await usdc.connect(deployer).transfer(user.address, depAmt);
    await usdc.connect(user).approve(cmAddr, ethers.MaxUint256);
    await mustSucceed("VaultCore.deposit (ledger seed)", async () => vaultCore.connect(user).deposit(asset, depAmt));

    const req = ethers.id("uv-e2e-pos-req");
    const seq = 1n;
    const v0 = (await positionView.getPositionVersion(user.address, asset)) as bigint;
    const nextV = v0 === 0n ? 1n : v0 + 1n;
    await mustSucceed("PositionView.pushUserPositionUpdate seed", async () =>
      positionView
        .connect(vaultRouterSigner)
        ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](user.address, asset, depAmt, 0n, req, seq, nextV)
    );

    const vaultLeAddr = CONTRACT_ADDRESSES.VaultLendingEngine;
    if (!(await acm.hasRole(ACTION_VIEW_PUSH, vaultLeAddr))) {
      await acm.connect(deployer).grantRole(ACTION_VIEW_PUSH, vaultLeAddr);
    }
    await network.provider.send("hardhat_impersonateAccount", [vaultLeAddr]);
    await network.provider.send("hardhat_setBalance", [vaultLeAddr, "0x56BC75E2D63100000"]);
    const leSigner = await ethers.getSigner(vaultLeAddr);
    await mustSucceed("HealthView.pushRiskStatus seed", async () =>
      healthView.connect(leSigner).pushRiskStatus(user.address, 9500n, 10500n, true, 0)
    );

    // Downstream reads
    const [pc, pd, pValid, pTs, pVer2] = (await positionView.getUserPositionWithMeta(user.address, asset)) as [
      bigint,
      bigint,
      boolean,
      bigint,
      bigint,
    ];
    const [hf, hValid, hTs] = (await healthView.getUserHealthFactorWithMeta(user.address)) as [bigint, boolean, bigint];

    // UserView aggregation
    const [statsAgg, posValid2, posTs2, posVer3, healthValid2, healthTs2] = (await mustSucceed(
      "UserView.getUserStatsWithMeta",
      async () => userView.getUserStatsWithMeta(user.address, asset)
    )) as [any, boolean, bigint, bigint, boolean, bigint];

    assertOk(statsAgg.collateral === pc && statsAgg.debt === pd, "UserView stats must match PositionView values");
    assertOk(statsAgg.hf === hf, "UserView hf must match HealthView");
    assertOk(posValid2 === pValid && posTs2 === pTs && posVer3 === pVer2, "Position meta passthrough mismatch");
    assertOk(healthValid2 === hValid && healthTs2 === hTs, "Health meta passthrough mismatch");

    // TTL expiry: we check downstream flips and facade passthrough reflects it.
    await network.provider.send("evm_increaseTime", [5 * 60 + 1]);
    await network.provider.send("evm_mine", []);
    const [, , pValidExp] = (await positionView.getUserPositionWithMeta(user.address, asset)) as [
      bigint,
      bigint,
      boolean,
      bigint,
      bigint,
    ];
    const [, hValidExp] = (await healthView.getUserHealthFactorWithMeta(user.address)) as [bigint, boolean, bigint];
    const [, posValidExp2, , , healthValidExp2] = (await mustSucceed("UserView.getUserStatsWithMeta (expired)", async () =>
      userView.getUserStatsWithMeta(user.address, asset)
    )) as [any, boolean, bigint, bigint, boolean, bigint];
    assertOk(posValidExp2 === pValidExp, "UserView must passthrough expired PositionView isValid");
    assertOk(healthValidExp2 === hValidExp, "UserView must passthrough expired HealthView isValid");

    // Cleanup impersonation
    await network.provider.send("hardhat_stopImpersonatingAccount", [vaultRouterAddr]);
    await network.provider.send("hardhat_stopImpersonatingAccount", [vaultLeAddr]);

    console.log("\n✅ UserView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

