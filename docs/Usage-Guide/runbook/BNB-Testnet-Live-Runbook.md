# BNB Testnet Live Runbook

## 0. 网络边界

这本 runbook 只覆盖 BNB Testnet 真链 live，边界固定如下：

- 这里只写 `bnbTestnet` 远程网络上的 live runtime、observability、baseline、release gate 与 sweep 纪律。
- 如果目标是本地 Hardhat fork 上复现 BNB 状态、补 runtime roles、检查 fork case 日志，跳到 `BNB-Testnet-Fork-Runbook.md`。
- 如果目标是 Arbitrum Sepolia live 或 mock-suite 放行，跳到 Arbitrum 对应两本 runbook，不要把那边的命令当成 BNB 的默认模板。
- 本文件中的 `--network bnbTestnet`、`bnb-testnet` package 命令、`scripts/tests/live-test/networks/bnb-testnet/` 路径，全部是 BNB 真链专用入口。

## 1. 目标

这份 runbook 只回答一件事：如何在 BNB Testnet 上执行当前 live 测试入口，并把 fresh borrower 自动补进去的原生币和 mock ERC20 在成功或失败后尽量统一回流，避免下一轮继续因为 sponsor/native 预算耗尽而失败。

如果当前目标不是直接跑真链 live，而是要先在本地 Hardhat fork 上复现 BNB Testnet 状态、补 runtime roles、检查 fork case 日志，再决定是否继续 baseline / release gates，请直接参考 `docs/Usage-Guide/runbook/BNB-Testnet-Fork-Runbook.md`。

当前推荐把 BNB Testnet 上线前验证理解成两层：

1. runtime：先验证真实资金链、订单、reward、guarantee、liquidation 主路径。
2. observability：再验证 DataPushed、view mirror、统计读面、专项 gate 与下游证据。

资金链模块与 live 证据的完整映射，单独见 [BNB-Testnet-Funds-Flow-Live-Matrix.md](BNB-Testnet-Funds-Flow-Live-Matrix.md)。

## 1.1 当前状态（2026-04-14）

当前最新结论必须按阶段理解，不要把“warmup 已修通”和“整条 baseline 已全绿”混为一谈：

1. 最新一轮 `test:live:platform-baseline:bnb-testnet` 已确认 warmup 通过。
2. 同一轮里 platform baseline 的 normal runtime 分支也已通过。
3. 当前剩余失败点不在 warmup，而在 guarantee default branch。
4. 最新失败信号是 platform baseline 在 guarantee default branch 内触发 `getModuleOrRevert(...)` 相关 revert，日志表现为 `Unknown selector: 0x74fce405`。

因此，当前 runbook 的 warmup 章节可以作为“已验证有效的标准写法”使用；但 platform baseline / release gates 的最终放行结论，仍需等 guarantee default branch 后续修复并重新留痕。

## 2. 自动补资与 Sweep 规则

当前 BNB Testnet live 脚本已经默认具备：

1. fresh borrower 自动分配到可恢复钱包池。
2. 如果没有显式提供 `LIVE_FRESH_BORROWER_MNEMONIC` / `LIVE_FRESH_BORROWER_PHRASE`，脚本会在 `scripts/tests/logs/fresh-borrowers/bnb-testnet/` 下自动创建 recovery seed 与 state 文件。
3. fresh borrower 需要的原生 BNB 会从 relayer / lender / viewer / updater 中自动补齐。
4. 进程成功结束或失败退出时，都会自动 sweep 已登记的 fresh borrower，把残余原生 BNB 与 mock ERC20 回流到 refundAddress / sponsor。

推荐固定环境：

```bash
LIVE_FRESH_BORROWER_NATIVE_ETH=0.0003
LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH=0.00005
LIVE_RELAYER_NATIVE_TARGET_ETH=0.0003
LIVE_FRESH_BORROWER_SWEEP_ERC20=1
LIVE_BNB_MIN_GAS_PRICE_WEI=1000000000
BNB_SKIP_WARMUP=0
```

说明：这里变量名仍沿用 `ETH`，但在 BNB Testnet 上实际表示原生 BNB。

如果目标是稳定执行 BNB warmup / platform baseline，而不是保守沿用旧的极低 native 预算，推荐额外固定：

```bash
LIVE_IGNITE_BORROWER_NATIVE_ETH=0.01
LIVE_IGNITE_REPAY_MIN_NATIVE_ETH=0.01
LIVE_IGNITE_APPROVE_NATIVE_RESERVE_ETH=0.001
LIVE_IGNITE_DEPOSIT_NATIVE_RESERVE_ETH=0.001
LIVE_IGNITE_REPAY_NATIVE_RESERVE_ETH=0.001
```

这些值的目的不是模拟主网终端用户的“最小可用余额”，而是给真链 live 测试提供足够的执行缓冲，避免 warmup 因 sponsor/native 预算太紧、RPC 余额读滞后、或 BNB 发送费率 floor 被低估而反复误报。

## 2.1 Warmup 标准写法（当前推荐）

如果只是验证 warmup 本身，而不是直接跑完整 platform baseline，推荐显式带上当前已验证有效的 native 预算：

