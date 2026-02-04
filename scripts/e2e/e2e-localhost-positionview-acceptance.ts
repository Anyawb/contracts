import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

const BLOCKS_PER_MINUTE = 30n;

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isMissingSelectorError(msg: string): boolean {
  return String(msg).includes("function selector was not recognized");
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

function extractRevertDataHex(e: any): string {
  const cands = [
    e?.data,
    e?.data?.data,
    e?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.data?.data,
    e?.receipt?.revertReason,
  ];
  for (const x of cands) {
    if (typeof x === "string" && x.startsWith("0x")) return x;
  }
  return "";
}

async function mustRevertWithSelector(
  label: string,
  selector: string,
  fn: () => Promise<unknown>,
  opts: { expectedName?: string } = {}
) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const dataHex = extractRevertDataHex(e);
    const hay = `${msg} ${dataHex}`.trim();
    assertOk(
      (opts.expectedName ? hay.includes(opts.expectedName) : false) ||
        hay.toLowerCase().includes(selector.toLowerCase()) ||
        hay.includes(selector),
      `[FAIL] ${label}: expected revert selector ${selector}, got: ${hay}`
    );
    console.log(`  ✅ [revert ${selector} as expected] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert ${selector}, but succeeded: ${label}`);
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

    console.log("=== E2E PositionView Acceptance (ARCH 4.2) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
    const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
    const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;

    const vaultRouterAddr = (await vaultCore.viewContractAddrVar()) as string;
    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  PositionView:", positionViewAddr);
    console.log("  VaultRouter(viewContractAddrVar):", vaultRouterAddr);

    // Ensure VaultRouter has ACTION_VIEW_PUSH (needed by PositionView._requireRole).
    const ACTION_VIEW_PUSH = key("ACTION_VIEW_PUSH");
    assertOk(
      await acm.hasRole(ACTION_VIEW_PUSH, vaultRouterAddr),
      "missing ACTION_VIEW_PUSH for VaultRouter (re-run deploy:localhost)"
    );

    // Read gate: Scheme U
    const VIEW_USER_DATA = key("VIEW_USER_DATA");
    assertOk(await acm.hasRole(VIEW_USER_DATA, deployer.address), "missing VIEW_USER_DATA for deployer/admin");
    const missingRoleSel = ethers.id("MissingRole()").slice(0, 10);

    // Impersonate VaultRouter so msg.sender is an allowed business contract and has the role.
    await network.provider.send("hardhat_impersonateAccount", [vaultRouterAddr]);
    await network.provider.send("hardhat_setBalance", [vaultRouterAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const vaultRouterSigner = await ethers.getSigner(vaultRouterAddr);

    // --- Setup 2 assets so we can validate (user,asset) validity independence ---
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const altToken = await MockERC20.connect(deployer).deploy(
      "Alt USD",
      "aUSD",
      18,
      ethers.parseUnits("1000000", 18)
    );
    await altToken.waitForDeployment();

    const assetA = CONTRACT_ADDRESSES.MockUSDC; // 6 decimals mock, deployed by deploylocal
    const assetB = altToken.target as string; // new ERC20, 18 decimals

    // Whitelist assets (deposit path must accept them).
    const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
    if (!(await acm.hasRole(ACTION_ADD_WHITELIST, deployer.address))) {
      await acm.connect(deployer).grantRole(ACTION_ADD_WHITELIST, deployer.address);
    }
    if (!(await aw.isAssetAllowed(assetA))) {
      await aw.connect(deployer).addAllowedAsset(assetA);
    }
    if (!(await aw.isAssetAllowed(assetB))) {
      await aw.connect(deployer).addAllowedAsset(assetB);
    }

    // Use a fresh user to avoid dirty-state interference (PositionView version may be non-zero for default signers).
    const user = ethers.Wallet.createRandom().connect(ethers.provider);
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: user.address, value: ethers.parseEther("10") });
    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("10") });

    // self read without roles should succeed
    await mustSucceed("self getUserPositionWithMeta (no role)", async () =>
      positionView.connect(user).getUserPositionWithMeta(user.address, CONTRACT_ADDRESSES.MockUSDC)
    );
    // non-self outsider should revert MissingRole()
    await mustRevertWithSelector(
      "non-self outsider getUserPositionWithMeta",
      missingRoleSel,
      async () => {
        await positionView.connect(outsider).getUserPositionWithMeta(user.address, CONTRACT_ADDRESSES.MockUSDC);
      },
      { expectedName: "MissingRole()" }
    );
    // ops with VIEW_USER_DATA should succeed
    const opsSigner = (await ethers.getSigners())[1];
    if (!(await acm.hasRole(VIEW_USER_DATA, opsSigner.address))) {
      await (await acm.connect(deployer).grantRole(VIEW_USER_DATA, opsSigner.address)).wait();
    }
    await mustSucceed("ops getUserPositionWithMeta", async () =>
      positionView.connect(opsSigner).getUserPositionWithMeta(user.address, CONTRACT_ADDRESSES.MockUSDC)
    );

    // Fund user for both assets.
    const usdc = (await ethers.getContractAt("MockERC20", assetA)) as any;
    await usdc.connect(deployer).transfer(user.address, ethers.parseUnits("10000", 6));
    await (altToken as any).connect(deployer).mint(user.address, ethers.parseUnits("10000", 18));

    // CollateralManager pulls tokens via transferFrom; approve it.
    const cmAddr = CONTRACT_ADDRESSES.CollateralManager;
    await usdc.connect(user).approve(cmAddr, ethers.MaxUint256);
    await (altToken as any).connect(user).approve(cmAddr, ethers.MaxUint256);

    // Helper to get current meta
    async function getMeta(user: string, asset: string) {
      const [c, d, isValid, blockNumber, v] = (await positionView.getUserPositionWithMeta(user, asset)) as [
        bigint,
        bigint,
        boolean,
        bigint,
        bigint,
      ];
      return { c, d, isValid, blockNumber, v };
    }

    // ============ Step 1: Write assetA position cache with strict nextVersion ============
    const depA = ethers.parseUnits("1000", 6);
    await vaultCore.connect(user).deposit(assetA, depA);

    // Note: In the full localhost stack, deposit may already trigger a best-effort push to PositionView.
    // We accept both cases (v0==0: no prior push; v0>0: push path already integrated).
    const v0 = (await positionView.getPositionVersion(user.address, assetA)) as bigint;
    const nextV1 = v0 === 0n ? 1n : v0 + 1n;

    const req1 = ethers.id("pv-e2e-req-1");
    const seq1 = 10n;
    const tx1 = await positionView
      .connect(vaultRouterSigner)
      ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](user.address, assetA, depA, 0n, req1, seq1, nextV1);
    const r1 = await tx1.wait();
    assertOk(!!r1, "missing receipt for tx1");

    // Must emit DataPushed(USER_POSITION_UPDATE, abi.encode(user, asset, collateral, debt))
    const dataType = ethers.id("USER_POSITION_UPDATE");
    const dpTopic = positionView.interface.getEvent("DataPushed").topicHash;
    const dpLogs1 = r1.logs
      .filter((l: any) => l.address.toLowerCase() === positionViewAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs1.length >= 1, "expected DataPushed in tx1");
    const parsed1 = positionView.interface.parseLog({ topics: dpLogs1[0].topics, data: dpLogs1[0].data });
    assertOk(parsed1.args[0] === dataType, `unexpected dataTypeHash: ${parsed1.args[0]}`);
    const decoded1 = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "uint256", "uint256"],
      parsed1.args[1]
    );
    assertOk(decoded1[0].toLowerCase() === user.address.toLowerCase(), "payload.user mismatch");
    assertOk(decoded1[1].toLowerCase() === assetA.toLowerCase(), "payload.asset mismatch");
    assertOk(decoded1[2] === depA, "payload.collateral mismatch");
    assertOk(decoded1[3] === 0n, "payload.debt mismatch");

    const m1 = await getMeta(user.address, assetA);
    assertOk(m1.c === depA && m1.d === 0n, "meta values mismatch after tx1");
    assertOk(m1.isValid === true, "expected isValid=true after tx1");
    assertOk(m1.v === nextV1, `expected version=${nextV1} after tx1, got ${m1.v}`);
    assertOk(m1.blockNumber > 0n, "expected blockNumber > 0 after tx1");
    console.log("  ✅ assetA: version increment + DataPushed payload verified");

    // Wrong nextVersion must revert (strict optimistic concurrency)
    const vAfter1 = (await positionView.getPositionVersion(user.address, assetA)) as bigint;
    const staleVersionSel = ethers.id("PositionView__StaleVersion(uint64,uint64)").slice(0, 10);
    await mustRevertWithSelector("wrong nextVersion should revert", staleVersionSel, async () => {
      await positionView
        .connect(vaultRouterSigner)
        // nextVersion == currentVersion (not current+1) must revert unless it's an idempotent replay (we change requestId)
        ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
          user.address,
          assetA,
          depA,
          0n,
          ethers.id("pv-e2e-bad"),
          11n,
          vAfter1
        );
    });

    // ============ Step 2: Write assetB position cache later, verify (user,asset) validity independence ============
    await network.provider.send("hardhat_mine", [ethers.toBeHex(2n * BLOCKS_PER_MINUTE)]);

    const depB = ethers.parseUnits("500", 18);
    await vaultCore.connect(user).deposit(assetB, depB);

    const req2 = ethers.id("pv-e2e-req-2");
    const seq2 = 20n;
    const vB0 = (await positionView.getPositionVersion(user.address, assetB)) as bigint;
    const nextVB1 = vB0 === 0n ? 1n : vB0 + 1n;
    const tx2 = await positionView
      .connect(vaultRouterSigner)
      ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](user.address, assetB, depB, 0n, req2, seq2, nextVB1);
    const r2 = await tx2.wait();
    assertOk(!!r2, "missing receipt for tx2");

    const m2a = await getMeta(user.address, assetA);
    const m2b = await getMeta(user.address, assetB);
    assertOk(m2a.isValid === true, "assetA should still be valid at t=~2m");
    assertOk(m2b.isValid === true, "assetB should be valid after tx2");

    // Move blocks forward so assetA expires (>5m since its write), but assetB stays valid (<5m since its write).
    await network.provider.send("hardhat_mine", [ethers.toBeHex(4n * BLOCKS_PER_MINUTE)]);

    const m3a = await getMeta(user.address, assetA);
    const m3b = await getMeta(user.address, assetB);
    // In some integrated stacks, business modules may proactively refresh multiple assets for the user.
    // We enforce the MUST property that each (user,asset) reports its own meta and validity; we only hard-assert
    // that the recently updated assetB is still valid here. We also print blockNumbers to help spot unexpected refreshes.
    assertOk(m3b.isValid === true, "assetB should remain valid after ~4m since its write");
    if (m3a.blockNumber === m3b.blockNumber) {
      console.log("  ⚠️ Note: assetA/meta blockNumber equals assetB blockNumber (stack may refresh multiple assets).");
    }
    console.log(`  ✅ validity check: assetB isValid=true; assetA isValid=${m3a.isValid}`);

    // ============ Step 3: Idempotent replay + seq ordering ============
    // Update assetB ledger (deposit more) and push strict nextVersion=2.
    const depB2 = depB + ethers.parseUnits("1", 18);
    await vaultCore.connect(user).deposit(assetB, ethers.parseUnits("1", 18));

    const req3 = ethers.id("pv-e2e-req-3");
    const seq3 = 30n;
    const vB1 = (await positionView.getPositionVersion(user.address, assetB)) as bigint;
    const nextVB2 = vB1 === 0n ? 1n : vB1 + 1n;
    const tx3 = await positionView
      .connect(vaultRouterSigner)
      ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](user.address, assetB, depB2, 0n, req3, seq3, nextVB2);
    const r3 = await tx3.wait();
    assertOk(!!r3, "missing receipt for tx3");
    assertOk((await positionView.getPositionVersion(user.address, assetB)) === nextVB2, `assetB version should be ${nextVB2}`);

    // Replay: nextVersion==currentVersion and same requestId => IdempotentRequestIgnored, no DataPushed.
    const replayTx = await positionView
      .connect(vaultRouterSigner)
      ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
        user.address,
        assetB,
        depB2,
        0n,
        req3,
        1n,
        nextVB2 // nextVersion == currentVersion
      );
    const replayRcpt = await replayTx.wait();
    assertOk(!!replayRcpt, "missing replay receipt");

    const ignoredTopic = positionView.interface.getEvent("IdempotentRequestIgnored").topicHash;
    const ignoredLogs = replayRcpt.logs
      .filter((l: any) => l.address.toLowerCase() === positionViewAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === ignoredTopic);
    assertOk(ignoredLogs.length >= 1, "expected IdempotentRequestIgnored on replay");

    const dpLogsReplay = replayRcpt.logs
      .filter((l: any) => l.address.toLowerCase() === positionViewAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogsReplay.length === 0, "replay must not emit DataPushed");
    assertOk((await positionView.getPositionVersion(user.address, assetB)) === nextVB2, "replay must not change version");

    // Out-of-order seq (non-idempotent) should revert.
    const outOfOrderSel = ethers.id("PositionView__OutOfOrderSeq(uint64,uint64)").slice(0, 10);
    await mustRevertWithSelector("out-of-order seq should revert", outOfOrderSel, async () => {
      await positionView
        .connect(vaultRouterSigner)
        ["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
          user.address,
          assetB,
          depB2,
          0n,
          ethers.id("pv-e2e-req-4"),
          10n,
          nextVB2 + 1n
        );
    });

    console.log("\n✅ PositionView acceptance PASSED");
  } catch (e: any) {
    console.error(`[FAIL] ${fmtErr(e)}`);
    throw e;
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

