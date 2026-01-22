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
    const [deployer, other] = await ethers.getSigners();

    console.log("=== E2E HealthView Acceptance (ARCH 4.3) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const hvAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
    const hv = (await ethers.getContractAt("HealthView", hvAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  HealthView:", hvAddr);

    // ====== MUST: read path is role-gated via VIEW_RISK_DATA (MissingRole() on unauthorized) ======
    const user = ethers.Wallet.createRandom().address;
    const missingRoleSel = ethers.id("MissingRole()").slice(0, 10);
    await mustRevertWithSelector(
      "Unauthorized read: getUserHealthFactor",
      missingRoleSel,
      async () => hv.connect(other).getUserHealthFactor(user),
      { expectedName: "MissingRole()" }
    );

    // Authorized read (deployer has VIEW_RISK_DATA per deploylocal + preflight).
    const [hf0, valid0, ts0] = (await hv.connect(deployer).getUserHealthFactor(user)) as [bigint, boolean, bigint];
    assertOk(hf0 === 0n && valid0 === false && ts0 === 0n, "uncached read should return (0,false,0)");

    // Meta alias must match canonical read.
    const [hf0m, valid0m, ts0m] = (await hv.connect(deployer).getUserHealthFactorWithMeta(user)) as [bigint, boolean, bigint];
    assertOk(hf0m === hf0 && valid0m === valid0 && ts0m === ts0, "getUserHealthFactorWithMeta must match canonical");

    const [f0, flags0, tsArr0] = (await hv.connect(deployer).batchGetHealthFactors([user])) as [
      bigint[],
      boolean[],
      bigint[],
    ];
    assertOk(f0.length === 1 && flags0.length === 1 && tsArr0.length === 1, "batch outputs must include timestamps");
    assertOk(f0[0] === 0n && flags0[0] === false && tsArr0[0] === 0n, "uncached batch must return (0,false,0)");

    // empty batch must revert
    const emptyArraySel = ethers.id("EmptyArray()").slice(0, 10);
    await mustRevertWithSelector("batchGetHealthFactors empty", emptyArraySel, async () =>
      hv.connect(deployer).batchGetHealthFactors([])
    );

    // ====== MUST: batch > MAX_BATCH_SIZE should revert with unified error ======
    const oversized = new Array(101).fill(user);
    const batchTooLargeSel = ethers.id("BatchTooLarge(uint256,uint256)").slice(0, 10);
    await mustRevertWithSelector("batchGetHealthFactors oversized", batchTooLargeSel, async () =>
      hv.connect(deployer).batchGetHealthFactors(oversized)
    );

    // ====== Push access control: non-pusher must revert ======
    // Use a fresh random wallet to avoid "deployer already has roles" interference.
    const randomCaller = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: randomCaller.address, value: ethers.parseEther("1") });
    await mustRevertWithSelector(
      "pushRiskStatus from non-pusher",
      missingRoleSel,
      async () => hv.connect(randomCaller).pushRiskStatus(user, 9500n, 10500n, true, 0),
      { expectedName: "MissingRole()" }
    );

    // ====== MUST: successful push emits DataPushed and updates timestamp monotonically ======
    const ACTION_VIEW_PUSH = key("ACTION_VIEW_PUSH");
    const vaultRouterAddr = CONTRACT_ADDRESSES.VaultRouter;
    assertOk(await acm.hasRole(ACTION_VIEW_PUSH, vaultRouterAddr), "missing ACTION_VIEW_PUSH for VaultRouter (re-run deploy:localhost)");
    await network.provider.send("hardhat_impersonateAccount", [vaultRouterAddr]);
    await network.provider.send("hardhat_setBalance", [vaultRouterAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const leSigner = await ethers.getSigner(vaultRouterAddr);

    const DATA_TYPE_RISK = ethers.id("RISK_STATUS_UPDATE"); // must equal DataPushTypes.DATA_TYPE_RISK_STATUS
    const tx1 = await hv.connect(leSigner).pushRiskStatus(user, 9500n, 10500n, true, 0);
    const r1 = await tx1.wait();
    assertOk(!!r1, "missing receipt for pushRiskStatus");

    const [hf1, valid1, ts1] = (await hv.getUserHealthFactor(user)) as [bigint, boolean, bigint];
    assertOk(hf1 === 9500n && valid1 === true && ts1 > 0n, "pushRiskStatus must update cache + timestamp");

    // DataPushed payload must be decodable
    const dpTopic = hv.interface.getEvent("DataPushed").topicHash;
    const dpLogs = r1.logs
      .filter((l: any) => l.address.toLowerCase() === hvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs.length >= 1, "expected DataPushed");
    const parsed = hv.interface.parseLog({ topics: dpLogs[0].topics, data: dpLogs[0].data });
    assertOk(parsed.args[0] === DATA_TYPE_RISK, "unexpected dataTypeHash for risk status");

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "uint256", "uint256", "bool", "uint256"],
      parsed.args[1]
    );
    assertOk(decoded[0].toLowerCase() === user.toLowerCase(), "payload.user mismatch");
    assertOk(decoded[1] === 9500n && decoded[2] === 10500n && decoded[3] === true, "payload fields mismatch");

    // monotonic ts
    await network.provider.send("evm_increaseTime", [5]);
    await network.provider.send("evm_mine", []);
    await hv.connect(leSigner).pushRiskStatus(user, 9600n, 10500n, true, 0);
    const [, , ts2] = (await hv.getUserHealthFactor(user)) as [bigint, boolean, bigint];
    assertOk(ts2 >= ts1, "timestamp must be monotonic");

    // explicit timestamp must be respected (must be <= current block.timestamp to avoid underflow in validity calc)
    const latestBlock = await ethers.provider.getBlock("latest");
    const explicitTs = BigInt(latestBlock!.timestamp);
    await hv.connect(leSigner).pushRiskStatus(user, 9700n, 10500n, true, explicitTs);
    const [hf3, valid3, ts3] = (await hv.getUserHealthFactor(user)) as [bigint, boolean, bigint];
    assertOk(hf3 === 9700n && valid3 === true && ts3 === explicitTs, "explicit timestamp must be stored");

    // ====== MUST: cache expiration flips isValid to false but preserves timestamp/value ======
    // HealthView CACHE_DURATION is 5 minutes by ViewConstants.
    // Guardrail: should still be valid shortly before expiry
    await network.provider.send("evm_increaseTime", [4 * 60 + 50]);
    await network.provider.send("evm_mine", []);
    const [, validPreExp, tsPreExp] = (await hv.getUserHealthFactor(user)) as [bigint, boolean, bigint];
    assertOk(validPreExp === true && tsPreExp === explicitTs, "cache must remain valid before expiry boundary");

    // Then cross the boundary and ensure it becomes invalid
    await network.provider.send("evm_increaseTime", [20]);
    await network.provider.send("evm_mine", []);
    const [hfExp, validExp, tsExp] = (await hv.getUserHealthFactor(user)) as [bigint, boolean, bigint];
    assertOk(hfExp === 9700n && validExp === false && tsExp === explicitTs, "expired cache should be invalid but keep value+timestamp");

    // ====== Batch read: mixed users return proper timestamps/valid flags ======
    const user2 = ethers.Wallet.createRandom().address;
    await hv.connect(leSigner).pushRiskStatus(user2, 11000n, 10500n, false, 0);
    const [fa, va, ta] = (await hv.batchGetHealthFactors([user, user2])) as [bigint[], boolean[], bigint[]];
    assertOk(fa.length === 2 && va.length === 2 && ta.length === 2, "batch arrays length mismatch");
    assertOk(fa[0] === 9700n, "batch hf for user mismatch");
    assertOk(va[0] === false, "batch validity for expired user should be false");
    assertOk(ta[0] === explicitTs, "batch timestamp for user mismatch");
    assertOk(fa[1] === 11000n && va[1] === true && ta[1] > 0n, "batch entry for user2 mismatch");
    // Hard gate: batch result must match single-read result for each entry.
    const [hf2s, v2s, ts2s] = (await hv.getUserHealthFactor(user2)) as [bigint, boolean, bigint];
    assertOk(hf2s === fa[1] && v2s === va[1] && ts2s === ta[1], "batch vs single mismatch for user2");

    // ====== pushRiskStatusBatch: validates input lengths and emits DataPushed with correct encoding ======
    const DATA_TYPE_RISK_BATCH = ethers.id("RISK_STATUS_UPDATE_BATCH"); // must equal DataPushTypes.DATA_TYPE_RISK_STATUS_BATCH
    const u3 = ethers.Wallet.createRandom().address;
    const users = [user2, u3];
    const hfs = [8800n, 10200n];
    const mins = [10500n, 10500n];
    const flags = [true, false];

    // length mismatch should revert
    await mustRevertWithSelector("pushRiskStatusBatch length mismatch", ethers.id("ArrayLengthMismatch(uint256,uint256)").slice(0, 10), async () =>
      hv.connect(leSigner).pushRiskStatusBatch([user2], hfs, mins, flags, 0)
    );

    const txB = await hv.connect(leSigner).pushRiskStatusBatch(users, hfs, mins, flags, 0);
    const rcB = await txB.wait();
    assertOk(!!rcB, "missing receipt for pushRiskStatusBatch");
    const dpLogsB = rcB.logs
      .filter((l: any) => l.address.toLowerCase() === hvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogsB.length >= 1, "expected DataPushed for batch");
    const parsedB = hv.interface.parseLog({ topics: dpLogsB[0].topics, data: dpLogsB[0].data });
    assertOk(parsedB.args[0] === DATA_TYPE_RISK_BATCH, "unexpected dataTypeHash for risk batch");
    const decodedB = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address[]", "uint256[]", "uint256[]", "bool[]", "uint256"],
      parsedB.args[1]
    );
    assertOk(decodedB[0].length === 2 && decodedB[1].length === 2 && decodedB[2].length === 2 && decodedB[3].length === 2, "batch payload shapes mismatch");

    // Hard gate: payload contents must exactly match inputs (order + values).
    const decodedUsers = decodedB[0] as string[];
    const decodedHfs = decodedB[1] as bigint[];
    const decodedMins = decodedB[2] as bigint[];
    const decodedFlags = decodedB[3] as boolean[];
    const decodedTs = decodedB[4] as bigint;

    assertOk(decodedUsers[0].toLowerCase() === users[0].toLowerCase(), "batch payload.users[0] mismatch");
    assertOk(decodedUsers[1].toLowerCase() === users[1].toLowerCase(), "batch payload.users[1] mismatch");
    assertOk(decodedHfs[0] === hfs[0] && decodedHfs[1] === hfs[1], "batch payload.hfs mismatch");
    assertOk(decodedMins[0] === mins[0] && decodedMins[1] === mins[1], "batch payload.mins mismatch");
    assertOk(decodedFlags[0] === flags[0] && decodedFlags[1] === flags[1], "batch payload.flags mismatch");

    // timestamp=0 should be normalized to block.timestamp (and then stored for each entry)
    const blkB = await ethers.provider.getBlock(rcB.blockNumber);
    const expectedTsB = BigInt(blkB!.timestamp);
    assertOk(decodedTs === expectedTsB, "batch payload.timestamp must equal tx block.timestamp when input timestamp=0");

    // Hard gate: after batch push, reads must reflect pushed values + timestamps
    const [hf2a, v2a, ts2a] = (await hv.getUserHealthFactor(user2)) as [bigint, boolean, bigint];
    assertOk(hf2a === hfs[0] && v2a === true && ts2a === expectedTsB, "post-batch read mismatch for user2");
    const [hf3a, v3a, ts3a] = (await hv.getUserHealthFactor(u3)) as [bigint, boolean, bigint];
    // NOTE: return `isValid` is cache validity (freshness), not the pushed `flags[]` value.
    assertOk(hf3a === hfs[1] && v3a === true && ts3a === expectedTsB, "post-batch read mismatch for user3");

    console.log("\n✅ HealthView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

