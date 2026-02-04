/**
 * @file e2e-localhost-viewcache-acceptance.ts
 * @notice ViewCache（ARCH 4.5）专项验收 E2E 测试脚本
 * @dev 本脚本用于在本地 Hardhat 节点上验证 ViewCache 模块的对齐验收标准
 *
 * ## 测试目标（对应 ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 4.5）
 *
 * ### VC-01: 读返回 staleness（有效性信息）
 * - 调用 `getSystemStatus(asset)` 必须返回 `updateBlock` 且可用于判断 `isValid`
 * - 未写入缓存时：`isValid=false`，`updateBlock=0`
 * - 字段齐全；`updateBlock` 合理
 *
 * ### VC-02: 写入口权限
 * - 无权限账号（无 `VIEW_SYSTEM_DATA` / `ACTION_ADMIN`）调用 `setSystemStatus` 必须 revert
 * - 写入口必须被 gate（系统级推送权限/管理员）；无权限写入必须 revert
 * - 错误口径：`MissingRole()`（断言 selector，不依赖 revert string）
 * - 非法输入（如 `asset=0`）必须按实现 revert
 *
 * ### VC-03: 写入后可观测
 * - 有权限写入后 `isValid=true` 且 updateBlock 更新
 * - 必须出现 `DataPushed(SYSTEM_STATUS_CACHE, payload)`，payload 可 ABI 解码且与写入一致
 * - 必须出现 `CacheUpdated` 事件
 *
 * ## 扩展验证（与架构公约一致）
 *
 * ### 批量读边界
 * - `batchGetSystemStatus([])` 空数组必须 revert
 * - `batchGetSystemStatus(oversized)` 超限（> MAX_BATCH_SIZE）必须 revert
 *
 * ### 每资产 updateBlock 独立（TTL 独立性）
 * - 一个资产的写入不得刷新另一资产的 updateBlock
 * - 使用挖块跨过 CACHE_DURATION_BLOCKS 后，过期资产 `isValid=false`，未过期资产仍 `isValid=true`
 * - 过期后存储的 value/updateBlock 保留，仅 isValid 变为 false
 *
 * ### 批量读与单读一致性
 * - `batchGetSystemStatus([assetA, assetB])` 的 `validFlags` 与分别调用 `getSystemStatus` 一致
 * - 批量返回的 status 与单读一致
 *
 * ### clearSystemCache 行为
 * - 仅 admin/系统权限可调用；无权限必须 `MissingRole()`
 * - 清空后 `updateBlock=0`、存储值归零、`isValid=false`
 * - 清空操作也必须触发 `CacheUpdated` 与 `DataPushed(SYSTEM_STATUS_CACHE, payload)`（payload 为清零后的数据）
 *
 * ## 运行方式
 * ```bash
 * npx hardhat run scripts/e2e/e2e-localhost-viewcache-acceptance.ts --network localhost
 * ```
 *
 * ## 前置条件
 * - 本地 Hardhat 节点已启动（`pnpm -s run node`）
 * - 合约已部署到本地节点（`pnpm -s run deploy:localhost`）
 * - 部署脚本已正确配置 `VIEW_CACHE` 模块注册到 Registry
 *
 * ## 验收标准
 * - ✅ 读接口返回 `updateBlock` 与 `isValid`（或等效 staleness）
 * - ✅ 无权限写入口必须 `revert MissingRole()`
 * - ✅ 有权限写入后 `isValid=true`、updateBlock 更新、观察到 `DataPushed` 且 payload 可解码
 * - ✅ 批量读空数组/超限必须 revert
 * - ✅ 每资产 TTL 独立；过期后 `isValid=false` 且与单读/batch 一致
 * - ✅ `clearSystemCache` 权限与可观测性符合上述约定
 *
 * @see ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 4.5 ViewCache 测试矩阵
 * @see scripts/e2e/README.md 4.5 章节说明
 */

import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

const BLOCKS_PER_MINUTE = 30n;

/** 断言条件为真，否则抛出错误 */
function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** 从错误对象中提取可读的错误消息 */
function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

/** 检查错误消息是否表示函数选择器缺失（通常表示部署/ABI 不匹配） */
function isMissingSelectorError(msg: string): boolean {
  return msg.includes("function selector was not recognized");
}