```bash
set -a && source .env && set +a

LIVE_TEST_NETWORK=bnbTestnet \
LIVE_IGNITE_BORROWER_NATIVE_ETH=0.01 \
LIVE_IGNITE_REPAY_MIN_NATIVE_ETH=0.01 \
LIVE_IGNITE_APPROVE_NATIVE_RESERVE_ETH=0.001 \
LIVE_IGNITE_DEPOSIT_NATIVE_RESERVE_ETH=0.001 \
LIVE_IGNITE_REPAY_NATIVE_RESERVE_ETH=0.001 \
zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-warmup -- \
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-warmup.ts --network bnbTestnet
```

如果目标是直接验证当前平台主链路的最小闭环，使用现有 package 命令即可：

```bash
pnpm -s run test:live:platform-baseline:bnb-testnet
```

因为该命令已经内置：

1. `LIVE_IGNITE_BORROWER_NATIVE_ETH=0.01`
2. `LIVE_IGNITE_REPAY_MIN_NATIVE_ETH=0.01`
3. `LIVE_IGNITE_APPROVE_NATIVE_RESERVE_ETH=0.001`
4. `LIVE_IGNITE_DEPOSIT_NATIVE_RESERVE_ETH=0.001`
5. `LIVE_IGNITE_REPAY_NATIVE_RESERVE_ETH=0.001`

warmup 成功时，日志里至少应同时出现：

1. `[Gas] Mock Live Warmup: effective sender fee floor=1.0 gwei`
2. `switched to fresh ignition borrower ... mode=managed`
3. 至少一条 `[NativeTopUp] ... before=... after=... desired=... sponsored=...`
4. `✅ ViewCache prime completed`
5. `✅ live-warmup-bnb-testnet PASSED`

其中第 1 条和第 3 条是本轮修补后新增的关键诊断信号；缺失时，不要轻易把“脚本还能跑”解释成 warmup 已真正稳定。

## 2.2 Warmup 常见故障与判读

### 2.2.1 fee preview 很低，但真实发送仍按至少 1 gwei 计费

BNB warmup 日志中可能先看到类似：

```text
[Gas] Mock Live Warmup: dynamic EIP-1559 fees enabled maxFeePerGas=0.1 gwei maxPriorityFeePerGas=0.1 gwei
```

这只是 provider 预览值，不是最终发送下限。实际发送路径还会经过 `withNonceManagedSigner(...)`，在 `bnbTestnet` 上强制把 `gasPrice` 或 `maxPriorityFeePerGas / maxFeePerGas` 至少抬到 `LIVE_BNB_MIN_GAS_PRICE_WEI`。当前默认值是 `1000000000`，即 1 gwei。

因此必须看新增的第二条日志：

```text
[Gas] Mock Live Warmup: effective sender fee floor=1.0 gwei
```

这条日志比 preview banner 更接近真实发送成本，也是解释“为什么明明 preview 只有 0.1 gwei，但交易还是按更高成本失败/成功”的唯一有效依据。

### 2.2.2 top-up 后单次 `getBalance` 仍可能是旧值

BNB Testnet 公共 RPC 常见负载均衡后端读写不同步问题：

1. sponsor 转账已经被某个后端确认进块。
2. 下一次 `getBalance` 可能打到另一个同步略慢的后端。
3. 结果是“交易已成功，余额读面仍是旧值”。

所以现在 warmup 里不能只信 top-up 后的单次 `getBalance`，而是必须做 native balance convergence polling，直到余额达到目标值或轮询超时。

判读方式：

1. 如果出现 `[NativeTopUp] ... after=0.01 ETH desired=0.01 ETH`，说明余额最终已收敛。
2. 如果只出现一次 sponsor 转账但最终仍打印 `native top-up capped by sponsor balances`，先检查 sponsor 真实余额，再检查是否只是 RPC 读面仍未收敛。
3. 不要再把“top-up 后第一下余额不变”直接判成 sponsor 不够钱。

### 2.2.3 `FreshBorrowerSweep skipped` 不能直接等价于 env 丢失

之前最容易误导人的点是 sweep skip 文案。当前需要明确区分三类情况：

1. auto-manage 本身关闭。
2. mnemonic 确实缺失。
3. wrapper env 已存在，但本轮根本没有实际分配 managed borrower，因此也不会生成 state file。

所以如果日志只说 sweep skipped，不能直接得出“wrapper 没注入 `LIVE_FRESH_BORROWER_MNEMONIC` / `LIVE_FRESH_BORROWER_STATE_FILE`”的结论。正确判读顺序是：

1. 先看 run dir 里是否有 `fresh.env`。
2. 再看 warmup / baseline 日志里是否出现 `mode=managed`。
3. 只有在 wrapper env 缺失、且 managed borrower 未启用、且 state file 不存在三者结合时，才可判定为 env/配置问题。

### 2.2.4 warmup 通过，不等于整条 platform baseline 已通过

当前最新状态就是这个例子：

1. warmup 已通过。
2. normal runtime 分支已通过。
3. 整条 `test:live:platform-baseline:bnb-testnet` 仍失败在 guarantee default branch。

因此如果日志里已经出现 `✅ live-warmup-bnb-testnet PASSED`，但整体退出码仍非 0，必须继续定位后续分支，不要回头重复修 warmup。

## 3. 先补 relayer 原生 BNB

如果你已经看到 `native top-up insufficient`、`insufficient funds for gas * price + value`，不要直接重跑 reward / guarantee；先补 relayer：

