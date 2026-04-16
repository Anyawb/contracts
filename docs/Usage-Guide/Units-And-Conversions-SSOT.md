# Units & Conversions SSOT（按资产原生精度，不统一到 8）

> 这份文档不再只描述“理想口径”，而是同时描述 **当前现状 / 目标状态 / 迁移矩阵 / 执行顺序**。目的不是做概念宣言，而是给合约、脚本、前端、测试提供一份可以直接照着落地的执行文档。

---

## 0) 本文怎么用

- 如果你要理解**当前系统真实在怎么跑**，先看“当前现状”。
- 如果你要理解**迁移后的唯一正确口径**，看“目标状态 SSOT”。
- 如果你要排计划、拆 PR、做影响面确认，直接看“迁移矩阵”和“执行顺序”。
- 如果你看到字段名仍叫 `Value`，不要立即假设它已经完成迁移；先对照本文的“当前现状”和“兼容规则”。
- 当前跨文档主线不把 blocks-only 作为默认发布与验收驱动项；若后续按 trade-like 交割重做，相关单位与估值约束会单独复核。

---

## 1) 当前现状（必须先说清）

### 1.1 当前仓库的真实运行口径

当前主协议已经不再是“价格存储仍以 统一 value 为主语义”的状态。当前真实运行状态更接近下面这句话：

- **单资产 price/value 主路径已经切到按 `assetDecimals` 解释。**
- **跨资产聚合主路径已经统一归一到 18 位 system valuation unit。**
- **剩余固定 `1e8` / 统一 value 依赖主要集中在 reward 与脚本消费层，而不是核心估值与聚合缓存层。**

也就是说，当前系统已经不是“只有少量底层代码显式传递 `assetDecimals`”的阶段，而是：

- 核心 price/value 语义已经完成 asset-native 迁移
- LoanFlow / Statistics 这类核心聚合缓存也已经切到统一 18 位 value unit
- 但 reward 阈值、部分脚本输入和少量兼容注释仍残留固定 `1e8` 假设

### 1.2 当前已经具备的基础能力

下面这些是迁移可以复用的现有基础，不需要从零发明：

- `PriceOracle` 和 `PriceUpdater` 已经保存每个资产的 `assetDecimals`。
- `IPriceOracleRead.getPrice(asset)` 已经返回 `(price, blockNumber, assetDecimals)`。
- `ValuationOracleView`、`PositionView`、`VaultLendingEngine` 等模块已经普遍采用：

$$
value = \frac{amountBaseUnits \times price}{10^{assetDecimals}}
$$

- `PositionView`、`VaultLendingEngine`、`LoanFlowView`、`StatisticsView` 已经把跨资产 value 主口径统一到 18 位 system valuation unit。
- 仍有少量接口与 payload 使用字段名，但核心 debt/value 接口注释已经对齐到共享 18 位口径。

### 1.3 当前尚未完成迁移的关键现实

下面这些地方是当前迁移状态里最需要看清的现实：

- `src/Vault/view/modules/PositionView.sol`、`src/Vault/modules/VaultLendingEngine.sol` 已完成：collateral / debt 聚合 value 已统一到 18 位 system valuation unit
- `src/Vault/modules/LoanFlowPushManager.sol`、`src/Vault/view/modules/LoanFlowView.sol` 已完成主体迁移：借贷流量已改为 asset-native value -> 18 位统一 unit，且 `LoanFlowView.valuationDecimals()` 会显式暴露 decimals
- `src/Vault/modules/StatisticsPushManager.sol`、`src/Vault/view/modules/StatisticsView.sol` 已完成主体迁移：snapshot / delta / datapush 语义都已改成统一 18 位 value unit，且 `StatisticsView.valuationDecimals()` 会显式暴露 decimals
- `src/Reward/**` 中 reward threshold、mint curve、borrow volume 门槛仍大量写死 `1e8`
- `scripts/**` 中大量 seed/live/e2e 脚本仍然 `parseUnits(..., 8)` 或使用旧价格环境变量
- `src/constants/ModuleKeys.sol`、`src/constants/DataPushTypes.sol` 仍残留少量 统一 value 历史注释，不影响当前主计算路径，但会误导阅读者
- debt valuation 读口已经拆成 strict 与 best-effort 两类：兼容的 `getUserTotalDebtValue` / `calculateDebtValue` 当前应按 best-effort 包装理解；自动风险/清算/结算必须使用 strict 读口

