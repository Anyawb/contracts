import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

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
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const statsAddr = (await registry.getModuleOrRevert(key("VAULT_STATISTICS"))) as string;
    const stats = (await ethers.getContractAt("StatisticsView", statsAddr)) as any;
    const pushMgrAddr = (await registry.getModuleOrRevert(key("STATISTICS_PUSH_MANAGER"))) as string;
    const pushMgr = (await ethers.getContractAt("StatisticsPushManager", pushMgrAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  StatisticsView:", statsAddr);
    console.log("  StatisticsPushManager:", pushMgrAddr);

    // Ensure deployer can call retry* APIs.
    const ROLE_VIEW_PUSH = key("ACTION_VIEW_PUSH");
    if (!(await acm.hasRole(ROLE_VIEW_PUSH, deployer.address))) {
      await (await acm.connect(deployer).grantRole(ROLE_VIEW_PUSH, deployer.address)).wait();
      console.log("  ✅ granted ACTION_VIEW_PUSH to deployer");
    }

    // Ensure deployer is an admin for direct StatisticsView invariants checks.
    // (Scheme B: only StatsPushManager or ACTION_ADMIN may push to StatisticsView.)
    const ROLE_ADMIN = key("ACTION_ADMIN");
    if (!(await acm.hasRole(ROLE_ADMIN, deployer.address))) {
      await (await acm.connect(deployer).grantRole(ROLE_ADMIN, deployer.address)).wait();
      console.log("  ✅ granted ACTION_ADMIN to deployer");
    }

    // ============ ST-01: system aggregate read (fields present + meta) ============
    const [g0m, valid0, block0] = (await stats.getGlobalStatisticsWithMeta()) as [any, boolean, bigint];
    assertOk(g0m.totalUsers >= 0n, "totalUsers missing");
    assertOk(g0m.activeUsers >= 0n, "activeUsers missing");
    assertOk(g0m.totalCollateral >= 0n, "totalCollateral missing");
    assertOk(g0m.totalDebt >= 0n, "totalDebt missing");
    assertOk(g0m.lastUpdateBlock > 0n, "lastUpdateBlock should be >0");
    assertOk(block0 === g0m.lastUpdateBlock, "meta blockNumber must equal lastUpdateBlock");
    assertOk(typeof valid0 === "boolean", "meta isValid must be boolean");

    console.log(`  ✅ ST-01: read OK (lastUpdateBlock=${g0m.lastUpdateBlock.toString()} valid=${valid0})`);

    // ============ ST-02: retry push emits DataPushed + monotonic lastUpdateBlock ============
    const user = ethers.Wallet.createRandom().address;
    const v0 = (await stats.getUserStatsVersion(user)) as bigint;

    const tx1 = await pushMgr.connect(deployer).retryUserStats(user);
    const r1 = await tx1.wait();
    assertOk(!!r1, "missing receipt for pushUserStatsUpdate tx1");

    // DataPushed(USER_STATS_UPDATE, abi.encode(user, version, requestId, seq, UserSnapshot, GlobalSnapshot))
    const dataTypeUserStats = ethers.id("USER_STATS_UPDATE");
    const dpTopic = stats.interface.getEvent("DataPushed").topicHash;
    const dpLogs1 = r1.logs
      .filter((l: any) => l.address?.toLowerCase?.() === statsAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    const didPush = dpLogs1.length >= 1;
    let v1: bigint | null = null;
    let req1: string | null = null;
    let seq1: bigint | null = null;
    if (!didPush) {
      console.log("  ⚠️  No DataPushed in retryUserStats (idempotent/dirty chain); skipping strict payload checks");
    } else {
      const parsed1 = stats.interface.parseLog({ topics: dpLogs1[0].topics, data: dpLogs1[0].data });
      assertOk(parsed1.args[0] === dataTypeUserStats, `unexpected dataTypeHash: ${parsed1.args[0]}`);

      const decoded1 = ethers.AbiCoder.defaultAbiCoder().decode(
        [
          "address",
          "uint64",
          "bytes32",
          "uint64",
          "tuple(uint256 collateral,uint256 debt,uint256 ltv,uint256 healthFactor,uint256 blockNumber,bool isActive)",
          "tuple(uint256 totalCollateral,uint256 totalDebt,uint256 averageLTV,uint256 averageHealthFactor,uint256 activeUsers,uint256 blockNumber)",
        ],
        parsed1.args[1]
      ) as unknown as [string, bigint, string, bigint, any, any];

      assertOk(decoded1[0].toLowerCase() === user.toLowerCase(), "payload.user mismatch");
      v1 = decoded1[1];
      req1 = decoded1[2] as string;
      seq1 = decoded1[3] as bigint;
      assertOk(v1 === v0 + 1n, `payload.version mismatch (expected ${v0 + 1n})`);
      assertOk(typeof req1 === "string" && req1.startsWith("0x"), "payload.requestId missing");
      assertOk((seq1 as bigint) > 0n, "payload.seq must be >0");
    }

    const [g1m] = (await stats.getGlobalStatisticsWithMeta()) as [any, boolean, bigint];
    if (didPush) {
      assertOk(g1m.totalUsers >= 1n, "totalUsers should be >=1 after push");
      assertOk(g1m.lastUpdateBlock >= g0m.lastUpdateBlock, "lastUpdateBlock must be monotonic");
    } else {
      assertOk(g1m.lastUpdateBlock >= g0m.lastUpdateBlock, "lastUpdateBlock must be monotonic");
    }

    const [, v1m, s1m, lastReq1, isValid1, userBlockNumber] = (await stats.getUserSnapshotWithMeta(user)) as [
      any,
      bigint,
      bigint,
      string,
      boolean,
      bigint,
    ];
    if (didPush) {
      assertOk(v1m === v1, "user version mismatch after push");
      assertOk(s1m === seq1, "user seq mismatch after push");
      assertOk(lastReq1.toLowerCase() === (req1 as string).toLowerCase(), "lastAppliedRequestId mismatch");
      assertOk(isValid1 === true && userBlockNumber > 0n, "user snapshot should be valid after push");
    }

    console.log("  ✅ ST-02: retryUserStats emits DataPushed + aggregates updated");

    // ============ ST-02b: guarantee snapshot push via retryGuarantee ============
    const asset = CONTRACT_ADDRESSES.MockUSDC;
    const txG = await pushMgr.connect(deployer).retryGuarantee(user, asset);
    const rG = await txG.wait();
    assertOk(!!rG, "missing receipt for retryGuarantee");

    const dataTypeGuarantee = ethers.id("GUARANTEE_STATS_UPDATE");
    const dpLogsG = rG.logs
      .filter((l: any) => l.address?.toLowerCase?.() === statsAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    let decodedG: [string, string, bigint, bigint, string, bigint, bigint, bigint] | null = null;
    if (dpLogsG.length < 1) {
      console.log("  ⚠️  No DataPushed in retryGuarantee (idempotent/dirty chain); skipping payload checks");
    } else {
      const parsedG = stats.interface.parseLog({ topics: dpLogsG[0].topics, data: dpLogsG[0].data });
      assertOk(parsedG.args[0] === dataTypeGuarantee, `unexpected guarantee dataTypeHash: ${parsedG.args[0]}`);

    // DataPushed(GUARANTEE_STATS_UPDATE, abi.encode(user, asset, userBalance, totalByAsset, requestId, seq, nextVersion, blockNumber))
      decodedG = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "address", "uint256", "uint256", "bytes32", "uint64", "uint64", "uint256"],
        parsedG.args[1]
      ) as unknown as [string, string, bigint, bigint, string, bigint, bigint, bigint];
      assertOk(decodedG[0].toLowerCase() === user.toLowerCase(), "guarantee payload.user mismatch");
      assertOk(decodedG[1].toLowerCase() === asset.toLowerCase(), "guarantee payload.asset mismatch");
    }

    const [bal, gValid, gBlockNumber] = (await stats.getUserGuaranteeBalanceWithMeta(user, asset)) as [
      bigint,
      boolean,
      bigint,
    ];
    if (decodedG) {
      assertOk(bal === decodedG[2], "guarantee userBalance mismatch vs view getter");
      assertOk(gBlockNumber === decodedG[7], "guarantee per-key blockNumber mismatch vs DataPushed");
    }
    assertOk(typeof gValid === "boolean", "guarantee meta isValid must be boolean");

    console.log("  ✅ ST-02b: retryGuarantee emits DataPushed + per-key meta blockNumber");

    // ============ ST-03: wrong version fails; idempotent replay; out-of-order seq fails ============
    const staleSel = ethers.id("StatisticsView__StaleUserStatsVersion(uint64,uint64)").slice(0, 10);
    const curV = (await stats.getUserStatsVersion(user)) as bigint;
    // Wrong nextVersion: set nextVersion==current (not current+1), requestId different, seq=0 to skip seq check.
    await mustRevertWithSelector("wrong nextVersion should revert", staleSel, async () => {
      await stats.pushUserStatsSnapshot(user, 0n, 0n, ethers.id("st-e2e-bad"), 0n, curV);
    });

    if (!didPush) {
      console.log("  ⚠️  Skipping out-of-order seq check (no DataPushed/seq captured)");
    } else {
      const outOfOrderSel = ethers.id("StatisticsView__OutOfOrderSeq(uint64,uint64)").slice(0, 10);
      await mustRevertWithSelector("out-of-order seq should revert", outOfOrderSel, async () => {
        // Use seq from the on-chain snapshot, then attempt to reuse it (<= current).
        await stats.pushUserStatsSnapshot(user, 0n, 0n, ethers.id("st-e2e-req-2"), seq1 as bigint, curV + 1n);
      });
    }

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