```bash
set -a && source .env && set +a && \
DEBUG_NATIVE_MIN_ETH=0.01 \
DEBUG_NATIVE_SPONSOR_RESERVE_ETH=0.0002 \
pnpm -s exec hardhat run scripts/debug/fund-live-native.ts --network bnbTestnet
```

这一步的测试内容不是业务断言，而是保证 relayer 侧有足够原生 BNB 去 sponsor fresh borrower 的首轮 approve / deposit / finalize / repay。

补充（借款资产侧兜底）：

1. 当前 BNB warmup/runtime 脚本在执行 `reserveForLending` 前，会再次复核 lender 的借款资产余额。
2. 如果 lender 在该时点余额不足，脚本会从 relayer 自动补齐本轮 reserve 缺口后再重试 staticCall。
3. 因此当日志出现 `reserveForLending staticCall reverted` 且解码为 `ERC20InsufficientBalance` 时，根因通常是“本轮 reserve 时点 lender 余额漂移/不足”，而不是 RPC 抖动。
4. 若自动补齐后仍失败，应优先排查 relayer 的借款资产余额是否低于本轮 `borrowAmount`，再继续 gate。

## 3.1 网络抖动重试策略（标准：RPC 池 + 自动切换）

BNB Testnet live 统一采用“RPC 池 + 自动切换”模式，不再使用“单 RPC 失败后手工切换”的旧流程。

### 3.1.1 RPC 池变量（必配）

建议在 `.env` 或执行前导出以下变量：

1. `LIVE_RPC_POOL`

示例（官方公开 testnet 端点）：

```bash
export LIVE_RPC_POOL="https://bsc-testnet.bnbchain.org,https://bsc-testnet-dataseed.bnbchain.org,https://bsc-prebsc-dataseed.bnbchain.org"
```

禁止在本 runbook 流程中依赖 `.env` 里的 Alchemy `BNB_TESTNET*` URL；统一只使用 `LIVE_RPC_POOL`，避免因 App 未开通 BNB_TESTNET 导致 `HH110`。

> 当前执行器会在 bnbTestnet 上自动轮换，不需要手工改命令。

### 3.1.1.1 零污染启动（推荐）

当本地终端历史会话可能残留 `BNB_TESTNET_RPC_URL` / `BSC_TESTNET_RPC_URL` / `BNB_TESTNET_URL` / `BSC_TESTNET_URL` 时，建议使用零污染入口，先清空相关变量再加载 `.env` 并执行 Layer-A 流式 gate：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a:stream:cleanenv
```

该命令会：

1. 清空可能污染 RPC 选择的历史环境变量。
2. 重新加载 `.env`。
3. 以 `LIVE_RPC_POOL` 为统一入口运行 Layer-A stream。

### 3.1.2 自动切换行为

在 `run-single-live-with-sweep.sh` 路径下：

1. 每次 attempt 前会选取池内一个端点。
2. 若命中网络可重试错误，则下一次 attempt 自动切到下一个端点。
3. 日志中会输出当前选中的端点，例如：

```text
[RPCPool] attempt=1 selected=https://bsc-testnet.bnbchain.org
[RPCPool] attempt=2 selected=https://bsc-testnet-dataseed.bnbchain.org
```

### 3.1.3 重试预算（建议）

```bash
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS=5
export LIVE_NETWORK_MAX_ATTEMPTS=8
export LIVE_NETWORK_BASE_DELAY_MS=2500
```

### 3.1.4 网络错误与业务错误分离

仅“网络可重试错误”会触发自动切换与重试（例如超时、连接重置、`code: -32001`）。

业务断言失败（例如 `MissingRole`、`AccessControl`、参数错误、状态不一致）不应通过增加重试掩盖，必须先修复再重跑。

### 3.1.5 `replacement transaction underpriced` 根因与规避

该错误在 BNB live 上高频出现的典型根因不是“单纯 gas 太低”，而是：

1. 某次 attempt 因 `LIVE_NETWORK_ATTEMPT_TIMEOUT_MS` 超时被判失败。
2. 但超时只会结束当前等待，不会中止已经在链上发送中的交易流程。
3. 下一次 attempt 立即启动后，同一 signer 又发送同类交易（常见是 `approve`）。
4. 节点把它识别为同 nonce 替换交易；若 gas 提升不满足替换阈值，就报 `replacement transaction underpriced`。

当前默认策略（已落地到重试器）：

1. `ETIMEDOUT` 默认不自动重试（避免超时后并发 attempt）。
2. 仅在明确需要时，才手动开启 `LIVE_NETWORK_RETRY_ON_TIMEOUT=1`。

推荐运行参数：

```bash
LIVE_NETWORK_ATTEMPT_TIMEOUT_MS=0
LIVE_NETWORK_RETRY_ON_TIMEOUT=0
```

说明：

1. `LIVE_NETWORK_ATTEMPT_TIMEOUT_MS=0` 表示禁用 attempt 级超时，优先保证单轮写交易完整收敛。
2. 若必须设置超时，仍建议保持 `LIVE_NETWORK_RETRY_ON_TIMEOUT=0`，避免自动并发重入。

再次遇到该错误时的处理顺序（强制）：

1. 先停止当前批量重跑，避免继续推高 pending nonce 冲突。
2. 先做单项重跑，不要直接回到全量 gates。
3. 先执行本 runbook 的 pending nonce 体检（见下文 3.1.1），确认 `pendingNonce - latestNonce` 是否回落，再继续。

### 3.1.6 重跑粒度（强制：先单项，后全量）

失败后先按“失败 step / 失败 case”单项重跑，不要立刻全量 10-gate。

标准流程：

1. 从最新 `release-gates.log` 定位 `step failed:` 与失败 case。
2. 使用 `run-single-live-with-sweep.sh` 包装器单跑该 case（包装器内置 RPC 池轮换 + 网络重试 + 退出 sweep）。
3. 单项通过后，再决定是否回到层级 baseline 或全量 release-gates。

标准模板（推荐直接复制）：

```bash
LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG=1 \
LIVE_TEST_NETWORK=bnbTestnet \
LIVE_NETWORK_ATTEMPT_TIMEOUT_MS=0 \
LIVE_RUNNER_NETWORK_MAX_ATTEMPTS=4 \
LIVE_RPC_POOL="https://bsc-testnet.bnbchain.org,https://bsc-testnet-dataseed.bnbchain.org,https://bsc-prebsc-dataseed.bnbchain.org" \
zsh scripts/tests/tools/run-single-live-with-sweep.sh <label> -- \
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/<case>.ts --network bnbTestnet
```

示例（`reserve cancel restore` 失败后只跑该项）：

```bash
LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG=1 \
LIVE_TEST_NETWORK=bnbTestnet \
LIVE_NETWORK_ATTEMPT_TIMEOUT_MS=0 \
LIVE_RUNNER_NETWORK_MAX_ATTEMPTS=4 \
LIVE_RPC_POOL="https://bsc-testnet.bnbchain.org,https://bsc-testnet-dataseed.bnbchain.org,https://bsc-prebsc-dataseed.bnbchain.org" \
zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-cancel-reserve -- \
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-cancel-reserve.ts --network bnbTestnet
```

注意：

1. 不要优先用“裸 `pnpm exec hardhat run ...`”排障，它可能绕开统一 RPC 池选择与 cleanup，增加 `HH110` / 单节点抖动概率。
2. 只有在单项连续通过后，才进入同层 baseline 或全量 release-gates 复验。
3. 继续保持“只在 EXIT cleanup 执行 sweep”的纪律，不额外插入手工 sweep。

## 3.1.1 部署前先查 pending nonce 堵塞（强烈建议）

如果部署命令长时间停在“备份钱包资产”之后没有新输出，且进程仍在运行，常见原因是部署账户存在 pending nonce 堵塞：

1. 同一账户历史交易在 mempool 中未确认。
2. 新交易必须按 nonce 串行，后续 nonce 会被前序 pending 挡住。

部署前先执行一次 nonce 体检（只读）：

```bash
set -a && source .env && set +a && node - <<'NODE'
const { ethers } = require('ethers');
const poolRaw = process.env.LIVE_RPC_POOL || '';
const pool = poolRaw.split(',').map((x) => x.trim()).filter(Boolean);
const rpc = pool[0]
	|| process.env.BNB_TESTNET_URL
	|| process.env.BSC_TESTNET_URL;
