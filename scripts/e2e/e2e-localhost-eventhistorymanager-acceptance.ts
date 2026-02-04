/**
 * @file e2e-localhost-eventhistorymanager-acceptance.ts
 * @notice EventHistoryManager（ARCH 4.16）专项验收 E2E 测试脚本
 * @dev 本脚本用于在本地 Hardhat 节点上验证 EventHistoryManager 模块的对齐验收标准
 *
 * ## 测试目标（对应 ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 4.16）
 *
 * ### EHM-02: 写入口权限 gate
 * - 无权限账号（无 `ACTION_MANAGE_EVENT_HISTORY`）调用 `recordEvent` 必须 `revert MissingRole()`
 * - 不得使用 revert string；错误需可脚本断言（selector/自定义 error）
 *
 * ### EHM-03: 成功记录：HistoryRecorded + DataPushed 双事件
 * - 有权限账号（具备 `ACTION_MANAGE_EVENT_HISTORY`）调用 `recordEvent` 必须成功
 * - 成功后必须同时观察到 `HistoryRecorded` 与 `DataPushed` 两个事件
 * - `DataPushed.payload` 必须能 ABI 解码回 `eventType/user/asset/amount/extraData`
 * - `DataPushed` 的 payload 必须与 `HistoryRecorded` 事件参数一致
 *
 * ### EHM-04: DataPush type 常量口径
 * - `DataPushed` 的 `dataTypeHash` 必须来自集中常量口径（`DATA_TYPE_HISTORY = keccak256("EVENT_HISTORY")`）
 * - 类型语义稳定，便于链下索引统一消费
 *
 * ## 职责边界（EHM-01，本脚本不直接测试）
 * - EventHistoryManager 定位为"轻量桩件"：不持久化链上存储，仅发事件供链下索引消费
 * - 不得引入链上历史存储或复杂查询（职责边界通过代码审阅验证）
 *
 * ## 版本信息（EHM-05，本脚本不直接测试）
 * - `getVersionInfo()` 由 `ViewVersioned` 提供，用于链下定位实现与 schema 变更
 * - UUPS + `__gap` + 统一版本信息必须保留
 *
 * ## 运行方式
 * ```bash
 * npx hardhat run scripts/e2e/e2e-localhost-eventhistorymanager-acceptance.ts --network localhost
 * ```
 *
 * ## 前置条件
 * - 本地 Hardhat 节点已启动（`pnpm -s run node`）
 * - 合约已部署到本地节点（`pnpm -s run deploy:localhost`）
 * - 部署脚本已正确配置 `EVENT_HISTORY_MANAGER` 模块注册到 Registry
 *
 * ## 验收标准
 * - ✅ 无权限调用者必须 `revert MissingRole()`（selector 验证，不依赖 revert string）
 * - ✅ 有权限调用者成功执行 `recordEvent`
 * - ✅ 同时观察到 `HistoryRecorded` 与 `DataPushed` 事件
 * - ✅ `DataPushed.dataTypeHash` 等于 `DATA_TYPE_HISTORY`
 * - ✅ `DataPushed.payload` 可 ABI 解码且与 `HistoryRecorded` 参数一致
 *
 * @see ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 4.16 EventHistoryManager 测试矩阵
 * @see scripts/e2e/README.md 4.15 章节说明
 */

import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

/**
 * 断言条件为真，否则抛出错误
 */
function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/**
 * 从错误对象中提取可读的错误消息
 */
function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

/**
 * 检查错误消息是否表示函数选择器缺失（通常表示部署/ABI 不匹配）
 */
function isMissingSelectorError(msg: string): boolean {
  return String(msg).includes("function selector was not recognized");
}

/**
 * 验证函数调用必须 revert 且错误为 MissingRole()
 * @param label 测试标签（用于日志输出）
 * @param fn 待测试的异步函数
 * @throws 如果函数未 revert 或 revert 的错误不是 MissingRole()
 */
async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const missingRoleSel = ethers.id("MissingRole()").slice(0, 10); // 4-byte selector
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const hay = `${msg} ${e?.data ?? ""} ${e?.info?.error?.data ?? ""}`;
    assertOk(
      hay.includes("MissingRole") || hay.toLowerCase().includes(missingRoleSel.toLowerCase()),
      `[FAIL] ${label}: expected MissingRole(), got: ${hay}`
    );
    console.log(`  ✅ [revert MissingRole as expected] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected MissingRole() revert, but succeeded: ${label}`);
}

/**
 * 创建 EVM 快照（用于测试后恢复状态）
 */
async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

/**
 * 恢复到指定的 EVM 快照
 */
async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

/**
 * 主测试函数
 * 
 * 测试流程：
 * 1. 执行 View Preflight（统一路由/权限/版本信息检查）
 * 2. 准备测试账户（operator 有权限，unauthorized 无权限）
 * 3. 验证无权限调用者必须 revert MissingRole()
 * 4. 验证有权限调用者成功执行并触发双事件（HistoryRecorded + DataPushed）
 * 5. 验证 DataPushed payload 可解码且与 HistoryRecorded 一致
 */