与此同时，下面这些 **Phase 1 基础层** 已经在本轮迁移中切到 asset-native 语义：

- `src/core/PriceOracle.sol` 已移除固定 `统一 value` 价格语义，price 改为按 `assetDecimals` 解释
- `src/core/PriceUpdater.sol` 的价格上限校验已按资产 decimals 归一化，不再固定按 8 位判断
- `src/Vault/view/modules/ValuationOracleView.sol` 已改为按 `assetDecimals` 返回 value，`getAssetValueValue` 仅保留历史命名
- `src/libraries/GracefulDegradation.sol` 的稳定币 peg fallback 与价格合理性校验已改为 decimal-aware
- `src/interfaces/IPriceOracle.sol`、`src/interfaces/IPositionViewValuation.sol`、`src/interfaces/ILendingEngineBasic.sol`、`src/interfaces/IPriceOracleAdapter.sol` 已完成对应文档语义迁移

### 1.4 当前现状的一句话结论

**当前系统的真实口径已经进入后半段过渡态：Phase 1 基础估值层与 Phase 2 聚合缓存层已经切到新 SSOT，但 Reward 与脚本消费层仍残留固定 统一 value 依赖。**

因此，这次改造不是“删掉几个 `Value` 命名”这么简单，而是一次**语义迁移**：

- 从：`price/value` 默认固定 8 位
- 改到：`price/value` 默认按资产原生 decimals 解释

---

## 2) 目标状态 SSOT（迁移完成后唯一正确口径）

### 2.1 核心定义

- **数量单位**：`amountBaseUnits`
  - ERC-20 base units
  - `amountBaseUnits = amountHuman * 10^assetDecimals`

- **资产精度**：`assetDecimals`
  - 默认为 ERC-20 `decimals()` 或治理显式配置
  - 在主协议 value SSOT 中，它决定单资产内 amount / price / value 的共同缩放基准

- **价格单位**：`priceUsd`
  - 表示“每 1 个 token 的美元价格”
  - 其精度跟随该资产的 `assetDecimals`

- **价值单位**：`valueUsd`
  - 表示美元估值整数
  - 在单资产场景下，其精度与该资产 `assetDecimals` 保持一致

### 2.2 单资产内部的唯一公式

$$
valueUsd = \frac{amountBaseUnits \times priceUsd}{10^{assetDecimals}}
$$

反向推算：

$$
amountBaseUnits = \frac{valueUsd \times 10^{assetDecimals}}{priceUsd}
$$

实现要求：

- Solidity 一律优先 `Math.mulDiv`
- TS/脚本一律用 bigint，不用浮点

### 2.3 跨资产场景的唯一规则

不同资产的 `valueUsd` **不能直接比较、不能直接相加、不能直接做阈值判断**。

跨资产场景必须先归一化：

1. 先按各自资产精度计算各自 `valueUsd`
2. 选择明确的 `targetDecimals`
3. 执行 `rescale(valueUsd, fromDecimals, targetDecimals)`
4. 再做比较、求和、排序、阈值判断

### 2.3.1 跨资产归一化的取整策略也是 SSOT

归一化时，**不能只说“先 rescale”，还必须同时说清楚取整方向**。否则不同模块会把同一组值做出不同的风险结论。

统一规则如下：