const addr = process.env.DEPLOYER_ADDRESS || '0xe8a87c766E5612E47dCbb403b1551108910E12D3';
(async () => {
	const p = new ethers.JsonRpcProvider(rpc);
	const latest = await p.getTransactionCount(addr, 'latest');
	const pending = await p.getTransactionCount(addr, 'pending');
	console.log(JSON.stringify({ latestNonce: latest, pendingNonce: pending, pendingGap: pending - latest }, null, 2));
})();
NODE
```

判据：

1. `pendingGap = pendingNonce - latestNonce`。
2. `pendingGap = 0` 才进入部署。
3. `pendingGap > 0` 先解堵（提高手续费替换同 nonce 交易，或等待旧 pending 确认），再部署。

解堵完成后，再执行部署与后续 live 全量流程。

## 3.2 部署侧修复（ORDER_ENGINE / SETTLEMENT_MANAGER）

当 live 日志出现以下任一信号时，先做部署侧修复，再跑 baseline / release gates：

1. `SSOT_DEPLOYMENT_MISMATCH`（尤其是 `ORDER_ENGINE_VIEW_ADAPTER_DIVERGENCE`）。
2. `SettlementManager -> ORDER_ENGINE` 读桥路由不一致（`getLoanOrderForView` 可读、`getOrderTotalDueForView` 不可读）。
3. guarantee/runtime 断言与架构路径不一致，且已排除业务参数错误。

标准修复命令：

```bash
set -a && source .env && set +a && pnpm -s run deploy:repair:order-engine:bnb-testnet
```

修复脚本会执行：

1. 对齐 deploy output 与 Registry 的 `ORDER_ENGINE` / `SETTLEMENT_MANAGER` 路由。
2. 升级 `ORDER_ENGINE` 与 `SETTLEMENT_MANAGER` 代理实现（保持 proxy 地址不变）。
3. 执行 `SettlementManager -> ORDER_ENGINE` 桥接探测并输出分类；分类必须为 `ok`。

> 说明：实现字节码 hash 与本地 artifact hash 可能因编译元数据不同而不一致；BNB live 以桥接探测结果和真实 funds-flow 通过性为准。

## 3.3 Guarantee 双阶段严格通过判据（已验证）

当前 guarantee flow 已按“双阶段严格”执行：

1. 阶段 A（账本严格）：repay 交易成功、order.repaidAmount 增长、debt/guarantee 状态满足预期。
2. 阶段 B（View 严格）：先看初始窗口收敛；若未收敛，主动触发 LoanFlowPushManager.retryRepay 做补偿推送；再看补偿窗口；仍未收敛才最终 fail。

执行原则（必须按此理解）：

1. 关键不是“被动等更久”，而是“先做账本严格验证，再对 View 不一致执行主动修复”。
2. `retryRepay` 的角色是主动补偿推送，不是装饰性重试；它的目标是在 repay 账本已经成功后，修复 loan-flow/view mirror 未及时收敛的问题。
3. 如果问题根因是“推送没有发生”或“推送发生但失败”，单纯等待更长 block 窗口不会自愈；即使等待 100 blocks，也可能仍然不收敛；必须执行一次补偿推送。
4. 因此，严格模式下的正确顺序是：阶段 A 必须通过 -> 阶段 B 先等短窗口 -> 不收敛则主动 `retryRepay` -> 再等短窗口 -> 仍不收敛才判失败。

默认窗口与放宽口径：

1. 默认初始窗口为 10 blocks。
2. 默认补偿后窗口为 5 blocks。
3. block 窗口可以放宽，但只能作为兜底，不是主方案。
4. 推荐顺序固定为：先等 10 blocks；失败后执行一次 `retryRepay`；再等 5 blocks。
5. 不建议把“直接把窗口放大到很长”当作主修复手段，因为这只能掩盖 view push 未触发或触发失败的问题，不能保证收敛。

运维语义（避免误解）：

1. 这里不是“补业务角色”，而是使用现有的 `ACTION_VIEW_PUSH` 运维能力执行补偿推送。
2. `LoanFlowPushManager.retryRepay` 本身就是为 keepers / off-chain repair services 预留的 retry 入口，并要求调用方具备 `ACTION_VIEW_PUSH`。
3. BNB live 框架已经把 relayer 的 `ACTION_VIEW_PUSH` 作为标准 runtime / strict 校验项之一；这属于既有运维能力，不是为 guarantee flow 临时发明的新权限路径。

证据：

1. `src/Vault/modules/LoanFlowPushManager.sol` 中提供 `retryRepay`，并对调用方执行 `ACTION_VIEW_PUSH` 检查。
2. `scripts/tests/live-test/networks/bnb-testnet/core/_fundsFlowLive.ts` 中，relayer 已纳入 `ACTION_VIEW_PUSH` 的授权/严格校验路径。
3. `scripts/tests/live-test/networks/bnb-testnet/cases/live-guarantee-flow.ts` 中，阶段 B 的默认流程就是“先等 10 blocks -> 不收敛则 retryRepay -> 再等 5 blocks -> 再失败才抛错”。

已验证样本（age=10 连续 5 次）：

- 目录：`scripts/tests/logs/manual-bnb-guarantee-flow-age10-strict2-5runs-r2-20260407214455/`
- 结果：5/5 全通过。

稳定通过模式（重点）：

1. 日志出现 `after-guarantee-repay-stageB-initial`。
2. 未出现 `LoanFlowRetry` 也可直接通过。
3. 未出现 `[Retry] network error ...`（即本轮没有走网络重试链路）。

解释：

1. “初始链路本身稳定 + 新增框架兜底”是正常且目标状态。
2. `retryRepay` 是严格模式下的修复兜底，不是每轮必须触发的步骤。
3. 只要阶段 A 和阶段 B 初始窗口都通过，即可判定该轮严格通过。

## 4. 推荐执行顺序

### 4.1 strict 环境基线（固定，不要省略）

BNB 真链最终放行只接受 strict 模式证据。执行任何最终放行命令前，固定先设置：

```bash
set -a && source .env && set +a

export LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG=1
export LIVE_NETWORK_MAX_ATTEMPTS=6
export LIVE_NETWORK_BASE_DELAY_MS=2000
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS=4
export LIVE_AUTO_GRANT_RUNTIME_ROLES=0
export LIVE_FAIL_ON_MISSING_RUNTIME_ROLES=1
export LIVE_STRICT_FEE_ROUTER_GATE=1
export LIVE_STRICT_RESERVE_SINGLE_MODEL=1
export LIVE_STRICT_RESERVE_EXPECTED_MODEL=auto
export LIVE_STRICT_BLOCKS_ONLY_DATAPUSH=1
export LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS=6
export LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS=1200
export LIVE_BNB_MIN_GAS_PRICE_WEI=1000000000
```

解释：

1. `LIVE_AUTO_GRANT_RUNTIME_ROLES=0` 与 `LIVE_FAIL_ON_MISSING_RUNTIME_ROLES=1` 用于禁止脚本运行期自补角色。
2. `LIVE_STRICT_FEE_ROUTER_GATE=1` 用于把 fee publish-ready 由 notice 提升为真实门禁。
3. `LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG=1` 是当前 BNB reward baseline 的兼容前提，未显式开启时不要把 reward 失败直接解释成协议回归。
4. `LIVE_STRICT_RESERVE_SINGLE_MODEL=1` 启用 reserve/cancel 单模型严格校验；具体期望模型由 `LIVE_STRICT_RESERVE_EXPECTED_MODEL` 指定（`transfer | bookkeeping | pool-only`）。
5. BNB Testnet 上 reserve 可能受池内库存影响在 `transfer` 与 `bookkeeping` 间切换，建议设置 `LIVE_STRICT_RESERVE_EXPECTED_MODEL=auto`，由脚本识别本轮模型并对 cancel 做同模型严格校验。
6. `LIVE_STRICT_BLOCKS_ONLY_DATAPUSH=1` 要求 blocks-only 路径缺失关键 DataPush/事件时直接失败，不再只记告警。
7. `LIVE_BNB_MIN_GAS_PRICE_WEI=1000000000` 把 BNB live 的 gas floor 固定到 1 gwei，避免 `tip cap ... less than block base fee` 与链最小 gas 拒绝。

### 4.2 必跑 strict 命令（最终放行清单）

先跑部署一致性审计，再跑各域独立证据，最后跑统一的全仓关键门禁。推荐顺序固定如下：

```bash
set -a && source .env && set +a

export LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG=1
export LIVE_NETWORK_MAX_ATTEMPTS=6
export LIVE_NETWORK_BASE_DELAY_MS=2000
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS=4
export LIVE_AUTO_GRANT_RUNTIME_ROLES=0
export LIVE_FAIL_ON_MISSING_RUNTIME_ROLES=1
export LIVE_STRICT_FEE_ROUTER_GATE=1
export LIVE_STRICT_RESERVE_SINGLE_MODEL=1
export LIVE_STRICT_RESERVE_EXPECTED_MODEL=auto
export LIVE_STRICT_BLOCKS_ONLY_DATAPUSH=1
export LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS=6
export LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS=1200
export LIVE_BNB_MIN_GAS_PRICE_WEI=1000000000

pnpm -s run debug:audit-order-engine-deployment-consistency:bnb-testnet
pnpm -s run test:live:platform-baseline:bnb-testnet
pnpm -s run test:live:fee-baseline:bnb-testnet
pnpm -s run test:live:reward-baseline:bnb-testnet
pnpm -s run test:live:guarantee-baseline:bnb-testnet
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-cancel-reserve -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-cancel-reserve.ts --network bnbTestnet
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-withdraw-collateral -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-withdraw-collateral.ts --network bnbTestnet
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-lending-engine-view -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-lending-engine-view.ts --network bnbTestnet
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-liquidation -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-liquidation.ts --network bnbTestnet
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-blocks-only-liquidation -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-blocks-only-liquidation.ts --network bnbTestnet
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-ops-extension-modules -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-ops-extension-modules.ts --network bnbTestnet
pnpm -s run test:live:release-gates:bnb-testnet:strict
```

分层执行模板（推荐）：

```bash
# Layer-A: Correctness Strict（默认放行门）
pnpm -s run test:live:release-gates:bnb-testnet:layer-a

# Layer-B: Architecture Strict（专项一致性门）
pnpm -s run test:live:release-gates:bnb-testnet:layer-b
```

流式留痕版本：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a:stream
pnpm -s run test:live:release-gates:bnb-testnet:layer-b:stream
```

兼容说明：

1. `test:live:release-gates:bnb-testnet:strict` 已映射到 Layer-A。
2. `test:live:release-gates:bnb-testnet:strict:stream` 已映射到 Layer-A 流式版本。

