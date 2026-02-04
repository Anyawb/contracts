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
    if (isMissingSelectorError(String(msg))) {
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
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

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
    const expectedBlock1 = BigInt(blk1!.number);

    const [valid1, lastSync1, needsSync1] = (await frv.getSyncStatus()) as [boolean, bigint, boolean];
    assertOk(lastSync1 === expectedBlock1, "lastSyncBlock must equal tx block.number after push");
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

    // ====== MUST: staleness logic consistent with SYNC_INTERVAL (block-based) ======
    const syncInterval = (await frv.SYNC_INTERVAL_BLOCKS()) as bigint;
    const mineBlocks = Number(syncInterval + 1n);
    await network.provider.send("hardhat_mine", [ethers.toBeHex(mineBlocks)]);
    const [validExp, lastSyncExp, needsSyncExp] = (await frv.getSyncStatus()) as [boolean, bigint, boolean];
    assertOk(lastSyncExp === lastSync1, "staleness check must not mutate lastSyncTimestamp");
    assertOk(needsSyncExp === true, "needsSync must be true after SYNC_INTERVAL elapsed");
    assertOk(validExp === false, "isValid must be false when needsSync is true");

    // ====== Optional read-path: user fee push updates user stats ======
    const userSigner = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: userSigner.address, value: ethers.parseEther("1") });
    const userAddr = userSigner.address;
    const feeType = ethers.id("SWAP");
    const tx2 = await mustSucceed("FeeRouter.pushUserFeeUpdate", async () =>
      frv.connect(frSigner).pushUserFeeUpdate(userAddr, feeType, 123n, 250n)
    );
    const rc2 = await tx2.wait();
    assertOk(!!rc2, "missing receipt for pushUserFeeUpdate");

    // Scheme U: self-read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    const missingRoleSel = ethers.id("MissingRole()").slice(0, 10);
    const VIEW_USER_DATA = key("VIEW_USER_DATA");
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") });

    await mustSucceed("getUserStatsWithMeta (self read)", async () => frv.connect(userSigner).getUserStatsWithMeta(userAddr));
    await mustRevertWithSelector("getUserStatsWithMeta (outsider non-self)", missingRoleSel, async () =>
      frv.connect(outsider).getUserStatsWithMeta(userAddr)
    );

    const opsSigner = (await ethers.getSigners())[1];
    if (!(await acm.hasRole(VIEW_USER_DATA, opsSigner.address))) {
      await (await acm.connect(deployer).grantRole(VIEW_USER_DATA, opsSigner.address)).wait();
    }
    await mustSucceed("getUserStatsWithMeta (VIEW_USER_DATA read)", async () => frv.connect(opsSigner).getUserStatsWithMeta(userAddr));

    // Deployer should be admin on localhost; admin can read any user data.
    const [stats] = (await mustSucceed("getUserStatsWithMeta (admin read)", async () =>
      frv.connect(deployer).getUserStatsWithMeta(userAddr)
    )) as [any, bigint, boolean];
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