1. **安全侧 / 可得侧 / 可计入侧** 一律向下取整
2. **风险侧 / 必须满足侧 / 最低门槛侧** 一律向上取整
3. **展示和审计** 优先保留原始 `value + decimals`；如果必须降精度展示，默认向下取整，并明确这只是展示值
4. **跨资产聚合** 如果必须把多个资产先压到同一个 `targetDecimals` 再入库，默认各分项先向下取整后再求和；若该聚合值将用于风控下限、准入门槛或 eligibility 判断，则对应门槛值必须向上取整

直接落地到协议语义：

- `collateral`、`seizeable value`、`bonus cap`、`可发放 reward` 这类“系统给用户/给策略的可计入值”，归一化时默认向下取整
- `debt`、`required collateral`、`threshold`、`minimum borrow`、`eligibility line` 这类“系统要求满足的值”，归一化时默认向上取整

换句话说：

- 想证明“用户有多少”时，用 down
- 想证明“用户至少该有多少 / 至少该还多少”时，用 up

这条规则必须进入数学库接口和业务调用约定，不能继续依赖调用方默认理解。

### 2.4 通用数学能力

迁移后的统一基础库必须提供：

- `rescale(value, fromDecimals, toDecimals)`
- `rescaleDown(value, fromDecimals, toDecimals)`
- `rescaleUp(value, fromDecimals, toDecimals)`
- `calcValue(amountBaseUnits, priceUsd, assetDecimals)`
- `calcAmountFromValue(valueUsd, priceUsd, assetDecimals)`
- `normalizeValue(valueUsd, valueDecimals, targetDecimals)`
- `normalizeValueDown(valueUsd, valueDecimals, targetDecimals)`
- `normalizeValueUp(valueUsd, valueDecimals, targetDecimals)`

兼容规则：

- 历史 `rescale` / `normalizeValue` 若保留，默认语义应明确为 `down`
- 任何新写的风控、阈值、清算、reward eligibility 逻辑，不应只调用“默认版”而不显式选择取整方向

### 2.5 历史命名兼容规则

迁移过程中允许保留历史名字，但不允许继续保留历史语义。

- `priceValue`、`valueValue`、`amountValue`、`thresholdValue` 这类字段名可以暂时保留
- 但字段消费侧必须同时知道它对应的 decimals
- 新文档、新接口、新日志优先使用 `priceUsd`、`valueUsd`、`valueDecimals` 等非绑定 8 位的表达

### 2.6 边界说明：不是所有价格接口都必须绑 token decimals

主协议 core value SSOT 的目标是“price/value 跟 assetDecimals 同步”。但仓库里还存在另一类接口：**显式返回 price scale decimals 的外部/RWA 价格接口**。

例如：

- `src/interfaces/IRWAAssetPriceRead.sol`
- `src/interfaces/IRWAPriceOracle.sol`

这一类接口的 `decimals` 表示的是 **price 自己的精度**，不一定等于 token decimals。迁移时不要把这两类语义混为一谈。

简单说：

- **主协议 value SSOT**：目标是 amount / price / value 在单资产内共用 `assetDecimals`
- **外部 price adapter / RWA raw feed**：可以继续显式返回 `priceDecimals`
- 真正进入主协议 value 计算前，必须先完成一次统一归一化

---

## 3) 迁移原则（避免做成半迁移）

### 3.1 先改语义，再改命名

优先级永远是：

1. 修正真实计算路径
2. 修正缓存/聚合/阈值/脚本行为
3. 最后再收敛命名

不要一开始大规模把 `Value` 改名成 `Usd` 却不改真实单位。

### 3.2 先改基础层，再改聚合层，再改业务层

这次不是单个模块局部重构，存在明确依赖顺序：

- 没有统一数学库，就无法稳定改估值
- 估值语义没稳定，LoanFlow / Statistics 的聚合就不可信
- 聚合层没稳定，Reward / Liquidation 的阈值和比较就会继续错

### 3.3 所有跨模块 value 传递必须携带 decimals

以下场景不能再默认“对方知道是几位”：

- datapush payload
- view cache snapshot
- reward threshold/config
- script env / mock price / bootstrap price
- backend adapter / frontend formatter

