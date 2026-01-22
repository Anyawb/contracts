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
  // Typical ethers v6 message when calling a function that doesn't exist on-chain
  // (e.g. proxy points to old impl / wrong ABI).
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
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    console.log(`  ✅ [revert as expected] ${label}: ${msg}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const missingRoleSel = ethers.id("MissingRole()").slice(0, 10);
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const dataHex = extractRevertDataHex(e);
    const hay = `${msg} ${dataHex}`.trim();
    assertOk(
      hay.includes("MissingRole()") || hay.toLowerCase().includes(missingRoleSel.toLowerCase()),
      `[FAIL] ${label}: expected MissingRole(), got: ${hay}`
    );
    console.log(`  ✅ [revert MissingRole as expected] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected MissingRole() revert, but succeeded: ${label}`);
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

    console.log("=== E2E ViewCache Acceptance (ARCH 4.5) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const vcAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
    const vc = (await ethers.getContractAt("ViewCache", vcAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  ViewCache:", vcAddr);

    // Basic metadata sanity
    assertOk(
      (await mustSucceed("ViewCache.registryAddrVar()", async () => vc.registryAddrVar())) === CONTRACT_ADDRESSES.Registry,
      "ViewCache.registryAddrVar mismatch"
    );
    const [apiV, schemaV] = (await mustSucceed("ViewCache.getVersionInfo()", async () => vc.getVersionInfo())) as [
      bigint,
      bigint,
      string,
    ];
    // ViewCache expected baseline (see view-scan.ts)
    assertOk(apiV === 1n && schemaV === 1n, `ViewCache VersionInfo mismatch: api=${apiV} schema=${schemaV}`);

    // Use a real asset deployed by deploylocal for deterministic behavior + a second random asset to test independence.
    const assetA = CONTRACT_ADDRESSES.MockUSDC;
    const assetB = ethers.Wallet.createRandom().address;

    // ====== MUST: read returns timestamp/isValid (or equivalent) ======
    const [s0, v0] = (await mustSucceed("ViewCache.getSystemStatus(assetA)", async () => vc.getSystemStatus(assetA))) as [
      { timestamp: bigint },
      boolean,
    ];
    assertOk(typeof s0.timestamp === "bigint", "SystemStatusCache.timestamp must be a bigint");
    assertOk(v0 === false, "uncached system status must be invalid");
    assertOk(s0.timestamp === 0n, "uncached system status timestamp must be 0");

    // ====== MUST: write gated by system-data push/admin (unified role) ======
    // ViewCache uses ActionKeys.ACTION_VIEW_SYSTEM_DATA == keccak256("VIEW_SYSTEM_DATA")
    const ROLE_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
    const ROLE_ADMIN = key("ACTION_ADMIN");

    // Ensure deployer can write (either VIEW_SYSTEM_DATA or ADMIN).
    if (!(await acm.hasRole(ROLE_VIEW_SYSTEM_DATA, deployer.address)) && !(await acm.hasRole(ROLE_ADMIN, deployer.address))) {
      await acm.connect(deployer).grantRole(ROLE_VIEW_SYSTEM_DATA, deployer.address);
    }

    // Use a fresh random wallet to avoid "other signer already has roles" interference.
    const randomCaller = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: randomCaller.address, value: ethers.parseEther("1") });

    await mustRevertMissingRole("setSystemStatus from unauthorized signer", async () =>
      vc.connect(randomCaller).setSystemStatus(assetA, 1n, 2n, 3n)
    );

    // Invalid asset must revert
    await mustRevert("setSystemStatus with zero asset", async () =>
      vc.connect(deployer).setSystemStatus(ethers.ZeroAddress, 1n, 2n, 3n)
    );

    // ====== MUST: batch reads have shape + enforce size limits ======
    await mustRevert("batchGetSystemStatus empty", async () => vc.batchGetSystemStatus([]));
    const oversized = new Array(101).fill(assetA);
    await mustRevert("batchGetSystemStatus oversized", async () => vc.batchGetSystemStatus(oversized));

    // ====== MUST: successful write emits DataPushed + CacheUpdated and updates timestamp ======
    const DATA_TYPE_SYSTEM_STATUS = key("SYSTEM_STATUS_CACHE");
    const tx1 = await mustSucceed("setSystemStatus(assetA) tx", async () =>
      vc.connect(deployer).setSystemStatus(assetA, 111n, 222n, 333n)
    );
    const rc1 = await tx1.wait();
    assertOk(!!rc1, "missing receipt for setSystemStatus");

    const [s1, v1] = (await mustSucceed("ViewCache.getSystemStatus(assetA) after write", async () =>
      vc.getSystemStatus(assetA)
    )) as [
      { timestamp: bigint; totalCollateral: bigint; totalDebt: bigint; utilizationRate: bigint; isValid: boolean },
      boolean,
    ];
    assertOk(v1 === true, "after write, isValid must be true");
    assertOk(s1.timestamp > 0n, "after write, timestamp must be > 0");
    assertOk(s1.totalCollateral === 111n && s1.totalDebt === 222n && s1.utilizationRate === 333n, "stored values mismatch after write");
    assertOk(s1.isValid === true, "struct.isValid must be true after write");

    // CacheUpdated must be present.
    const cuTopic = vc.interface.getEvent("CacheUpdated").topicHash;
    const cuLogs1 = rc1.logs
      .filter((l: any) => l.address.toLowerCase() === vcAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === cuTopic);
    assertOk(cuLogs1.length >= 1, "expected CacheUpdated on successful setSystemStatus");

    // DataPushed payload must be decodable and type must match centralized constant.
    const dpTopic = vc.interface.getEvent("DataPushed").topicHash;
    const dpLogs = rc1.logs
      .filter((l: any) => l.address.toLowerCase() === vcAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs.length >= 1, "expected DataPushed on successful setSystemStatus");
    const parsed = vc.interface.parseLog({ topics: dpLogs[0].topics, data: dpLogs[0].data });
    assertOk(parsed.args[0] === DATA_TYPE_SYSTEM_STATUS, "unexpected dataTypeHash for system status");
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "uint256", "uint256", "uint256"],
      parsed.args[1]
    );
    assertOk((decoded[0] as string).toLowerCase() === assetA.toLowerCase(), "payload.asset mismatch");
    assertOk(decoded[1] === 111n && decoded[2] === 222n && decoded[3] === 333n, "payload fields mismatch");
    assertOk(decoded[4] === s1.timestamp, "payload.timestamp must equal stored timestamp");

    // ====== MUST: per-asset timestamps are independent (one asset write must not "refresh" the other) ======
    // Write assetB 2 minutes later, then cross the 5-min TTL boundary for assetA only.
    await network.provider.send("evm_increaseTime", [2 * 60]);
    await network.provider.send("evm_mine", []);
    const txB = await mustSucceed("setSystemStatus(assetB) tx", async () =>
      vc.connect(deployer).setSystemStatus(assetB, 444n, 555n, 666n)
    );
    const rcB = await txB.wait();
    assertOk(!!rcB, "missing receipt for setSystemStatus(assetB)");

    const [aAfterB, aValidAfterB] = (await mustSucceed("ViewCache.getSystemStatus(assetA) post assetB write", async () =>
      vc.getSystemStatus(assetA)
    )) as [{ timestamp: bigint }, boolean];
    const [b1, bValid1] = (await mustSucceed("ViewCache.getSystemStatus(assetB) post write", async () =>
      vc.getSystemStatus(assetB)
    )) as [
      { timestamp: bigint; totalCollateral: bigint; totalDebt: bigint; utilizationRate: bigint; isValid: boolean },
      boolean,
    ];
    assertOk(aValidAfterB === true, "assetA should still be valid at ~2m");
    assertOk(aAfterB.timestamp === s1.timestamp, "assetB write must not refresh assetA timestamp");
    assertOk(bValid1 === true && b1.timestamp > 0n, "assetB must be valid after write");

    await network.provider.send("evm_increaseTime", [4 * 60 + 2]); // now assetA age > 6m, assetB age ~4m
    await network.provider.send("evm_mine", []);
    const [aExp, aValidExp] = (await mustSucceed("ViewCache.getSystemStatus(assetA) expiry check", async () =>
      vc.getSystemStatus(assetA)
    )) as [{ timestamp: bigint; totalCollateral: bigint }, boolean];
    const [bOk, bValidOk] = (await mustSucceed("ViewCache.getSystemStatus(assetB) validity check", async () =>
      vc.getSystemStatus(assetB)
    )) as [{ timestamp: bigint; totalCollateral: bigint }, boolean];
    assertOk(aValidExp === false, "assetA should be expired after >5m");
    assertOk(aExp.timestamp === s1.timestamp && aExp.totalCollateral === 111n, "assetA expiry must keep stored value+timestamp");
    assertOk(bValidOk === true, "assetB should still be valid (<5m)");
    assertOk(bOk.totalCollateral === 444n, "assetB value mismatch");

    // ====== MUST: batch read returns validFlags aligned with single reads ======
    const [statuses, validFlags] = (await mustSucceed("ViewCache.batchGetSystemStatus([assetA,assetB])", async () =>
      vc.batchGetSystemStatus([assetA, assetB])
    )) as [
      Array<{ timestamp: bigint; totalCollateral: bigint; totalDebt: bigint; utilizationRate: bigint; isValid: boolean }>,
      boolean[],
    ];
    assertOk(statuses.length === 2 && validFlags.length === 2, "batch output length mismatch");
    assertOk(validFlags[0] === aValidExp, "batch validFlags[0] mismatch");
    assertOk(validFlags[1] === bValidOk, "batch validFlags[1] mismatch");
    assertOk(statuses[0].timestamp === aExp.timestamp && statuses[0].totalCollateral === aExp.totalCollateral, "batch status[0] mismatch");
    assertOk(statuses[1].timestamp === (b1 as any).timestamp && statuses[1].totalCollateral === bOk.totalCollateral, "batch status[1] mismatch");

    // ====== MUST: clearSystemCache is admin-gated and observable ======
    await mustRevertMissingRole("clearSystemCache from unauthorized signer", async () =>
      vc.connect(randomCaller).clearSystemCache(assetB)
    );
    const txClear = await mustSucceed("clearSystemCache(assetB) tx", async () => vc.connect(deployer).clearSystemCache(assetB));
    const rcClear = await txClear.wait();
    assertOk(!!rcClear, "missing receipt for clearSystemCache");

    // After clear: stored timestamp must be 0, isValid must be false
    const [bCleared, bClearedValid] = (await mustSucceed("ViewCache.getSystemStatus(assetB) after clear", async () =>
      vc.getSystemStatus(assetB)
    )) as [{ timestamp: bigint; totalCollateral: bigint }, boolean];
    assertOk(bCleared.timestamp === 0n && bCleared.totalCollateral === 0n, "clear should delete stored status");
    assertOk(bClearedValid === false, "after clear, isValid must be false");

    // CacheUpdated + DataPushed must exist for clear too (payload timestamp is tx timestamp, not stored timestamp=0)
    const cuLogsC = rcClear.logs
      .filter((l: any) => l.address.toLowerCase() === vcAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === cuTopic);
    assertOk(cuLogsC.length >= 1, "expected CacheUpdated on clearSystemCache");
    const dpLogsC = rcClear.logs
      .filter((l: any) => l.address.toLowerCase() === vcAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogsC.length >= 1, "expected DataPushed on clearSystemCache");
    const parsedC = vc.interface.parseLog({ topics: dpLogsC[0].topics, data: dpLogsC[0].data });
    assertOk(parsedC.args[0] === DATA_TYPE_SYSTEM_STATUS, "unexpected dataTypeHash for clear");
    const decodedC = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "uint256", "uint256", "uint256"],
      parsedC.args[1]
    );
    assertOk((decodedC[0] as string).toLowerCase() === assetB.toLowerCase(), "clear payload.asset mismatch");
    assertOk(decodedC[1] === 0n && decodedC[2] === 0n && decodedC[3] === 0n, "clear payload fields must be zero");

    console.log("\n✅ ViewCache acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