如果只需要执行“最终一体化门禁”，可以直接使用：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:strict
```

但正式放行仍要求保留前面各域的独立证据，不建议只留最后一步。

### 4.3 当前 release gate 的十个阻断步骤（全仓关键域）

`test:live:release-gates:bnb-testnet:strict` 当前会阻断以下十步，任何一步失败都直接阻断放行：

1. `platform full baseline`
2. `fee full baseline`
3. `reward full baseline`
4. `guarantee full baseline`
5. `reserve cancel restore`
6. `withdraw collateral`
7. `lending engine view ssot`
8. `legacy liquidation funds-chain`
9. `blocks-only 收尾链路（closeout chain）`
10. `ops extension modules`

这十步分别对应平台主链路、费用分账、奖励域、保证金域、reserve 状态机、提现路径、订单读侧 SSOT、legacy 清算路径、blocks-only 产品线，以及扩展运维模块权限门禁（含 pause/unpause、batchDistribute、GuaranteeFundManager 直入口保护）。

### 4.3.1 分层执行建议（避免 strict 误报）

为兼顾严格性与准确性，建议把十项 gate 分两层执行：

1. Layer-A（Correctness Strict，默认放行门）
2. Layer-B（Architecture Strict，专项一致性门）

Layer-A：

1. 以协议正确性不变量为阻断条件。
2. 允许已知、可解释的终态差异。
3. 未知状态迁移、未知资金变化直接失败。

Layer-B：

1. 强制架构路径唯一性（例如 reserve 必须 transfer 模式）。
2. 仅在隔离账户和隔离状态下执行，不与共享 live 基线混跑。

对 reserve/cancel 的具体建议：

1. 默认放行门（Layer-A）使用 `LIVE_STRICT_RESERVE_EXPECTED_MODEL=auto`。
2. 架构专项门（Layer-B）使用 `LIVE_STRICT_RESERVE_EXPECTED_MODEL=transfer`，并在独立轮次执行。
3. 不建议在共享 testnet 轮次把 transfer 唯一路径作为默认阻断，否则容易把环境噪声误判为协议错误。

对 blocks-only pre-maturity guard 的具体建议：

1. Layer-A 使用 `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=0`，但不是“立即放过”：先做 pre-maturity 轮询探测，等待 finalize 广播与读面收敛后再判定。
2. Layer-B 默认也使用 `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=0`；BNB Testnet 真链存在广播/打包延迟与块推进抖动，finalize 后在数个区块后才被观测到的情况是常态，不能把“单次瞬时读数未命中 pre-maturity 窗口”当作默认阻断条件。
3. 轮询窗口建议显式配置：`LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS`（默认 6）与 `LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS`（默认 1200ms）。只有在轮询窗口内确认“before-maturity 调用应回退”的 guard 成功，才记为 pre-maturity 已验证。
4. historical block proof 的判定规则必须固定为三态，不允许再把所有异常都记为“已确认 revert”：
	1. 只把明确带 revert 特征的错误记为 `PreMaturityProof.Confirmed`。
	2. provider / RPC 抛出的其余非 revert 型错误单列为 `PreMaturityProof.RpcUnstable`。
	3. 如果 finalizeBlock 本身已经不早于 maturityBlock，则记为 `PreMaturityProof.SkippedMatured`。
5. `RpcUnstable` 不是通过证据，也不是业务失败证据；它只表示该次 historical `eth_call` 没能形成可审计的 pre-maturity revert 证明，需要结合后续 matured-path 断言和整轮日志一起判断。

若轮询窗口结束仍只观察到 matured/canSettle 状态：
	1. `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=0` 时记录 `notice`，继续执行 matured-path 不变量与对齐断言。
	2. `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=1` 时按 strict 失败处理。
6. 仅在“可控隔离轮次 + 明确固定时间窗 + 目标是专项验证 pre-maturity guard”这三项同时满足时，才建议启用 `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=1`；该轮证据单独归档，不并入常规放行结论。
7. 两层都必须保持 term/状态机/DataPush 的其余严格断言，不允许整体降级为告警模式。

### 4.4 通过条件（最终放行）

最终放行必须同时满足：

1. `debug:audit-order-engine-deployment-consistency:bnb-testnet` 输出分类为 `ok`，不能是 `deployment-ssot-mismatch`。
2. 所有独立 strict 命令退出码为 0。
3. `test:live:release-gates:bnb-testnet:strict` 最终输出 `PASS`，且 summary 十个阶段全部为 `PASS`。
4. 关键日志中必须出现 strict 证据：
	1. `AutoGrantRuntimeRoles=false`
	2. `LIVE_FAIL_ON_MISSING_RUNTIME_ROLES=1` 对应严格缺角色失败逻辑已启用
	3. fee gate 未被 “skipping strict publish-ready assertions” 放宽
5. `test:live:release-gates:bnb-testnet:strict:stream` 作为主留痕证据时，必须同时满足：
	1. `summary.txt` 包含 `RC=0`
	2. `release-gates.log` 出现 `=== Live Release Gates Summary ===`
	3. Summary 中十步均为 `PASS`，且不存在 `FAIL ` / `step failed:`
	4. `OK.txt` 存在且 `FAILED.txt` 不存在
6. 不允许把网络瞬态重试后的成功与部署错配修复后的成功混写为同一轮证据；修复部署后必须重新跑 strict 轮。
7. 未完成轮（例如只出现 warmup 或 `summary.txt` 没有 `RC=`）不得作为放行证据。

### 4.5 留痕要求（必须保留）

最终放行轮至少保留以下证据目录与内容：

1. 单独 `RUN_DIR`，例如 `scripts/tests/logs/bnb-funds-signoff-<timestamp>/`。
2. 每一步的独立日志文件，建议命名为：
	1. `01-deployment-audit.log`
	2. `02-platform-baseline.log`
	3. `03-fee-baseline.log`
	4. `04-reward-baseline.log`
	5. `05-guarantee-baseline.log`
	6. `06-cancel-reserve.log`
	7. `07-withdraw-collateral.log`
	8. `08-lending-engine-view.log`
	9. `09-liquidation.log`
	10. `10-blocks-only-liquidation.log`
	11. `11-ops-extension-modules.log`
	12. `12-release-gates.log`
3. `summary.txt`，逐行记录每步 `PASS/FAIL` 与日志路径。
4. 本轮 strict 环境变量快照，至少保留：
	1. `LIVE_AUTO_GRANT_RUNTIME_ROLES`
	2. `LIVE_FAIL_ON_MISSING_RUNTIME_ROLES`
	3. `LIVE_STRICT_FEE_ROUTER_GATE`
	4. `LIVE_NETWORK_MAX_ATTEMPTS`
	5. `LIVE_RUNNER_NETWORK_MAX_ATTEMPTS`
5. 本轮执行使用的 Registry / key address / network 标识输出，便于后审计对账。

推荐留痕模板：

```bash
set -a && source .env && set +a

export LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG=1
export LIVE_NETWORK_MAX_ATTEMPTS=6
export LIVE_NETWORK_BASE_DELAY_MS=2000
export LIVE_RUNNER_NETWORK_MAX_ATTEMPTS=4
export LIVE_AUTO_GRANT_RUNTIME_ROLES=0
export LIVE_FAIL_ON_MISSING_RUNTIME_ROLES=1
export LIVE_STRICT_FEE_ROUTER_GATE=1
export LIVE_STRICT_RESERVE_SINGLE_MODEL=1
export LIVE_STRICT_RESERVE_EXPECTED_MODEL=auto
export LIVE_STRICT_BLOCKS_ONLY_DATAPUSH=1
export LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS=6
export LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS=1200
export LIVE_BNB_MIN_GAS_PRICE_WEI=1000000000