### 3.4 计算层与展示层必须分离

- 链上、脚本、后端内部都保存原始整数 + decimals
- 只在展示层做 `formatUnits`
- 不允许在中间计算中提前格式化成小数字符串

---

## 4) 迁移矩阵（按层而不是按人脑印象）

### Phase 0. 数学基础层

| 模块/文件 | 当前状态 | 目标状态 | 需要动作 | 优先级 |
| --- | --- | --- | --- | --- |
| `src/libraries/AssetDecimalMath.sol` | 已新增首版基础库，但 `rescale/normalizeValue` 默认仅向下取整，取整策略尚未协议化 | 全仓唯一数学基础库，并显式承载 down/up 归一化规则 | 补齐 `rescaleDown/rescaleUp/normalizeValueDown/normalizeValueUp` 语义与文档 | P0 |
| `test/**` | 已有独立精度库单测，但非整除往返与 up/down 取整覆盖不足 | 对 6/8/18、小数截断、非整除往返、取整方向建稳定单测 | 补齐非整除 round-trip 和 rounding policy 单测 | P0 |

### Phase 1. 估值基础层

| 模块/文件 | 当前状态 | 目标状态 | 需要动作 | 优先级 |
| --- | --- | --- | --- | --- |
| `src/core/PriceOracle.sol` | 已完成：price 改为按 `assetDecimals` 缩放，统一 value 语义已移除 | price 语义切到按 `assetDecimals` 缩放 | 保持后续调用方与文档一致 | P0 |
| `src/core/PriceUpdater.sol` | 已完成：写价与合理性上限校验已切到 asset-native decimals | updater 写入值改为 asset-native decimals | 保持后续调用方与脚本输入一致 | P0 |
| `src/Vault/view/modules/ValuationOracleView.sol` | 已完成：返回 asset-native value，历史名 `getAssetValueValue` 暂存 | 改为真实返回 asset-native value，历史名可暂存 | 后续评估 ABI 命名收敛时机 | P0 |
| `src/libraries/GracefulDegradation.sol` | 已完成：stablecoin fallback、expectedPrice、reasonableness 已 decimal-aware | fallback 也按目标 decimals 归一化 | 保持与上游/下游 value 口径一致 | P0 |
| `src/Vault/view/modules/PositionView.sol` | 已完成：跨资产总抵押价值已统一归一到 18 位 system valuation unit，collateral 侧按 down 归一化 | 保持对外聚合 value 使用统一 18 位口径 | 后续仅在 ABI 收敛阶段评估是否继续清理历史命名 | P1 |
| `src/Vault/modules/VaultLendingEngine.sol` | 已完成：debt value 聚合与注释已切到统一 18 位 system valuation unit | debt value 保持与新 value SSOT 一致 | 后续仅需保持下游调用方文档同步 | P1 |
| `src/Vault/modules/lendingEngine/LendingEngineValuation.sol` | 已完成：统一走数学库并按 debt/risk 侧 up 归一化到 18 位 | 保持统一 valuation math 路径 | 后续仅需防止重新引入 `1e8` 假设 | P1 |
| `src/Vault/modules/lendingEngine/LendingEngineAccounting.sol` | 已完成：与 debt value 缓存链路的 18 位口径已对齐 | 跟随统一 value unit | 后续仅需保持缓存更新链路回归覆盖 | P1 |
| `src/interfaces/IPriceOracle.sol` | 已完成：价格说明已改成 canonical valuation unit | 改成目标 price unit | 保持与实现和消费侧文档一致 | P0 |
| `src/interfaces/IPriceOracleRead.sol` | 已完成：注释已明确 `price` 为 asset valuation unit，`getPrice/getPrices` 返回 `assetDecimals` 作为共享 scaling basis | 作为权威只读接口 | 后续仅需保持与实现和消费侧注释同步 | P2 |
| `src/interfaces/IPositionViewValuation.sol` | 已完成：文档已明确为统一 18 位 system valuation unit | 保持为统一 18 位 system valuation unit | 后续仅需保持与 PositionView 实现同步 | P2 |
| `src/interfaces/ILendingEngineBasic.sol` | 已完成：文档已明确为统一 18 位 system valuation unit | 保持为统一 18 位 system valuation unit | 后续仅需保持与 lending accounting/valuation 实现同步 | P2 |
| `src/interfaces/ILendingEngineDebtRead.sol` | 已完成：总值接口与 `calculateDebtValue` 注释都已明确为共享 18 位 system valuation unit | 保持为统一抽象口径 | 后续仅需与实现和消费侧文档同步 | P2 |
| `src/interfaces/ILendingEngineDebtRead.sol` strict/best-effort 拆分 | 已完成：新增 `getUserTotalDebtValueBestEffort/Strict` 与 `calculateDebtValueBestEffort/Strict` | 自动决策只依赖 strict；兼容/UI 读口走 best-effort | 后续仅需逐步收敛外围兼容调用 | P1 |