/** 从异常对象中提取 revert data 的十六进制字符串，用于 MissingRole 等 selector 断言 */
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

/** 断言调用必须 revert；若成功则抛错，若因缺失 selector 而 revert 则提示部署/ABI 不匹配 */
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

/** 断言调用必须 revert 且错误为 MissingRole()（通过 selector/revert data 断言，不依赖 revert string） */
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

/** 执行调用并返回结果；若因缺失 selector 而 revert 则提示部署/ABI 不匹配，其它错误直接抛出 */
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

/** 创建 EVM 快照（用于测试后恢复状态） */
async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

/** 恢复到指定的 EVM 快照 */
async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

/**
 * E2E 主流程：ViewCache 验收（VC-01 / VC-02 / VC-03 + 扩展验证）
 * 1. 预检 + 解析 ViewCache 地址，校验 version/registry
 * 2. VC-01：未写入时读返回 updateBlock=0、isValid=false；写入后 updateBlock>0、isValid=true
 * 3. VC-02：无权限 setSystemStatus → MissingRole；asset=0 → revert
 * 4. VC-03：有权限写入后 DataPushed + CacheUpdated，payload 可解码且与写入一致
 * 5. 扩展：batch 空数组/超限 revert；每资产 TTL 独立；batch 与单读一致；clearSystemCache 权限与可观测性
 */
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

    // --- VC-01: 读返回 staleness（未写入时 updateBlock=0、isValid=false）---
    const [s0, v0] = (await mustSucceed("ViewCache.getSystemStatus(assetA)", async () => vc.getSystemStatus(assetA))) as [
      { updateBlock: bigint },
      boolean,
    ];
    assertOk(typeof s0.updateBlock === "bigint", "SystemStatusCache.updateBlock must be a bigint");
    assertOk(v0 === false, "uncached system status must be invalid");
    assertOk(s0.updateBlock === 0n, "uncached system status updateBlock must be 0");

    // --- VC-02: 写入口权限（无权限 MissingRole；非法 asset revert）---
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

    // --- 扩展：批量读边界（空数组/超限必须 revert）---
    await mustRevert("batchGetSystemStatus empty", async () => vc.batchGetSystemStatus([]));
    const oversized = new Array(101).fill(assetA);
    await mustRevert("batchGetSystemStatus oversized", async () => vc.batchGetSystemStatus(oversized));

    // --- VC-03: 写入后可观测（DataPushed + CacheUpdated，payload 可解码且与写入一致）---
    const DATA_TYPE_SYSTEM_STATUS = key("SYSTEM_STATUS_CACHE");
    const tx1 = await mustSucceed("setSystemStatus(assetA) tx", async () =>
      vc.connect(deployer).setSystemStatus(assetA, 111n, 222n, 333n)
    );
    const rc1 = await tx1.wait();
    assertOk(!!rc1, "missing receipt for setSystemStatus");

    const [s1, v1] = (await mustSucceed("ViewCache.getSystemStatus(assetA) after write", async () =>
      vc.getSystemStatus(assetA)
    )) as [
      { updateBlock: bigint; totalCollateral: bigint; totalDebt: bigint; utilizationRate: bigint; isValid: boolean },
      boolean,
    ];
    assertOk(v1 === true, "after write, isValid must be true");
    assertOk(s1.updateBlock > 0n, "after write, updateBlock must be > 0");
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
    assertOk(decoded[4] === s1.updateBlock, "payload.blockNumber must equal stored updateBlock");

    // --- 扩展：每资产 updateBlock 独立（TTL 独立性；过期后 isValid=false，未过期仍 true）---
    // Write assetB 2 minutes later, then cross the 5-min TTL boundary for assetA only.
    await network.provider.send("hardhat_mine", [ethers.toBeHex(2n * BLOCKS_PER_MINUTE)]);
    const txB = await mustSucceed("setSystemStatus(assetB) tx", async () =>
      vc.connect(deployer).setSystemStatus(assetB, 444n, 555n, 666n)
    );
    const rcB = await txB.wait();
    assertOk(!!rcB, "missing receipt for setSystemStatus(assetB)");

    const [aAfterB, aValidAfterB] = (await mustSucceed("ViewCache.getSystemStatus(assetA) post assetB write", async () =>
      vc.getSystemStatus(assetA)
    )) as [{ updateBlock: bigint }, boolean];
    const [b1, bValid1] = (await mustSucceed("ViewCache.getSystemStatus(assetB) post write", async () =>
      vc.getSystemStatus(assetB)
    )) as [
      { updateBlock: bigint; totalCollateral: bigint; totalDebt: bigint; utilizationRate: bigint; isValid: boolean },
      boolean,
    ];
    assertOk(aValidAfterB === true, "assetA should still be valid at ~2m");
    assertOk(aAfterB.updateBlock === s1.updateBlock, "assetB write must not refresh assetA updateBlock");
    assertOk(bValid1 === true && b1.updateBlock > 0n, "assetB must be valid after write");

    await network.provider.send("hardhat_mine", [ethers.toBeHex(4n * BLOCKS_PER_MINUTE + 1n)]); // assetA age > 6m, assetB age ~4m
    const [aExp, aValidExp] = (await mustSucceed("ViewCache.getSystemStatus(assetA) expiry check", async () =>
      vc.getSystemStatus(assetA)
    )) as [{ updateBlock: bigint; totalCollateral: bigint }, boolean];
    const [bOk, bValidOk] = (await mustSucceed("ViewCache.getSystemStatus(assetB) validity check", async () =>
      vc.getSystemStatus(assetB)
    )) as [{ updateBlock: bigint; totalCollateral: bigint }, boolean];
    assertOk(aValidExp === false, "assetA should be expired after >5m");
    assertOk(
      aExp.updateBlock === s1.updateBlock && aExp.totalCollateral === 111n,
      "assetA expiry must keep stored value+updateBlock"
    );
    assertOk(bValidOk === true, "assetB should still be valid (<5m)");
    assertOk(bOk.totalCollateral === 444n, "assetB value mismatch");

    // --- 扩展：批量读与单读一致性（validFlags / status 与单读一致）---
    const [statuses, validFlags] = (await mustSucceed("ViewCache.batchGetSystemStatus([assetA,assetB])", async () =>
      vc.batchGetSystemStatus([assetA, assetB])
    )) as [
      Array<{ updateBlock: bigint; totalCollateral: bigint; totalDebt: bigint; utilizationRate: bigint; isValid: boolean }>,
      boolean[],
    ];
    assertOk(statuses.length === 2 && validFlags.length === 2, "batch output length mismatch");
    assertOk(validFlags[0] === aValidExp, "batch validFlags[0] mismatch");
    assertOk(validFlags[1] === bValidOk, "batch validFlags[1] mismatch");
    assertOk(
      statuses[0].updateBlock === aExp.updateBlock && statuses[0].totalCollateral === aExp.totalCollateral,
      "batch status[0] mismatch"
    );
    assertOk(
      statuses[1].updateBlock === (b1 as any).updateBlock && statuses[1].totalCollateral === bOk.totalCollateral,
      "batch status[1] mismatch"
    );

    // --- 扩展：clearSystemCache 行为（权限 gate + 清空后 updateBlock=0/isValid=false + CacheUpdated/DataPushed）---
    await mustRevertMissingRole("clearSystemCache from unauthorized signer", async () =>
      vc.connect(randomCaller).clearSystemCache(assetB)
    );
    const txClear = await mustSucceed("clearSystemCache(assetB) tx", async () => vc.connect(deployer).clearSystemCache(assetB));
    const rcClear = await txClear.wait();
    assertOk(!!rcClear, "missing receipt for clearSystemCache");

    // After clear: stored updateBlock must be 0, isValid must be false
    const [bCleared, bClearedValid] = (await mustSucceed("ViewCache.getSystemStatus(assetB) after clear", async () =>
      vc.getSystemStatus(assetB)
    )) as [{ updateBlock: bigint; totalCollateral: bigint }, boolean];
    assertOk(bCleared.updateBlock === 0n && bCleared.totalCollateral === 0n, "clear should delete stored status");
    assertOk(bClearedValid === false, "after clear, isValid must be false");

    // CacheUpdated + DataPushed must exist for clear too (payload blockNumber is tx blockNumber, not stored updateBlock=0)
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

