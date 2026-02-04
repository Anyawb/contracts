import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
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
  return String(msg).includes("function selector was not recognized");
}

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.data?.data,
    e?.error?.data,
    e?.error?.data?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.data?.data,
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
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const data = extractRevertData(e);
    let sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    if (!sel) {
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

function countByKey<K extends string>(m: Record<K, number>, k: K) {
  m[k] = (m[k] ?? 0) + 1;
}

async function main() {
  const snap = await snapshot();
  try {
    const [deployer, user] = await ethers.getSigners();
    console.log("=== E2E RewardView Acceptance (ARCH 4.14) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    const rvAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const rv = (await ethers.getContractAt("RewardView", rvAddr)) as any;

    const rmcAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;
    const rcAddr = (await registry.getModuleOrRevert(key("REWARD_CONSUMPTION"))) as string;

    console.log("  RewardView:", rvAddr);
    console.log("  RewardManagerCore (writer):", rmcAddr);
    console.log("  RewardConsumption (writer):", rcAddr);

    const missingRoleSel = errorSelector("MissingRole()");
    const unauthorizedWriterSel = errorSelector("RewardView__UnauthorizedWriter()");

    const dpIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
    const dpEvent = dpIface.getEvent("DataPushed");
    assertOk(!!dpEvent, "failed to resolve DataPushed event from interface");
    const dpTopic = dpEvent.topicHash;
    const dataPushedCounts: Record<string, number> = {};
    const expectedReverts: Record<string, number> = {};

    function recordDataPush(typeHash: string) {
      countByKey(dataPushedCounts, typeHash.toLowerCase());
    }

    function recordExpectedRevert(name: string) {
      countByKey(expectedReverts, name);
    }

    function findDataPushedPayload(receipt: any, expectedTypeHash: string): string {
      const logs = receipt.logs
        .filter((l: any) => l.address?.toLowerCase() === rvAddr.toLowerCase())
        .filter((l: any) => l.topics?.[0] === dpTopic);

      for (const l of logs) {
        const parsed = dpIface.parseLog({ topics: l.topics, data: l.data });
        assertOk(!!parsed, "failed to parse DataPushed log");
        const th = String(parsed.args.dataTypeHash).toLowerCase();
        recordDataPush(th);
        if (th === expectedTypeHash.toLowerCase()) {
          return parsed.args.payload as string;
        }
      }
      throw new Error(`expected DataPushed(${expectedTypeHash}) not found in receipt`);
    }

    // Artifacts: snapshot addresses + version info early (for upgrade/debug)
    const artifacts = mkArtifactsWriter();
    const rvVer = (await mustSucceed("RewardView.getVersionInfo()", async () => rv.getVersionInfo())) as [bigint, bigint, string];
    const snapshotModules = {
      Registry: CONTRACT_ADDRESSES.Registry,
      AccessControlManager: CONTRACT_ADDRESSES.AccessControlManager,
      SystemView: await registry.getModuleOrRevert(key("SYSTEM_VIEW")),
      RewardView: rvAddr,
      RewardManagerCore: rmcAddr,
      RewardConsumption: rcAddr,
      RewardPoints: await registry.getModuleOrRevert(key("REWARD_POINTS")),
    };
    console.log("  VersionInfo(RewardView):", `api=${rvVer[0].toString()} schema=${rvVer[1].toString()} impl=${rvVer[2]}`);

    // ====== MUST: unauthorized writer cannot push* ======
    const unauthorized = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: unauthorized.address, value: ethers.parseEther("1") });
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call pushRewardEarned",
      async () => rv.connect(unauthorized).pushRewardEarned(user.address, 1n, "unauthorized", 1n),
      unauthorizedWriterSel
    );
    recordExpectedRevert("unauthorized:pushRewardEarned");
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call pushPointsBurned",
      async () => rv.connect(unauthorized).pushPointsBurned(user.address, 1n, "unauthorized", 1n),
      unauthorizedWriterSel
    );
    recordExpectedRevert("unauthorized:pushPointsBurned");
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call pushPenaltyLedger",
      async () => rv.connect(unauthorized).pushPenaltyLedger(user.address, 1n, 1n),
      unauthorizedWriterSel
    );
    recordExpectedRevert("unauthorized:pushPenaltyLedger");
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call pushUserLevel",
      async () => rv.connect(unauthorized).pushUserLevel(user.address, 1, 1n),
      unauthorizedWriterSel
    );
    recordExpectedRevert("unauthorized:pushUserLevel");
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call pushUserPrivilege",
      async () => rv.connect(unauthorized).pushUserPrivilege(user.address, 1n, 1n),
      unauthorizedWriterSel
    );
    recordExpectedRevert("unauthorized:pushUserPrivilege");
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call pushSystemStats",
      async () => rv.connect(unauthorized).pushSystemStats(1n, 1n, 1n),
      unauthorizedWriterSel
    );
    recordExpectedRevert("unauthorized:pushSystemStats");
    await mustRevertWithSelector(
      "Unauthorized EOA cannot call retryPushConsumptionRecord",
      async () => rv.connect(unauthorized).retryPushConsumptionRecord(user.address, 1, 2, 10n, 1000n, 1n),
      missingRoleSel
    );
    recordExpectedRevert("unauthorized:retryPushConsumptionRecord");

    // ====== MUST: writer can push and emits DataPushed(typeHash,payload) ======
    // Impersonate RewardManagerCore to call writer-only functions.
    await network.provider.send("hardhat_impersonateAccount", [rmcAddr]);
    await network.provider.send("hardhat_setBalance", [rmcAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const rmcSigner = await ethers.getSigner(rmcAddr);

    const nowBlock = BigInt(await ethers.provider.getBlockNumber());
    const tx1 = await mustSucceed("RewardManagerCore.pushRewardEarned", async () =>
      rv.connect(rmcSigner).pushRewardEarned(user.address, 123n, "e2e", nowBlock)
    );
    const rcpt1 = await tx1.wait();
    assertOk(!!rcpt1, "missing receipt for pushRewardEarned");
    const payload1 = findDataPushedPayload(rcpt1, key("REWARD_EARNED"));
    const [u1, amt1, reason1, block1] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "string", "uint256"],
      payload1
    ) as unknown as [string, bigint, string, bigint];
    assertOk(u1.toLowerCase() === user.address.toLowerCase(), "REWARD_EARNED payload user mismatch");
    assertOk(amt1 === 123n, "REWARD_EARNED payload amount mismatch");
    assertOk(reason1 === "e2e", "REWARD_EARNED payload reason mismatch");
    assertOk(block1 === nowBlock, "REWARD_EARNED payload blockNumber mismatch");

    // Also verify the second writer (RewardConsumption) is allowed.
    await network.provider.send("hardhat_impersonateAccount", [rcAddr]);
    await network.provider.send("hardhat_setBalance", [rcAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const rcSigner = await ethers.getSigner(rcAddr);

    const tx2 = await mustSucceed("RewardConsumption.pushPointsBurned", async () =>
      rv.connect(rcSigner).pushPointsBurned(user.address, 5n, "burn", nowBlock + 1n)
    );
    const rcpt2 = await tx2.wait();
    assertOk(!!rcpt2, "missing receipt for pushPointsBurned");
    const payload2 = findDataPushedPayload(rcpt2, key("REWARD_BURNED"));
    const [u2, amt2, reason2, block2] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "string", "uint256"],
      payload2
    ) as unknown as [string, bigint, string, bigint];
    assertOk(u2.toLowerCase() === user.address.toLowerCase(), "REWARD_BURNED payload user mismatch");
    assertOk(amt2 === 5n, "REWARD_BURNED payload amount mismatch");
    assertOk(reason2 === "burn", "REWARD_BURNED payload reason mismatch");
    assertOk(block2 === nowBlock + 1n, "REWARD_BURNED payload blockNumber mismatch");

    // Remaining push* must emit DataPushed with centralized type hashes.
    const txP = await mustSucceed("RewardManagerCore.pushPenaltyLedger", async () =>
      rv.connect(rmcSigner).pushPenaltyLedger(user.address, 7n, nowBlock + 2n)
    );
    const rcptP = await txP.wait();
    assertOk(!!rcptP, "missing receipt for pushPenaltyLedger");
    const payloadP = findDataPushedPayload(rcptP, key("REWARD_PENALTY_LEDGER_UPDATED"));
    const [uP, pendingDebt, blockP] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "uint256"],
      payloadP
    ) as unknown as [string, bigint, bigint];
    assertOk(uP.toLowerCase() === user.address.toLowerCase(), "PENALTY payload user mismatch");
    assertOk(pendingDebt === 7n, "PENALTY payload debt mismatch");
    assertOk(blockP === nowBlock + 2n, "PENALTY payload blockNumber mismatch");

    const txL = await mustSucceed("RewardManagerCore.pushUserLevel", async () =>
      rv.connect(rmcSigner).pushUserLevel(user.address, 3, nowBlock + 3n)
    );
    const rcptL = await txL.wait();
    assertOk(!!rcptL, "missing receipt for pushUserLevel");
    const payloadL = findDataPushedPayload(rcptL, key("REWARD_LEVEL_UPDATED"));
    const [uL, lvl, blockL] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint8", "uint256"],
      payloadL
    ) as unknown as [string, bigint, bigint];
    assertOk(uL.toLowerCase() === user.address.toLowerCase(), "LEVEL payload user mismatch");
    assertOk(lvl === 3n, "LEVEL payload level mismatch");
    assertOk(blockL === nowBlock + 3n, "LEVEL payload blockNumber mismatch");

    const txPr = await mustSucceed("RewardManagerCore.pushUserPrivilege", async () =>
      rv.connect(rmcSigner).pushUserPrivilege(user.address, 0x1234n, nowBlock + 4n)
    );
    const rcptPr = await txPr.wait();
    assertOk(!!rcptPr, "missing receipt for pushUserPrivilege");
    const payloadPr = findDataPushedPayload(rcptPr, key("REWARD_PRIVILEGE_UPDATED"));
    const [uPr, priv, blockPr] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "uint256"],
      payloadPr
    ) as unknown as [string, bigint, bigint];
    assertOk(uPr.toLowerCase() === user.address.toLowerCase(), "PRIV payload user mismatch");
    assertOk(priv === 0x1234n, "PRIV payload packed mismatch");
    assertOk(blockPr === nowBlock + 4n, "PRIV payload blockNumber mismatch");

    const txS = await mustSucceed("RewardManagerCore.pushSystemStats", async () =>
      rv.connect(rmcSigner).pushSystemStats(9n, 10n, nowBlock + 5n)
    );
    const rcptS = await txS.wait();
    assertOk(!!rcptS, "missing receipt for pushSystemStats");
    const payloadS = findDataPushedPayload(rcptS, key("REWARD_STATS_UPDATED"));
    const [bOps, cached, blockS] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256", "uint256"],
      payloadS
    ) as unknown as [bigint, bigint, bigint];
    assertOk(bOps === 9n, "STATS payload batchOps mismatch");
    assertOk(cached === 10n, "STATS payload cached mismatch");
    assertOk(blockS === nowBlock + 5n, "STATS payload blockNumber mismatch");

    // Retry push for consumption record must also emit DataPushed (admin-only path).
    assertOk(await acm.hasRole(key("ACTION_ADMIN"), deployer.address), "deployer missing ACTION_ADMIN");
    const txR = await mustSucceed("Admin.retryPushConsumptionRecord", async () =>
      rv.connect(deployer).retryPushConsumptionRecord(user.address, 1, 2, 10n, 1000n, nowBlock + 6n)
    );
    const rcptR = await txR.wait();
    assertOk(!!rcptR, "missing receipt for retryPushConsumptionRecord");
    const payloadR = findDataPushedPayload(rcptR, key("REWARD_CONSUMPTION_RECORDED"));
    const [uR, serviceTypeR, serviceLevelR, pointsR, expirationR, blockR] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint8", "uint8", "uint256", "uint256", "uint256"],
      payloadR
    ) as unknown as [string, bigint, bigint, bigint, bigint, bigint];
    assertOk(uR.toLowerCase() === user.address.toLowerCase(), "REWARD_CONSUMPTION payload user mismatch");
    assertOk(serviceTypeR === 1n, "REWARD_CONSUMPTION payload serviceType mismatch");
    assertOk(serviceLevelR === 2n, "REWARD_CONSUMPTION payload serviceLevel mismatch");
    assertOk(pointsR === 10n, "REWARD_CONSUMPTION payload points mismatch");
    assertOk(expirationR === 1000n, "REWARD_CONSUMPTION payload expiration mismatch");
    assertOk(blockR === nowBlock + 6n, "REWARD_CONSUMPTION payload blockNumber mismatch");

    // ====== MUST: read privacy gate ======
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") });

    await mustRevertWithSelector(
      "Outsider cannot read getUserRewardSummaryWithMeta(non-self)",
      async () => rv.connect(outsider).getUserRewardSummaryWithMeta(user.address),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserRewardSummaryWithMeta(non-self)");
    await mustRevertWithSelector(
      "Outsider cannot read getUserRecentActivitiesWithMeta(non-self)",
      async () => rv.connect(outsider).getUserRecentActivitiesWithMeta(user.address, 0n, 0n, 10n),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserRecentActivitiesWithMeta(non-self)");
    await mustRevertWithSelector(
      "Outsider cannot read getUserBalanceWithMeta(non-self)",
      async () => rv.connect(outsider).getUserBalanceWithMeta(user.address),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserBalanceWithMeta(non-self)");
    await mustRevertWithSelector(
      "Outsider cannot read getUserLastConsumptionWithMeta(non-self)",
      async () => rv.connect(outsider).getUserLastConsumptionWithMeta(user.address, 0),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserLastConsumptionWithMeta(non-self)");
    await mustRevertWithSelector(
      "Outsider cannot read getUserLevelWithMeta(non-self)",
      async () => rv.connect(outsider).getUserLevelWithMeta(user.address),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserLevelWithMeta(non-self)");
    await mustRevertWithSelector(
      "Outsider cannot read getUserActivityWithMeta(non-self)",
      async () => rv.connect(outsider).getUserActivityWithMeta(user.address),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserActivityWithMeta(non-self)");
    await mustRevertWithSelector(
      "Outsider cannot read getUserPenaltyDebtWithMeta(non-self)",
      async () => rv.connect(outsider).getUserPenaltyDebtWithMeta(user.address),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getUserPenaltyDebtWithMeta(non-self)");

    // self can read
    await mustSucceed("User can read getUserRewardSummaryWithMeta(self)", async () =>
      rv.connect(user).getUserRewardSummaryWithMeta(user.address)
    );

    // ops can read after VIEW_USER_DATA
    const ops = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: ops.address, value: ethers.parseEther("1") });
    await mustRevertWithSelector(
      "Ops cannot read before VIEW_USER_DATA",
      async () => rv.connect(ops).getUserRewardSummaryWithMeta(user.address),
      missingRoleSel
    );
    recordExpectedRevert("ops:getUserRewardSummaryWithMeta(before-role)");
    if (!(await acm.hasRole(key("VIEW_USER_DATA"), ops.address))) {
      await (await acm.connect(deployer).grantRole(key("VIEW_USER_DATA"), ops.address)).wait();
    }
    if (!(await acm.hasRole(key("VIEW_SYSTEM_DATA"), ops.address))) {
      await (await acm.connect(deployer).grantRole(key("VIEW_SYSTEM_DATA"), ops.address)).wait();
    }
    await mustSucceed("Ops can read after VIEW_USER_DATA", async () =>
      rv.connect(ops).getUserRewardSummaryWithMeta(user.address)
    );
    await mustSucceed("Ops can read getUserBalanceWithMeta", async () => rv.connect(ops).getUserBalanceWithMeta(user.address));
    await mustSucceed(
      "Ops can read getUserLastConsumptionWithMeta",
      async () => rv.connect(ops).getUserLastConsumptionWithMeta(user.address, 0)
    );
    await mustSucceed("Ops can read getUserLevelWithMeta", async () => rv.connect(ops).getUserLevelWithMeta(user.address));
    await mustSucceed("Ops can read getUserActivityWithMeta", async () => rv.connect(ops).getUserActivityWithMeta(user.address));
    await mustSucceed("Ops can read getUserPenaltyDebtWithMeta", async () => rv.connect(ops).getUserPenaltyDebtWithMeta(user.address));

    // ====== MUST: cache meta (isValid/blockNumber) ======
    const [,,,,,,,, blockMeta0, isValid0] = (await mustSucceed("getUserRewardSummaryWithMeta(self)", async () =>
      rv.connect(user).getUserRewardSummaryWithMeta(user.address)
    )) as unknown as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
    assertOk(blockMeta0 > 0n, "meta.blockNumber must be non-zero after push");
    assertOk(isValid0 === true, "meta.isValid must be true right after push");

    // TTL expiry: ViewConstants.CACHE_DURATION = 5 minutes
    await network.provider.send("hardhat_mine", [ethers.toBeHex(151)]);

    const [,,,,,,,, blockMeta1, isValid1] = (await rv.connect(user).getUserRewardSummaryWithMeta(user.address)) as unknown as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean
    ];
    assertOk(blockMeta1 === blockMeta0, "blockNumber must not change without a new push");
    assertOk(isValid1 === false, "meta.isValid must be false after TTL");

    // BlockNumber must advance after a new push (monotonicity)
    const txRefresh = await mustSucceed("RewardManagerCore.pushRewardEarned(refresh)", async () =>
      rv.connect(rmcSigner).pushRewardEarned(user.address, 1n, "refresh", nowBlock + 7n)
    );
    const rcptRefresh = await txRefresh.wait();
    assertOk(!!rcptRefresh, "missing receipt for refresh pushRewardEarned");
    findDataPushedPayload(rcptRefresh, key("REWARD_EARNED"));
    const [,,,,,,,, blockMeta2, isValid2] = (await rv.connect(user).getUserRewardSummaryWithMeta(user.address)) as unknown as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean
    ];
    assertOk(blockMeta2 >= blockMeta1, "blockNumber must be monotonic non-decreasing across pushes");
    assertOk(isValid2 === true, "meta.isValid must be true right after refresh push");

    // ====== SHOULD: new *WithMeta read helpers (blockNumber/isValid required) ======
    const [balance, balBlock, balValid] = await mustSucceed("getUserBalanceWithMeta", async () =>
      rv.connect(user).getUserBalanceWithMeta(user.address)
    );
    assertOk(balBlock > 0n, "getUserBalanceWithMeta.blockNumber must be > 0");
    assertOk(balValid === true, "getUserBalanceWithMeta.isValid must be true");
    balance; // value may be zero on localhost

    const [usage, usageBlock, usageValid] = await mustSucceed("getServiceUsageWithMeta", async () =>
      rv.getServiceUsageWithMeta(0)
    );
    assertOk(usageBlock > 0n, "getServiceUsageWithMeta.blockNumber must be > 0");
    assertOk(usageValid === true, "getServiceUsageWithMeta.isValid must be true");
    usage; // value may be zero on localhost

    const [lastCons, lastConsBlock, lastConsValid] = await mustSucceed("getUserLastConsumptionWithMeta", async () =>
      rv.connect(user).getUserLastConsumptionWithMeta(user.address, 0)
    );
    assertOk(lastConsBlock > 0n, "getUserLastConsumptionWithMeta.blockNumber must be > 0");
    assertOk(lastConsValid === true, "getUserLastConsumptionWithMeta.isValid must be true");
    lastCons; // value may be zero on localhost

    const [lvlMeta, lvlBlock, lvlValid] = await mustSucceed("getUserLevelWithMeta", async () =>
      rv.connect(user).getUserLevelWithMeta(user.address)
    );
    assertOk(lvlBlock > 0n, "getUserLevelWithMeta.blockNumber must be > 0");
    assertOk(lvlValid === true, "getUserLevelWithMeta.isValid must be true");
    lvlMeta; // value may be zero on localhost

    const [lastActivity, totalLoans, totalVolume, actBlock, actValid] = await mustSucceed(
      "getUserActivityWithMeta",
      async () => rv.connect(user).getUserActivityWithMeta(user.address)
    );
    assertOk(actBlock > 0n, "getUserActivityWithMeta.blockNumber must be > 0");
    assertOk(actValid === true, "getUserActivityWithMeta.isValid must be true");
    lastActivity;
    totalLoans;
    totalVolume;

    const [penaltyDebt, debtBlock, debtValid] = await mustSucceed("getUserPenaltyDebtWithMeta", async () =>
      rv.connect(user).getUserPenaltyDebtWithMeta(user.address)
    );
    assertOk(debtBlock > 0n, "getUserPenaltyDebtWithMeta.blockNumber must be > 0");
    assertOk(debtValid === true, "getUserPenaltyDebtWithMeta.isValid must be true");
    penaltyDebt;

    // ====== MUST: system stats read is ops-gated ======
    await mustRevertWithSelector(
      "Outsider cannot read getSystemRewardStatsWithMeta",
      async () => rv.connect(outsider).getSystemRewardStatsWithMeta(),
      missingRoleSel
    );
    recordExpectedRevert("outsider:getSystemRewardStatsWithMeta");
    await mustSucceed("Ops can read getSystemRewardStatsWithMeta", async () =>
      rv.connect(ops).getSystemRewardStatsWithMeta()
    );

    // ====== RV-06: read path must not emit DataPushed (even if forced via tx call) ======
    const txRead1 = await mustSucceed("tx-call getUserRewardSummaryWithMeta(self) should not emit DataPushed", async () =>
      user.sendTransaction({
        to: rvAddr,
        data: rv.interface.encodeFunctionData("getUserRewardSummaryWithMeta", [user.address]),
      })
    );
    const rcptRead1 = await txRead1.wait();
    assertOk(!!rcptRead1, "missing receipt for tx-call getUserRewardSummaryWithMeta");
    const readLogs1 = rcptRead1.logs
      .filter((l: any) => l.address?.toLowerCase() === rvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(readLogs1.length === 0, "read-only getUserRewardSummaryWithMeta MUST NOT emit DataPushed");

    const txRead2 = await mustSucceed("tx-call getSystemRewardStatsWithMeta should not emit DataPushed", async () =>
      (ops as any).sendTransaction({
        to: rvAddr,
        data: rv.interface.encodeFunctionData("getSystemRewardStatsWithMeta", []),
      })
    );
    const rcptRead2 = await txRead2.wait();
    assertOk(!!rcptRead2, "missing receipt for tx-call getSystemRewardStatsWithMeta");
    const readLogs2 = rcptRead2.logs
      .filter((l: any) => l.address?.toLowerCase() === rvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(readLogs2.length === 0, "read-only getSystemRewardStatsWithMeta MUST NOT emit DataPushed");

    // ====== Artifacts output (MUST) ======
    const artifactBlock = await ethers.provider.getBlockNumber();
    const artifactPath = artifacts.writeJson(`rewardview-acceptance.${artifactBlock}.json`, {
      name: "RewardView acceptance (ARCH 4.14)",
      generatedAt: new Date().toISOString(),
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      modules: snapshotModules,
      versionInfo: {
        RewardView: { apiVersion: rvVer[0].toString(), schemaVersion: rvVer[1].toString(), implementation: rvVer[2] },
      },
      counters: {
        dataPushedByTypeHash: dataPushedCounts,
        expectedReverts,
      },
    });
    console.log("\n  📦 artifacts:", artifactPath);
    console.log("\n✅ RewardView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