### Phase 2. 聚合与缓存层

| 模块/文件 | 当前状态 | 目标状态 | 需要动作 | 优先级 |
| --- | --- | --- | --- | --- |
| `src/Vault/modules/LoanFlowPushManager.sol` | 已完成主体迁移：内部先算 asset-native value，再向下归一到统一 18 位 unit；写入参数与 datapush 实值已不再使用 `Value` 语义 | 保持输出统一 value unit + decimals 元信息 | 仅需清理 `DataPushTypes` / `ModuleKeys` 等外围历史注释 | P2 |
| `src/Vault/view/modules/LoanFlowView.sol` | 已完成主体迁移：缓存、读接口与 datapush 实值均已切到统一 18 位 value unit，并通过 `valuationDecimals()` 暴露 decimals | 保持统一 value unit 读面 | 仅需收尾少量历史兼容注释/命名 | P2 |
| `src/Vault/modules/StatisticsPushManager.sol` | 已完成：读取 PositionView / LendingEngine 的统一 18 位 totals，并按 authoritative snapshot 推送 | 保持新 value SSOT | 后续仅需保持上游 snapshot 来源与文档同步 | P2 |
| `src/Vault/view/modules/StatisticsView.sol` | 已完成主体迁移：delta / snapshot / payload 已按统一 18 位 value unit 实现，并通过 `valuationDecimals()` 暴露 decimals | 保持统一 value unit 或显式携带 decimals | 仅需清理少量外围历史兼容注释 | P2 |
| `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` | 已写目标方向，但需与真实落地同步 | 作为架构侧配套文档 | 待合约改动后同步更新 | P2 |

### Phase 3. 清算与风险层

