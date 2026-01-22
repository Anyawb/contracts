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
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
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

    console.log("=== E2E FeeRouterView Acceptance (ARCH 4.9) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;

    const frvAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER_VIEW"))) as string;
    const frv = (await ethers.getContractAt("FeeRouterView", frvAddr)) as any;

    const frAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  FeeRouterView:", frvAddr);
    console.log("  FeeRouter (SSOT writer):", frAddr);

    // ====== MUST: read exposes staleness/validity meta ======
    const [valid0, lastSync0, needsSync0] = (await mustSucceed("getSyncStatus()", async () => frv.getSyncStatus())) as [
      boolean,
      bigint,
      boolean,
    ];
    assertOk(lastSync0 >= 0n, "lastSyncTimestamp must be non-negative");
    assertOk(valid0 === (lastSync0 > 0n && !needsSync0), "isValid must be derived from lastSync/needsSync");

    // ====== MUST: non-FeeRouter caller cannot push ======
    const randomCaller = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: randomCaller.address, value: ethers.parseEther("1") });

    await mustRevert("pushGlobalStatsUpdate from non-FeeRouter", async () =>
      frv.connect(randomCaller).pushGlobalStatsUpdate(1n, 100n)
    );
    await mustRevert("pushUserFeeUpdate from non-FeeRouter", async () =>
      frv.connect(randomCaller).pushUserFeeUpdate(randomCaller.address, ethers.ZeroHash, 1n, 100n)
    );

    // ====== MUST: FeeRouter can push + DataPushed observable + lastSync updates ======
    await network.provider.send("hardhat_impersonateAccount", [frAddr]);
    await network.provider.send("hardhat_setBalance", [frAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const frSigner = await ethers.getSigner(frAddr);

    const DATA_TYPE_GLOBAL_FEE_STATS = key("GLOBAL_FEE_STATS");
    const dpTopic = frv.interface.getEvent("DataPushed").topicHash;

    const tx1 = await mustSucceed("FeeRouter.pushGlobalStatsUpdate", async () =>
      frv.connect(frSigner).pushGlobalStatsUpdate(5n, 500n)
    );
    const rc1 = await tx1.wait();
    assertOk(!!rc1, "missing receipt for pushGlobalStatsUpdate");

    const blk1 = await ethers.provider.getBlock(rc1.blockNumber);
    const expectedTs1 = BigInt(blk1!.timestamp);

    const [valid1, lastSync1, needsSync1] = (await frv.getSyncStatus()) as [boolean, bigint, boolean];
    assertOk(lastSync1 === expectedTs1, "lastSyncTimestamp must equal tx block.timestamp after push");
    assertOk(needsSync1 === false, "needsSync must be false immediately after push");
    assertOk(valid1 === true, "isValid must be true immediately after push");

    // DataPushed payload decode
    const dpLogs = rc1.logs
      .filter((l: any) => l.address.toLowerCase() === frvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs.length >= 1, "expected DataPushed on pushGlobalStatsUpdate");
    const parsed = frv.interface.parseLog({ topics: dpLogs[0].topics, data: dpLogs[0].data });
    assertOk(parsed.args[0] === DATA_TYPE_GLOBAL_FEE_STATS, "unexpected dataTypeHash for global fee stats");
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], parsed.args[1]);
    assertOk(decoded[0] === 5n && decoded[1] === 500n, "DataPushed payload mismatch for global fee stats");

    // ====== MUST: staleness logic consistent with SYNC_INTERVAL ======
    await network.provider.send("evm_increaseTime", [301]); // SYNC_INTERVAL=300
    await network.provider.send("evm_mine", []);
    const [validExp, lastSyncExp, needsSyncExp] = (await frv.getSyncStatus()) as [boolean, bigint, boolean];
    assertOk(lastSyncExp === lastSync1, "staleness check must not mutate lastSyncTimestamp");
    assertOk(needsSyncExp === true, "needsSync must be true after SYNC_INTERVAL elapsed");
    assertOk(validExp === false, "isValid must be false when needsSync is true");

    // ====== Optional read-path: user fee push updates user stats ======
    const userAddr = ethers.Wallet.createRandom().address;
    const feeType = ethers.id("SWAP");
    const tx2 = await mustSucceed("FeeRouter.pushUserFeeUpdate", async () =>
      frv.connect(frSigner).pushUserFeeUpdate(userAddr, feeType, 123n, 250n)
    );
    const rc2 = await tx2.wait();
    assertOk(!!rc2, "missing receipt for pushUserFeeUpdate");

    // Deployer should be admin on localhost; admin can read any user data.
    const stats = await mustSucceed("getUserStats (admin read)", async () => frv.connect(deployer).getUserStats(userAddr));
    assertOk(stats.totalFeePaid === 123n && stats.transactionCount === 1n, "user stats mismatch after pushUserFeeUpdate");

    await network.provider.send("hardhat_stopImpersonatingAccount", [frAddr]);

    console.log("\n✅ FeeRouterView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