RUN_DIR="scripts/tests/logs/bnb-funds-signoff-$(date +%Y%m%d%H%M%S)"
mkdir -p "$RUN_DIR"

env | grep '^LIVE_' | sort > "$RUN_DIR/00-env.txt"

set -o pipefail
pnpm -s run debug:audit-order-engine-deployment-consistency:bnb-testnet 2>&1 | tee "$RUN_DIR/01-deployment-audit.log"
pnpm -s run test:live:platform-baseline:bnb-testnet 2>&1 | tee "$RUN_DIR/02-platform-baseline.log"
pnpm -s run test:live:fee-baseline:bnb-testnet 2>&1 | tee "$RUN_DIR/03-fee-baseline.log"
pnpm -s run test:live:reward-baseline:bnb-testnet 2>&1 | tee "$RUN_DIR/04-reward-baseline.log"
pnpm -s run test:live:guarantee-baseline:bnb-testnet 2>&1 | tee "$RUN_DIR/05-guarantee-baseline.log"
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-cancel-reserve -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-cancel-reserve.ts --network bnbTestnet 2>&1 | tee "$RUN_DIR/06-cancel-reserve.log"
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-withdraw-collateral -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-withdraw-collateral.ts --network bnbTestnet 2>&1 | tee "$RUN_DIR/07-withdraw-collateral.log"
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-lending-engine-view -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-lending-engine-view.ts --network bnbTestnet 2>&1 | tee "$RUN_DIR/08-lending-engine-view.log"
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-liquidation -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-liquidation.ts --network bnbTestnet 2>&1 | tee "$RUN_DIR/09-liquidation.log"
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-blocks-only-liquidation -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-blocks-only-liquidation.ts --network bnbTestnet 2>&1 | tee "$RUN_DIR/10-blocks-only-liquidation.log"
LIVE_TEST_NETWORK=bnbTestnet zsh scripts/tests/tools/run-single-live-with-sweep.sh bnb-ops-extension-modules -- pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-ops-extension-modules.ts --network bnbTestnet 2>&1 | tee "$RUN_DIR/11-ops-extension-modules.log"
pnpm -s run test:live:release-gates:bnb-testnet:strict 2>&1 | tee "$RUN_DIR/12-release-gates.log"

echo "RUN_DIR=$RUN_DIR"
```

说明：

1. 最后一条 integrated gate 不是为了替代前面各域证据，而是为了证明“在同一 strict 配置下，全仓关键域十个阻断步骤可以连续通过”。
2. 如果某一步因为部署修复或角色修复而重跑，必须生成新的 `RUN_DIR`，不要覆盖前一轮证据。
3. 若执行 Layer-B 架构专项门，必须独立保留证据目录，并与 Layer-A 证据分开归档。

## 5. 唯一 Sweep 策略（推荐）

只保留一个 sweep 入口：`EXIT cleanup`。这样即使中途失败，也会在退出时自动回流。

推荐模板（单轮只执行一次 sweep）：

```bash
set -a && source .env && set +a
RUN_DIR="scripts/tests/logs/manual-bnb-live-$(date +%Y%m%d%H%M%S)"
mkdir -p "$RUN_DIR"

cleanup() {
	set +e
	pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/sweep-fresh-borrowers.ts --network bnbTestnet \
		| tee "$RUN_DIR/sweep.log"
}
trap cleanup EXIT

pnpm -s run test:live:platform-runtime-baseline:bnb-testnet
pnpm -s run test:live:platform-observability-evidence:bnb-testnet
pnpm -s run test:live:fee-baseline:bnb-testnet
pnpm -s run test:live:reward-baseline:bnb-testnet
pnpm -s run test:live:guarantee-baseline:bnb-testnet
pnpm -s run test:live:release-gates:bnb-testnet
```

判据：

1. 全轮只出现一次 sweep 日志（退出时）。
2. `sweep.log` 中包含 `FreshBorrowerSweep` 汇总。
3. 不再额外插入 `live-sweep` stage 或手工补跑 sweep。

补充判读：

1. `FreshBorrowerSweep skipped` 不是 wrapper env 缺失的充分证据。
2. 若本轮未分配 managed borrower，state file 可能根本不会创建，此时 sweep skip 是预期现象。
3. 只有当 `fresh.env` 缺失、managed borrower 没有被分配、且 state file 也缺失时，才应继续排查 wrapper 注入链路。

## 6. BNB Testnet 上线前最低验收口径

要把当前系统推进到 BNB Testnet 上线验证，最低建议口径是：

1. platform runtime baseline 通过。
2. platform observability evidence 通过。
3. fee baseline 通过。
4. reward baseline 通过。
5. guarantee baseline 通过。
6. release gate 通过。
7. sweep 日志确认 fresh borrower 残余原生 BNB 与 mock ERC20 已回流，没有持续吞 sponsor 预算。

如果第 4 或第 5 步失败，并且错误是 `native top-up insufficient` 或 `insufficient funds for gas * price + value`，优先视为 relayer/sponsor 原生 BNB 预算问题，而不是 reward / guarantee 业务回归。