| 模块/文件 | 当前状态 | 目标状态 | 需要动作 | 优先级 |
| --- | --- | --- | --- | --- |
| `src/Vault/liquidation/libraries/LiquidationRiskQueryLib.sol` | 已完成主体迁移：统一从 `PositionView` / `LendingEngine` 读取 18 位 system valuation unit totals；此前仅注释残留旧 settlement-token 表述 | 保持依赖新 value SSOT | 后续仅需保持读面注释与实现同步 | P2 |
| `src/Vault/liquidation/modules/LiquidationCalculator.sol` | 已完成主体迁移：清算预览已用 `PositionView.getAssetValue` 与 `LendingEngine.calculateDebtValue` 的统一 18 位 value 结果做比较与推导 | 保持统一 value unit，避免重复本地归一化 | 后续仅需继续区分 token-native bonus 与 value-unit 比较语义 | P2 |
| `src/Vault/liquidation/modules/SettlementManager.sol` | 已完成主体迁移：liquidatable 判断、targetDebtValue 与 collateral 选择都已建立在新的风险/value 读面上 | 保持新 value SSOT | 后续仅需保持 settle/liquidate 注释与事件说明同步 | P2 |
| `src/Vault/liquidation/modules/LiquidationManager.sol` | 已跟随新语义：自身只做 token-native collateral/debt 写入，风险/value 判断完全依赖上游统一 value 结果 | 保持上游/下游职责边界清晰 | 后续仅需避免把 bonus/payout payload 误写成 value unit | P2 |
| `src/Vault/liquidation/modules/LiquidationRiskManager.sol` | 已完成主体迁移：health factor 走 HealthView，risk score 与 assessment 走 `LiquidationRiskQueryLib` 的统一 18 位 value 输入 | 保持跟随新语义 | 后续仅需保持缓存与阈值注释同步 | P2 |
| `src/blocks-only/BlocksOnlyCoordinator.sol` | 已纳入主线；当前按 trade-like + maturity-delivery 语义运行，不走通用借贷处置 value sizing | 保持本地 settlement amount、bound collateral、delivery/disposition 口径与主线文档一致 | 持续维护 blocks-only 专项单位审计与文档对齐 | P2 |
| `src/interfaces/ILiquidationRiskRead.sol` | 已完成：接口已明确调用方必须提供同一归一化 value unit，默认语义对齐共享 18 位 system valuation unit | 保持 precision 来源与 normalize 规则清晰 | 后续仅需与实现注释保持同步 | P2 |
| `src/interfaces/ILiquidationEventsView.sol` | 已部分完成：接口已补充 token-native amount 与 bonus reporting 语义区分，但 bonus 仍属 writer-defined reporting 字段 | 继续区分 token native decimals 与 value decimals | 后续若引入 value-based bonus payload，再显式增加 decimals 元信息 | P2 |

### Phase 4. Reward 与业务阈值层

| 模块/文件 | 当前状态 | 目标状态 | 需要动作 | 优先级 |
| --- | --- | --- | --- | --- |
| `src/Reward/EasyEmissionConfig.sol` | threshold 明确是 `thresholdValue`，默认值硬编码 `1e8` | threshold 变成 value + decimals 或统一归一化 unit | 改存储、getter、默认值、注释 | P0 |
| `src/Reward/EasyEmissionController.sol` | 已部分迁移：protocol flow gating 已读取 `LoanFlowView` 的统一 18 位 value，并把 `thresholdValue` 显式换算到 flow unit；但 `_MIN_BORROW_统一 VALUE`、`_toValue` 与 mint 公式主体仍固定依赖 统一 value | 改为新 value SSOT | 改 `_toValue`、mint threshold、公式分母，并清理历史 `Value` 事件字段 | P0 |
| `src/Reward/RewardManagerCore.sol` | 已完成主体迁移：user level upgrade 已改为读取 `LoanFlowView` 的 borrowVolumeValue，并按 `N * 1e18` 阈值判断 | 保持新 value 语义 | 后续仅需保持阈值文档与 RewardView 展示同步 | P2 |
| `src/Reward/internal/RewardModuleBase.sol` | datapush/writer 接口仍以 `amountValue/thresholdValue` 为主，当前已补充“字段名但语义仍固定 统一 value”说明 | 变为 value + decimals 或明确统一 unit | 若继续保留旧字段，至少在 payload/文档里显式标注固定 统一 value 语义 | P1 |
| `src/Vault/view/modules/RewardView.sol` | 已部分迁移：系统/用户读面可继续工作，但 emission cache 与 Easy minted payload 仍保留 `thresholdValue/amountValue` 历史字段 | 对外说明 historical name vs real unit | 改 ABI 或至少补 decimals 元信息，并避免把 Easy minted 的 `amountValue` 误读成统一 value unit | P1 |
| `src/core/LendingEngine.sol` | 已完成主体解耦：仅负责 best-effort 触发 `LoanFlowPushManager` 与 `RewardManager`，不再本地推导 reward/value unit | 与新 flow/value 口径一致 | 后续仅需保持触发链路注释与下游模块语义同步 | P2 |

### Phase 5. 部署、脚本、前后端消费层