async function main() {
  const snap = await snapshot();
  try {
    const [deployer] = await ethers.getSigners();

    console.log("=== E2E EventHistoryManager Acceptance (ARCH 4.16) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt(
      "AccessControlManager",
      CONTRACT_ADDRESSES.AccessControlManager
    )) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const ehmAddr = (await registry.getModuleOrRevert(key("EVENT_HISTORY_MANAGER"))) as string;
    const ehm = (await ethers.getContractAt("EventHistoryManager", ehmAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  EventHistoryManager:", ehmAddr);

    // ====== Roles ======
    // ActionKeys.ACTION_MANAGE_EVENT_HISTORY = keccak256("MANAGE_EVENT_HISTORY")
    const ROLE_MANAGE_EVENT_HISTORY = key("MANAGE_EVENT_HISTORY");

    const operator = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: operator.address, value: ethers.parseEther("1") });
    if (!(await acm.hasRole(ROLE_MANAGE_EVENT_HISTORY, operator.address))) {
      await (await acm.connect(deployer).grantRole(ROLE_MANAGE_EVENT_HISTORY, operator.address)).wait();
    }

    const unauthorized = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: unauthorized.address, value: ethers.parseEther("1") });

    // ====== Inputs ======
    const eventType = key("TEST_EVENT_TYPE");
    const user = operator.address;
    const asset = CONTRACT_ADDRESSES.MockUSDC;
    const amount = 123n;
    const extraData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "string"], [42n, "hello"]);

    // DataPushTypes.DATA_TYPE_HISTORY = keccak256("EVENT_HISTORY")
    const DATA_TYPE_HISTORY = key("EVENT_HISTORY");

    // ====== EHM-02: 写入口权限 gate ======
    // 无权限账号调用 recordEvent 必须 revert MissingRole()
    await mustRevertMissingRole("unauthorized.recordEvent", async () =>
      ehm.connect(unauthorized).recordEvent(eventType, user, asset, amount, extraData)
    );

    // ====== EHM-03: 成功记录：HistoryRecorded + DataPushed 双事件 ======
    // 有权限账号调用 recordEvent 必须成功，并同时触发两个事件
    const tx = await ehm.connect(operator).recordEvent(eventType, user, asset, amount, extraData);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("missing receipt for recordEvent");
    }

    // 验证 HistoryRecorded 事件
    const histTopic = ehm.interface.getEvent("HistoryRecorded").topicHash;
    const histLogs = receipt.logs
      .filter((l: any) => l.address?.toLowerCase() === ehmAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === histTopic);
    assertOk(histLogs.length >= 1, "expected HistoryRecorded from EventHistoryManager");
    const parsedHist = ehm.interface.parseLog({ topics: histLogs[0].topics, data: histLogs[0].data });
    assertOk(parsedHist.args.eventType === eventType, "HistoryRecorded.eventType mismatch");
    assertOk(String(parsedHist.args.user).toLowerCase() === user.toLowerCase(), "HistoryRecorded.user mismatch");
    assertOk(String(parsedHist.args.asset).toLowerCase() === asset.toLowerCase(), "HistoryRecorded.asset mismatch");
    assertOk(parsedHist.args.amount === amount, "HistoryRecorded.amount mismatch");
    assertOk(parsedHist.args.extraData === extraData, "HistoryRecorded.extraData mismatch");
    assertOk(parsedHist.args.blockNumber > 0n, "HistoryRecorded.blockNumber must be non-zero");

    // 验证 DataPushed 事件（EHM-04: DataPush type 常量口径）
    const dpIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
    const dpEvent = dpIface.getEvent("DataPushed");
    if (!dpEvent) {
      throw new Error("missing DataPushed event signature");
    }
    const dpTopic = dpEvent.topicHash;
    const dpLogs = receipt.logs
      .filter((l: any) => l.address?.toLowerCase() === ehmAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs.length >= 1, "expected DataPushed from EventHistoryManager");
    const parsedDp = dpIface.parseLog({ topics: dpLogs[0].topics, data: dpLogs[0].data });
    if (!parsedDp) {
      throw new Error("failed to parse DataPushed log");
    }
    assertOk(parsedDp.args.dataTypeHash === DATA_TYPE_HISTORY, "unexpected dataTypeHash for history");

    // 验证 DataPushed payload 可 ABI 解码且与 HistoryRecorded 一致（EHM-03）
    const [et, u, a, amt, extra] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes32", "address", "address", "uint256", "bytes"],
      parsedDp.args.payload
    ) as unknown as [string, string, string, bigint, string];
    assertOk(et === eventType, "DataPushed.payload.eventType mismatch");
    assertOk(u.toLowerCase() === user.toLowerCase(), "DataPushed.payload.user mismatch");
    assertOk(a.toLowerCase() === asset.toLowerCase(), "DataPushed.payload.asset mismatch");
    assertOk(amt === amount, "DataPushed.payload.amount mismatch");
    assertOk(extra === extraData, "DataPushed.payload.extraData mismatch");

    console.log("\n✅ EventHistoryManager acceptance checks passed.");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

