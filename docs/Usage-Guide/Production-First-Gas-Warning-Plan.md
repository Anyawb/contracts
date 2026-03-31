# 生产优先 Gas Warning 迁移方案

> 口径：以 Arbitrum Sepolia 实际部署面为准。优先清理不影响生产 ABI / storage / 签名兼容 / 常量兼容的 warning；对进入稳定面的 warning 仅做迁移规划，不为“清 warning”直接改动。

## 已直接修复

- `src/monitor/DegradationStorage.sol`
  - `registerHealthDetailsIfNew(bytes32,string,address)` 的 `details` 已由 `memory` 改为 `calldata`。
- `src/Mocks/**`
  - 已清理本轮可直接修的 `gas-struct-packing`、`gas-small-strings`、`gas-calldata-parameters`。
  - 处理方式包括：mock-only struct 重排、缩短测试文案、`memory -> calldata`、将 `abi.encodeWithSignature` 改为 `abi.encodeCall`。

## 保守项迁移方案

### 1. ABI / 返回 tuple 兼容

- `src/Vault/view/modules/BatchView.sol`
  - `IHealthViewBatch.ModuleHealth` 出现在外部返回值中。
  - 风险：重排字段会改变 tuple ABI。
  - 迁移建议：
    - 若未来必须优化，新增 `ModuleHealthV2` 或新增返回接口；
    - 保留旧接口至少一个版本周期；
    - 前端 / SDK / indexer 同步切换后再考虑下线旧接口。

- `src/Vault/view/modules/HealthView.sol`
  - `ModuleHealth` 出现在 `getModuleHealthWithMeta` 返回值中。
  - 风险：同上，属于稳定 view ABI。
  - 迁移建议：同 `BatchView`，通过 V2 struct / V2 getter 平滑迁移。

### 2. Upgrade-safe storage 布局

- `src/Governance/CrossChainGovernance.sol`
  - `Proposal` 为生产 storage struct，且通过 `public proposals` 暴露读取面。
  - 风险：重排既影响 storage layout，也可能影响 ABI 读取结果。
  - 迁移建议：
    - 不在原 struct 上重排；
    - 若必须优化，新增并行存储结构或新模块承载；
    - 需要明确迁移脚本、回填逻辑和读路径兼容期。

- `src/access/AssetWhitelist.sol`
  - `AssetInfo` 注释已明确“Do not reorder for packing”。
  - 风险：升级存储布局破坏。
  - 迁移建议：仅通过新增字段 / 新映射 / 新模块扩展，不重排既有字段。

- `src/libraries/SettlementReserveLib.sol`
  - `LendReserve` 实际存放在生产合约 `VaultBusinessLogic` 的 storage mapping 中。
  - 风险：重排会破坏既有 reserve 记录布局。
  - 迁移建议：
    - 若未来需要优化，新增 `LendReserveV2` 存储槽或新 mapping；
    - 增加一次性迁移或懒迁移逻辑；
    - 保留旧数据读兼容直到全部迁移完成。

- `src/monitor/DegradationCore.sol`
- `src/monitor/DegradationStorage.sol`
  - `DegradationEvent` 同时用于存储与外部读取。
  - 风险：既有 ring buffer 数据布局、读路径和跨模块调用同时受影响。
  - 迁移建议：
    - 采用双轨结构：保留旧 `DegradationEvent`，新增 `DegradationEventV2`；
    - 写路径切到 V2，读路径在兼容期内支持 V1/V2；
    - 如有历史事件分析组件，同步升级解码逻辑。

### 3. EIP-712 / 签名兼容

- `src/libraries/SettlementIntentLib.sol`
  - `BorrowIntent` / `LendIntent` 字段顺序已明确为 EIP-712 canonical order。
  - 风险：任何字段重排都会改变 type hash 和签名结果，导致链下 signer 与链上验证失配。
  - 迁移建议：
    - 维持现状，不直接修改；
    - 若未来要优化，新增 `BorrowIntentV2` / `LendIntentV2` 与新的 type string；
    - 同步升级前端签名器、撮合器、回放脚本、测试向量；
    - 在兼容期内同时支持旧签名和新签名验证入口。

### 4. 常量哈希 / 协议标识兼容

- `src/Vault/FeeRouter.sol`
  - `_PUSH_KIND_*` 长字符串参与 `keccak256`，用于 push kind 常量。
  - 风险：缩短字符串会改变常量值，破坏链下和跨模块类型识别。
  - 迁移建议：
    - 不直接修改现有常量；
    - 如需优化，新增新的 kind 常量并为消费方提供双读兼容期。

- `src/constants/DataPushTypes.sol`
  - 多个 `DATA_TYPE_*` 常量由长字符串哈希而来。
  - 风险：改变字符串等于改变协议内 data type id。
  - 迁移建议：
    - 将新类型作为新常量发布，不覆盖旧常量；
    - DataPush 消费方、前端、索引器、报表脚本全部需要同步；
    - 迁移期内允许同一事件写入旧类型和新类型，待消费方完成切换后再下线旧类型。

- `src/constants/ModuleKeys.sol`
  - 模块 key 字符串已经是部署/注册兼容面。
  - 风险：更改字符串会导致 Registry 查找不一致。
  - 迁移建议：禁止为清 gas warning 缩短；若要重命名，只能走“新增 key + 双注册 + 全量迁移 + 下线旧 key”流程。

- `src/registry/RegistryDynamicModuleKey.sol`
  - `_MODULE_KEY_SALT` 参与动态 module key derivation。
  - 风险：变更 salt 会改变所有派生 key。
  - 迁移建议：
    - 保留旧 salt；
    - 若必须升级，显式引入 `v2` salt 与新 derivation path；
    - Registry 侧需要双轨解析或一次性迁移脚本。

### 5. 可观测性 / 链下消费迁移成本

- `src/monitor/DegradationStorage.sol`
  - 预置健康详情文案属于链上 observability 语义。
  - 风险：虽不改 ABI，但会影响监控、前端和测试断言文本。
  - 迁移建议：
    - 若要缩短，先检查前端、监控告警、日志断言是否按原文匹配；
    - 优先将链下依赖改为基于 hash / code，而非基于完整字符串。

- `src/Vault/modules/StatisticsPushManager.sol`
  - 长字符串被编码进失败诊断 payload。
  - 风险：影响链下日志解析和告警展示语义。
  - 迁移建议：
    - 优先引入短 code + 可选 details，而不是直接改现有文本；
    - 先升级消费方，再切生产写入文案。

- `src/core/PriceUpdater.sol`
  - 长字符串进入 `DataPush` / 健康状态相关 payload。
  - 风险：影响监控和外部解析语义。
  - 迁移建议：与 `StatisticsPushManager` 相同，优先用短 code / enum 迁移，而不是原地缩短句子。

- `src/core/LoanNFT.sol`
  - 长字符串位于链上 NFT metadata JSON。
  - 风险：会改变用户可见元数据展示。
  - 迁移建议：仅在明确接受 metadata 文案变化时处理，并同步更新截图、测试快照和前端展示预期。

## 建议执行顺序

1. 继续只修“mock / test-only / calldata-only”这类不进入生产稳定面的 warning。
2. 对每个保守项先补一条注释或迁移说明，明确它属于 ABI / storage / signature / constant / observability 哪一类约束。
3. 真要动保守项时，先提交专项迁移 PR：定义 V2 结构、兼容周期、链下同步范围和回滚方案。