| 模块/文件 | 当前状态 | 目标状态 | 需要动作 | 优先级 |
| --- | --- | --- | --- | --- |
| `scripts/deploy/deploy-arbitrum-sepolia.ts` | 仍有 `DEPLOY_ASSERT_PRICE_VALUE`，断言价格仍按 8 位 probe 写入 | 改成按资产 decimals 校验 | 改部署断言、环境变量命名和日志口径 | P0 |
| `scripts/deploy/seed-mock-asset-prices.ts` | 当前 `parseUnits(..., 8)` 写价，seed helper 仍以 `bootstrapPriceValue/defaultPriceValue` 为输入契约 | 改成按资产 decimals 写链 | 改 seed 输入 schema、写价 helper 与日志口径 | P0 |
| `scripts/tests/live-test/_mockLiveUtils.ts` | 当前 helper 与 env 约定仍围绕 `getAssetBootstrapPriceValue()` 和历史 pack 字段展开 | 改成返回 price + decimals 或明确 asset-native price | 改 helper与 pack 解析说明 | P0 |
| `scripts/tests/live-test/_fundsFlowLive.ts` | 仍把 bootstrap/updatePrice 输入写死为 8 位，LoanFlow 读值变量名也沿用 `borrowVolumeValue/repayVolumeValue` | 改为基于资产 decimals 的输入约定 | 改 live 运行参数、写价逻辑、日志与 LoanFlow 变量命名 | P0 |
| `scripts/tests/live-test/live-liquidation*.ts` | 仍读取 `getAssetBootstrapPriceValue`，并在价格修复路径上复用旧 8 位 helper | 改为新 price helper | 校验 live 清算读写价路径与 readiness 日志 | P1 |
| `scripts/deploy/deploy-mock-asset-pack.ts` | 资产包仍输出 `bootstrapPriceValue` 历史字段；但已在 schema 中保留 decimals/source metadata，属于“命名未收口”状态 | 允许兼容历史字段，但要补充 decimals 解释 | 改输出 schema、字段命名与生成注释 | P1 |
| `scripts/deploy/export-rwa-price-catalog.ts` | 仍输出 `bootstrapPriceValue` 与 `targetPriceUnit: "统一 value"`，backend export 契约尚未迁移 | 改 catalog 字段语义或增加 decimals | 改导出字段定义、publishMode 文档与 target unit 说明 | P1 |
| `scripts/e2e/**`、`scripts/tests/**` | 仍大量使用 `ethers.parseUnits(..., 8)`、`统一 VALUE_DECIMALS`、`valueValue`/`deltaValue` 命名；但也有部分用例已经直接读取 18 位 PositionView/LendingEngine/LoanFlow 值 | 全量清理魔法 8 | 改基准 helper、断言口径、artifact schema 与日志字段 | P1 |
| `frontend-config/**` | 需要补齐 value/price decimals 解释 | 前端配置与 manifest 跟随新语义 | 更新生成脚本和消费说明 | P2 |
| `docs/FRONTEND_CONTRACTS_INTEGRATION.md`、`docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md` 等 | 已大量写“历史名但语义按 assetDecimals”，但要与最终 ABI 对齐 | 作为消费侧契约说明 | 最后统一校正 | P2 |

---

## 5) 推荐执行顺序（适合拆 PR）

### Step 1. 先把文档和基线对齐

目标：避免团队在错误前提上改代码。

- 本文先明确“当前现状 != 目标状态”
- 在相关 guide 里统一补一句：当前很多 `Value` 仍是运行语义，不只是历史命名

### Step 2. 新增统一数学库

目标：先把数学能力收口，再谈业务改造。

- 新增 `AssetDecimalMath.sol`
- 新增独立单测
- 先不改业务模块，只验证数学行为可靠

### Step 3. 一次性改估值基础层

目标：把 price/value 的底层语义先站稳。

- `PriceOracle`
- `PriceUpdater`
- `ValuationOracleView`
- `GracefulDegradation`
- `PositionView`
- `VaultLendingEngine`
- 相关 interfaces

