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
  return String(msg).includes("function selector was not recognized");
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

    console.log("=== E2E StatisticsView Acceptance (ARCH 4.4) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const statsAddr = (await registry.getModuleOrRevert(key("VAULT_STATISTICS"))) as string;
    const stats = (await ethers.getContractAt("StatisticsView", statsAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  StatisticsView:", statsAddr);

    // ============ ST-01: system aggregate read (fields present + meta) ============
    const g0 = await stats.getGlobalStatistics();
    assertOk(g0.totalUsers >= 0n, "totalUsers missing");
    assertOk(g0.activeUsers >= 0n, "activeUsers missing");
    assertOk(g0.totalCollateral >= 0n, "totalCollateral missing");
    assertOk(g0.totalDebt >= 0n, "totalDebt missing");
    assertOk(g0.lastUpdateTime > 0n, "lastUpdateTime should be >0");

    const [g0m, valid0, ts0] = (await stats.getGlobalStatisticsWithMeta()) as [any, boolean, bigint];
    assertOk(g0m.lastUpdateTime === g0.lastUpdateTime, "getGlobalStatisticsWithMeta.lastUpdateTime mismatch");
    assertOk(ts0 === g0.lastUpdateTime, "meta timestamp must equal lastUpdateTime");
    assertOk(typeof valid0 === "boolean", "meta isValid must be boolean");

    console.log(`  ✅ ST-01: read OK (lastUpdateTime=${g0.lastUpdateTime.toString()} valid=${valid0})`);

    // ============ ST-02: push update emits DataPushed + monotonic lastUpdateTime ============
    const user = ethers.Wallet.createRandom().address;
    const v0 = (await stats.getUserStatsVersion(user)) as bigint;
    const nextV1 = v0 + 1n;
    const req1 = ethers.id("st-e2e-req-1");
    const seq1 = 10n;

    const collateralIn = 1000n;
    const collateralOut = 0n;
    const borrow = 500n;
    const repay = 0n;

    const tx1 = await stats["pushUserStatsUpdate(address,uint256,uint256,uint256,uint256,bytes32,uint64,uint64)"](
      user,
      collateralIn,
      collateralOut,
      borrow,
      repay,
      req1,
      seq1,
      nextV1
    );
    const r1 = await tx1.wait();
    assertOk(!!r1, "missing receipt for pushUserStatsUpdate tx1");

    // DataPushed(USER_STATS_UPDATE, abi.encode(user, version, requestId, seq, UserSnapshot, GlobalSnapshot))
    const dataTypeUserStats = ethers.id("USER_STATS_UPDATE");
    const dpTopic = stats.interface.getEvent("DataPushed").topicHash;
    const dpLogs1 = r1.logs
      .filter((l: any) => l.address?.toLowerCase?.() === statsAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs1.length >= 1, "expected DataPushed in tx1");
    const parsed1 = stats.interface.parseLog({ topics: dpLogs1[0].topics, data: dpLogs1[0].data });
    assertOk(parsed1.args[0] === dataTypeUserStats, `unexpected dataTypeHash: ${parsed1.args[0]}`);

    const decoded1 = ethers.AbiCoder.defaultAbiCoder().decode(
      [
        "address",
        "uint64",
        "bytes32",
        "uint64",
        "tuple(uint256 collateral,uint256 debt,uint256 ltv,uint256 healthFactor,uint256 timestamp,bool isActive)",
        "tuple(uint256 totalCollateral,uint256 totalDebt,uint256 averageLTV,uint256 averageHealthFactor,uint256 activeUsers,uint256 timestamp)",
      ],
      parsed1.args[1]
    ) as unknown as [string, bigint, string, bigint, any, any];

    assertOk(decoded1[0].toLowerCase() === user.toLowerCase(), "payload.user mismatch");
    assertOk(decoded1[1] === nextV1, `payload.version mismatch (expected ${nextV1})`);
    assertOk(decoded1[2].toLowerCase() === req1.toLowerCase(), "payload.requestId mismatch");
    assertOk(decoded1[3] === seq1, "payload.seq mismatch");

    const g1 = await stats.getGlobalStatistics();
    assertOk(g1.totalUsers === 1n, "totalUsers should be 1 after first push");
    assertOk(g1.activeUsers === 1n, "activeUsers should be 1 after first push");
    assertOk(g1.totalCollateral === collateralIn, "totalCollateral mismatch after push");
    assertOk(g1.totalDebt === borrow, "totalDebt mismatch after push");
    assertOk(g1.lastUpdateTime >= g0.lastUpdateTime, "lastUpdateTime must be monotonic");

    const [, v1, s1, lastReq1, isValid1, ts1] = (await stats.getUserSnapshotWithMeta(user)) as [
      any,
      bigint,
      bigint,
      string,
      boolean,
      bigint,
    ];
    assertOk(v1 === nextV1, "user version mismatch after push");
    assertOk(s1 === seq1, "user seq mismatch after push");
    assertOk(lastReq1.toLowerCase() === req1.toLowerCase(), "lastAppliedRequestId mismatch");
    assertOk(isValid1 === true && ts1 > 0n, "user snapshot should be valid after push");

    console.log("  ✅ ST-02: push emits DataPushed + aggregates updated");

    // ============ ST-03: wrong version fails; idempotent replay; out-of-order seq fails ============
    const staleSel = ethers.id("StatisticsView__StaleUserStatsVersion(uint64,uint64)").slice(0, 10);
    const curV = (await stats.getUserStatsVersion(user)) as bigint;
    // Wrong nextVersion: set nextVersion==current (not current+1), requestId different, seq=0 to skip seq check.
    await mustRevertWithSelector("wrong nextVersion should revert", staleSel, async () => {
      await stats["pushUserStatsUpdate(address,uint256,uint256,uint256,uint256,bytes32,uint64,uint64)"](
        user,
        1n,
        0n,
        0n,
        0n,
        ethers.id("st-e2e-bad"),
        0n,
        curV
      );
    });

    // Idempotent replay: same requestId, nextVersion==currentVersion => ignored, no DataPushed, emits IdempotentRequestIgnored.
    const replayTx = await stats["pushUserStatsUpdate(address,uint256,uint256,uint256,uint256,bytes32,uint64,uint64)"](
      user,
      collateralIn,
      0n,
      0n,
      0n,
      req1,
      1n,
      curV // nextVersion == currentVersion
    );
    const replayRcpt = await replayTx.wait();
    assertOk(!!replayRcpt, "missing replay receipt");

    const ignoredTopic = stats.interface.getEvent("IdempotentRequestIgnored").topicHash;
    const ignoredLogs = replayRcpt.logs
      .filter((l: any) => l.address?.toLowerCase?.() === statsAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === ignoredTopic);
    assertOk(ignoredLogs.length >= 1, "expected IdempotentRequestIgnored on replay");

    const dpLogsReplay = replayRcpt.logs
      .filter((l: any) => l.address?.toLowerCase?.() === statsAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogsReplay.length === 0, "idempotent replay must not emit DataPushed");
    assertOk((await stats.getUserStatsVersion(user)) === curV, "idempotent replay must not change version");

    const outOfOrderSel = ethers.id("StatisticsView__OutOfOrderSeq(uint64,uint64)").slice(0, 10);
    await mustRevertWithSelector("out-of-order seq should revert", outOfOrderSel, async () => {
      await stats["pushUserStatsUpdate(address,uint256,uint256,uint256,uint256,bytes32,uint64,uint64)"](
        user,
        1n,
        0n,
        0n,
        0n,
        ethers.id("st-e2e-req-2"),
        9n, // <= 10
        curV + 1n
      );
    });

    console.log("\n✅ StatisticsView acceptance PASSED");
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

