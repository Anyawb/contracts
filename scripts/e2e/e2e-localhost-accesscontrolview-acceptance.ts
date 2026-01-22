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

    console.log("=== E2E AccessControlView Acceptance (ARCH 4.6) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    // Resolve AccessControlView via Registry (SSOT).
    const acvAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_VIEW"))) as string;
    const acv = (await ethers.getContractAt("AccessControlView", acvAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  AccessControlView:", acvAddr);

    // ====== VersionInfo + Registry sanity ======
    assertOk(
      (await mustSucceed("AccessControlView.registryAddr()", async () => acv.registryAddr())) === CONTRACT_ADDRESSES.Registry,
      "AccessControlView.registryAddr mismatch"
    );
    const [apiV, schemaV] = (await mustSucceed("AccessControlView.getVersionInfo()", async () => acv.getVersionInfo())) as [
      bigint,
      bigint,
      string,
    ];
    assertOk(apiV === 1n && schemaV === 1n, `AccessControlView VersionInfo mismatch: api=${apiV} schema=${schemaV}`);

    // ====== Resolve ACM address (must match contracts-localhost) ======
    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    assertOk(
      acmAddr.toLowerCase() === CONTRACT_ADDRESSES.AccessControlManager.toLowerCase(),
      "Registry ACM address mismatch (deployments out of sync)"
    );
    console.log("  AccessControlManager:", acmAddr);

    // ====== Prepare a clean user ======
    const user = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: user.address, value: ethers.parseEther("1") });

    const actionKey = key("VIEW_USER_DATA");

    // ====== MUST: read returns isValid/timestamp (or at least isValid) ======
    const [p0, valid0, ts0] = (await mustSucceed("getUserPermissionWithMeta (empty)", async () =>
      acv.connect(user).getUserPermissionWithMeta(user.address, actionKey)
    )) as [boolean, boolean, bigint];
    assertOk(p0 === false, "empty cache should return hasPermission=false");
    assertOk(valid0 === false, "empty cache should be invalid");
    assertOk(ts0 === 0n, "empty cache timestamp must be 0");

    // ====== MUST: only ACM can push ======
    await mustRevert("pushPermissionUpdate from EOA must revert (onlyACM)", async () =>
      acv.connect(user).pushPermissionUpdate(user.address, actionKey, true)
    );
    await mustRevert("pushPermissionLevelUpdate from EOA must revert (onlyACM)", async () =>
      acv.connect(user).pushPermissionLevelUpdate(user.address, 2)
    );

    // Impersonate ACM so msg.sender == ACM.
    await network.provider.send("hardhat_impersonateAccount", [acmAddr]);
    await network.provider.send("hardhat_setBalance", [acmAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const acmSigner = await ethers.getSigner(acmAddr);

    // ====== MUST: push emits DataPushed with correct type & payload ======
    const DATA_TYPE_BIT = key("PERMISSION_BIT_UPDATE");
    const dpTopic = acv.interface.getEvent("DataPushed").topicHash;
    const legacyBitTopic = acv.interface.getEvent("PermissionDataUpdated").topicHash;

    const tx1 = await mustSucceed("ACM.pushPermissionUpdate tx", async () =>
      acv.connect(acmSigner).pushPermissionUpdate(user.address, actionKey, true)
    );
    const rc1 = await tx1.wait();
    assertOk(!!rc1, "missing receipt for pushPermissionUpdate");

    const blk1 = await ethers.provider.getBlock(rc1.blockNumber);
    const expectedTs1 = BigInt(blk1!.timestamp);

    // Legacy event must be present and timestamp must match tx block.timestamp
    const legacyBitLogs = rc1.logs
      .filter((l: any) => l.address.toLowerCase() === acvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === legacyBitTopic);
    assertOk(legacyBitLogs.length >= 1, "expected PermissionDataUpdated");
    const legacyParsed = acv.interface.parseLog({ topics: legacyBitLogs[0].topics, data: legacyBitLogs[0].data });
    assertOk((legacyParsed.args[0] as string).toLowerCase() === user.address.toLowerCase(), "legacy user mismatch");
    assertOk((legacyParsed.args[1] as string).toLowerCase() === actionKey.toLowerCase(), "legacy actionKey mismatch");
    assertOk(legacyParsed.args[2] === true, "legacy hasPermission mismatch");
    assertOk(BigInt(legacyParsed.args[3]) === expectedTs1, "legacy timestamp must equal tx block.timestamp");

    const dpLogs1 = rc1.logs
      .filter((l: any) => l.address.toLowerCase() === acvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs1.length >= 1, "expected DataPushed for permission bit update");
    const parsed1 = acv.interface.parseLog({ topics: dpLogs1[0].topics, data: dpLogs1[0].data });
    assertOk(parsed1.args[0] === DATA_TYPE_BIT, "unexpected dataTypeHash for permission bit update");

    const decoded1 = ethers.AbiCoder.defaultAbiCoder().decode(["address", "bytes32", "bool"], parsed1.args[1]);
    assertOk((decoded1[0] as string).toLowerCase() === user.address.toLowerCase(), "payload.user mismatch");
    assertOk((decoded1[1] as string).toLowerCase() === actionKey.toLowerCase(), "payload.actionKey mismatch");
    assertOk(decoded1[2] === true, "payload.hasPermission mismatch");

    // ====== MUST: push then immediate read, isValid correct ======
    const [p1, valid1, ts1] = (await mustSucceed("getUserPermissionWithMeta (after push)", async () =>
      acv.connect(user).getUserPermissionWithMeta(user.address, actionKey)
    )) as [boolean, boolean, bigint];
    assertOk(p1 === true, "after push, hasPermission must be true");
    assertOk(valid1 === true, "after push, isValid must be true");
    assertOk(ts1 === expectedTs1, "timestamp must equal tx block.timestamp");

    // TTL expiry (ViewConstants.CACHE_DURATION = 5min)
    await network.provider.send("evm_increaseTime", [5 * 60 + 1]);
    await network.provider.send("evm_mine", []);

    const [pExp, validExp, tsExp] = (await mustSucceed("getUserPermissionWithMeta (expired)", async () =>
      acv.connect(user).getUserPermissionWithMeta(user.address, actionKey)
    )) as [boolean, boolean, bigint];
    assertOk(pExp === true, "expired cache must keep stored permission value");
    assertOk(validExp === false, "expired cache must have isValid=false");
    assertOk(tsExp === ts1, "expired cache must keep original timestamp");

    // ====== Permission level update path ======
    const DATA_TYPE_LEVEL = key("PERMISSION_LEVEL_UPDATE");
    const legacyLevelTopic = acv.interface.getEvent("PermissionLevelUpdated").topicHash;
    const newLevel = 2; // OPERATOR-like; exact enum mapping is ACM-dependent but should round-trip

    const tx2 = await mustSucceed("ACM.pushPermissionLevelUpdate tx", async () =>
      acv.connect(acmSigner).pushPermissionLevelUpdate(user.address, newLevel)
    );
    const rc2 = await tx2.wait();
    assertOk(!!rc2, "missing receipt for pushPermissionLevelUpdate");

    const blk2 = await ethers.provider.getBlock(rc2.blockNumber);
    const expectedTs2 = BigInt(blk2!.timestamp);

    // Legacy event must be present and timestamp must match tx block.timestamp
    const legacyLvlLogs = rc2.logs
      .filter((l: any) => l.address.toLowerCase() === acvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === legacyLevelTopic);
    assertOk(legacyLvlLogs.length >= 1, "expected PermissionLevelUpdated");
    const legacyLvlParsed = acv.interface.parseLog({ topics: legacyLvlLogs[0].topics, data: legacyLvlLogs[0].data });
    assertOk((legacyLvlParsed.args[0] as string).toLowerCase() === user.address.toLowerCase(), "legacy level user mismatch");
    assertOk(Number(legacyLvlParsed.args[1]) === newLevel, "legacy level newLevel mismatch");
    assertOk(BigInt(legacyLvlParsed.args[2]) === expectedTs2, "legacy level timestamp must equal tx block.timestamp");

    const dpLogs2 = rc2.logs
      .filter((l: any) => l.address.toLowerCase() === acvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs2.length >= 1, "expected DataPushed for permission level update");
    const parsed2 = acv.interface.parseLog({ topics: dpLogs2[0].topics, data: dpLogs2[0].data });
    assertOk(parsed2.args[0] === DATA_TYPE_LEVEL, "unexpected dataTypeHash for permission level update");

    // enum encodes as uint8
    const decoded2 = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint8"], parsed2.args[1]);
    assertOk((decoded2[0] as string).toLowerCase() === user.address.toLowerCase(), "level payload.user mismatch");
    assertOk(Number(decoded2[1]) === newLevel, "level payload.newLevel mismatch");

    const [lvl1, lvlValid1, lvlTs1] = (await mustSucceed("getUserPermissionLevelWithMeta (after push)", async () =>
      acv.connect(user).getUserPermissionLevelWithMeta(user.address)
    )) as [bigint, boolean, bigint];
    assertOk(Number(lvl1) === newLevel, "after push, level mismatch");
    assertOk(lvlValid1 === true, "after push, level isValid must be true");
    assertOk(lvlTs1 > 0n, "after push, level timestamp must be >0");

    await network.provider.send("evm_increaseTime", [5 * 60 + 1]);
    await network.provider.send("evm_mine", []);
    const [lvlExp, lvlValidExp, lvlTsExp] = (await mustSucceed("getUserPermissionLevelWithMeta (expired)", async () =>
      acv.connect(user).getUserPermissionLevelWithMeta(user.address)
    )) as [bigint, boolean, bigint];
    assertOk(Number(lvlExp) === newLevel, "expired cache must keep stored level value");
    assertOk(lvlValidExp === false, "expired cache must have isValid=false");
    assertOk(lvlTsExp === lvlTs1, "expired cache must keep original timestamp");

    // Clean up impersonation (best-effort)
    await network.provider.send("hardhat_stopImpersonatingAccount", [acmAddr]);

    console.log("\n✅ AccessControlView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