这一阶段完成前，不建议碰 reward 阈值。

### Step 4. 紧接着改聚合与缓存层

目标：把系统内“总量”和“流量”全部从旧 value unit 切走。

- `LoanFlowPushManager`
- `LoanFlowView`
- `StatisticsPushManager`
- `StatisticsView`

这是关键分水岭。只有这一步做完，reward 和 liquidation 才能基于新口径比较阈值。

### Step 5. 再分两条业务线推进

第一条：liquidation / risk

- `LiquidationRiskQueryLib`
- `LiquidationCalculator`
- `SettlementManager`

注：`BlocksOnlyCoordinator` 当前不纳入这轮主线执行顺序；若后续恢复推进，将按独立 trade-like 交割方案单列。

第二条：reward

- `EasyEmissionConfig`
- `EasyEmissionController`
- `RewardManagerCore`
- `RewardView`

注意：reward 不是完全独立于 liquidation，但它更强依赖 LoanFlow/Statistics 的迁移完成。

### Step 6. 最后统一回收脚本和消费侧

目标：避免新语义被旧脚本重新写坏。

- deploy
- mock seed
- live/e2e
- frontend-config
- backend integration docs
- runbook

---

## 6) 建议的 PR 切分

### PR-1

- 文档基线修正
- 新增 `AssetDecimalMath.sol`
- 新增精度库单测

### PR-2

- `PriceOracle`
- `PriceUpdater`
- `ValuationOracleView`
- `GracefulDegradation`
- 相关 interfaces

### PR-3

- `PositionView`
- `VaultLendingEngine`
- `LoanFlowPushManager`
- `LoanFlowView`
- `StatisticsPushManager`
- `StatisticsView`

### PR-4

- liquidation / risk / blocks-only

### PR-5

- reward / reward view / reward payload

### PR-6

- deploy / scripts / e2e / live / frontend-config / backend docs 收尾

---

## 7) 每个阶段的验收标准

### 基础层验收

- 存在统一的数学库
- 没有新的散落 `* 1e8`、`/ 1e8`
- 覆盖 6 decimals 和 18 decimals 资产
- 非整除换算的 round-trip 损失行为已被测试锁定
- down / up 两类归一化方向都有明确接口和测试

### 估值层验收

- 单资产内 amount / price / value 自洽
- fallback 路径与正常路径口径一致
- 接口不再把 price/value 默认解释成固定 统一 value

### 聚合层验收

- LoanFlow / Statistics 不再默认使用固定 统一 value
- 跨资产聚合前显式 normalize
- datapush payload 不再隐含固定 8 位

### 业务层验收

- reward threshold、mint curve、level upgrade 不再依赖 `1e8`
- liquidation 风险比较不再隐含旧 value unit
- blocks-only 与主借贷处置路径使用同一价值口径

### 脚本层验收

- 不再出现新的 `parseUnits(..., 8)` 写价逻辑
- 不再新增旧价格环境变量别名
- mock/live/deploy 的 price helper 明确返回 decimals 或按资产 decimals 写入

---

## 8) 迁移期间的硬规则

- 不要把“字段名还叫 `Value`”误判成“语义已经迁移完成”
- 不要把“接口返回了 `assetDecimals`”误判成“price 已经按 assetDecimals 缩放”
- 不要先大规模重命名，再回头修语义
- 不要在脚本和测试里继续手写 `8`
- 不要忽略 RWA/raw price adapter 与主协议 value SSOT 的语义差异

---

## 9) 最终目标的一句话版本

迁移完成后，主协议内部关于美元估值的唯一口径应当是：

- **单资产内部**：amount / price / value 共用该资产的 `assetDecimals`
- **跨资产场景**：先显式归一化，再聚合或比较
- **跨模块传递**：value 与 decimals 成对出现，不再默认固定 8 位

这才是本仓库后续合约、脚本、前端、后端可以共同依赖的 Units & Conversions SSOT。

