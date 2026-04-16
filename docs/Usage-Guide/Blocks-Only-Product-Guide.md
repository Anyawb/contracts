# Blocks-Only 产品独立指南

> 本指南为 EasiFi 借贷协议 blocks-only 产品专属文档，面向开发、集成、风控、产品、前端、撮合、收尾运营等全链路角色。本文只描述当前仓库已经落地、可直接依赖的 blocks-only 事实，并把仍未落地的扩展项单独标明。

## 集成者速读

- 如果你是外部前端、撮合服务、收尾服务或数据消费方，当前最重要的事实只有五条：`termBlocks` 是唯一 blocks-only 期限字段；当前只支持 `termBlocks = 1`；当前资产准入以链上全局 `AssetWhitelist` 为准；债务归零后可调用 `closeRepaidTradeBlocks(...)` 直接关闭订单；maturity 后的 `settleOrLiquidateBlocks(...)` 是 permissionless 收尾入口（任意账户可触发）。
- 如果你只关心“现在能依赖什么”，优先阅读第 1 节、第 4.1 节、第 4.4 节、第 4.5 节和第 6 节；这些段落描述的是当前仓库已经存在或已经定稿、可直接作为集成边界的内容。
- 如果你看到“目标接口”“建议命名”“未来拆分”“阶段 2”这类字样，应理解为后续演进方向，而不是当前 ABI、当前权限模型或当前链上注册事实。
- 如果链下目录、旧文档或历史理解与链上实现冲突，以当前仓库中的 `BlocksOnlyCoordinator`、`BlocksOnlyView`、`VaultCore.borrowForBlocks(...)` / `repayForBlocks(...)`、`AssetWhitelist` 和本文第 4 节为准。

---

## 1. 文档定位与当前状态

- **产品定位**：blocks-only 产品是以区块数作为唯一借贷周期单位的独立产品线，首个目标形态为 `termBlocks = 1` 的即时产品。
- **与 legacy day-bucket 的关系**：它不是对 `5/10/15/30/60/90/180/360` 天 bucket 的别名，也不是把 `termDays = 1` 解释成 1 block；它必须是一条独立产品线。
- **当前仓库状态**：截至当前代码状态，blocks-only 已落地独立链上产品入口与最小生命周期：`finalizeMatchBlocks`、`borrowForBlocks`、`repayForBlocks`、`repayBlocks`、`closeRepaidTradeBlocks`、`settleOrLiquidateBlocks`、独立订单记录、独立 `BlocksOnlyView` 查询面、独立 `DATA_TYPE_BLOCKS_ONLY_*` DataPush，以及 Registry 绑定所需的 `KEY_BLOCKS_ONLY_COORDINATOR / KEY_BLOCKS_ONLY_VIEW`；更大范围的前端目录、更多 term 配置、独立产品注册模块仍属于后续扩展。
- **文档约束**：本文只把仓库中已验证存在的实现写成“现状”；独立 whitelist、多 term 产品矩阵等未落地能力会明确标注为扩展项。

### 1.1 如何阅读本文

- 面向当前集成：优先把“当前仓库已落地能力”“已定稿的实施决策”“白名单定稿口径”“前端、撮合与链下服务要求”视为当前对外边界。
- 面向未来设计：把“架构原则”“推荐依赖图”“迁移与实施建议”视为演进路线，用于避免新实现继续把 blocks-only 语义塞回 legacy day-bucket 主路径。
- 面向外部系统：除非本文明确写成“已落地能力”或“已定稿”，否则不要把文中命名、目录、模块拆分建议直接当作可调用接口。

---

## 2. 产品定义与核心语义

- **Blocks-Only 产品**：以 `termBlocks` 作为唯一期限输入的借贷产品。
- **maturityBlock**：blocks-only 产品下的成熟区块应为 `openBlock + termBlocks`。
- **首个产品选项**：当前实现固定只允许 `termBlocks = 1`，即“借贷形成后的下一个区块即成熟”。
- **确认偏移边界**：legacy day-bucket 若保留 `+1 confirmation offset`，该偏移仅属于 day-bucket 兼容语义；blocks-only 不得复用该偏移，否则“1 block 产品”会被放大为实际 2 blocks 才成熟。
- **典型场景**：RWA 自动化撮合、AMM/RFQ、极短周期策略、链上流动性管理、自动化收尾联动等。

### 2.2 统一词典（blocks-only）

- **交易收尾（trade closeout）**：指债务归零后走 `closeRepaidTradeBlocks(...)` 的关闭路径。
- **到期收尾（maturity closeout）**：指 maturity 后关闭订单的路径总称（ABI 名称仍为 `settleOrLiquidateBlocks(...)`）。
- **到期交付收尾（maturity delivery closeout）**：指 maturity 且仍有剩余交割额时，将订单绑定 collateral 交付给 lender 的关闭路径。
- **映射说明**：到期交付收尾属于到期收尾（maturity closeout）下的 lender delivery 结果态，与“到期借款人返还”一起构成 maturity 分支的两类终态。
- **术语约束**：在 blocks-only 文档中不再把以上路径统称为“清算”；保留 `settleOrLiquidateBlocks` / `BLOCKS_ONLY_LIQUIDATED` 等仅用于 ABI/兼容命名说明。

### 2.1 已定稿的产品分叉语义

- **借贷壳与交易语义分离**：blocks-only 不应继续维持“trade-like 表层 + debt-ledger 处置内核”的混合态。首发 `termBlocks = 1` 产品应直接收敛为 trade-like 成交与交割产品，订单内只维护本地剩余交割额，不再把通用 debt ledger / 处置执行器当成主语义。
- **当前链上目标事实**：trade-like 主路径拥有独立的 debt-free 关闭入口 `closeRepaidTradeBlocks(...)`；maturity-gated 的 `settleOrLiquidateBlocks(...)` 保留旧 ABI 名称，但目标语义应收敛为“maturity 后完成产品到期收尾（maturity closeout）”，其中 `remainingDebt > 0` 分支属于“到期交付收尾（maturity delivery closeout）”；“交割收尾”仅作同义注释。
- **借贷主体系保持不动**：为支持 blocks-only trade-like 主路径，不会去修改借贷主体系中通用的 `settleBlocksIfRepaid` / `liquidateBlocks` 语义，也不会把这种临时交易逻辑倒灌回 legacy 借贷系统。
- **独立交易收尾（trade closeout）入口只属于 BlocksOnlyCoordinator**：该入口的职责是处理“交易已成功、订单本地剩余交割额已归零、订单尚未关闭”的独立收尾路径；maturity 后入口只负责把同一订单按产品规则收成终态，不再做通用借贷处置编排。

---

## 3. SSOT 统一口径

### 3.1 必须统一的定义

- **唯一期限参数**：链上与签名层的权威期限字段必须是 `termBlocks`，不是 `termDays`。
- **termDays 的角色**：`termDays` 仅可保留为 legacy bucket 输入或旧 ABI 兼容字段，不能被解释为 blocks-only 产品语义。
- **expireAt 语义**：在 intent 相关结构中，`expireAt` 的真实语义是 `expireBlock`，不是 unix timestamp。
- **maturity 边界**：当 `block.number >= maturityBlock` 时，blocks-only 订单即可进入产品定义的 maturity 到期收尾轴（maturity closeout，原“交割收尾”仅作同义注释）；该轴不应再等同于通用 debt-ledger 处置 / legacy Reward outcome 判定轴。

### 3.2 当前仓库已验证的 SSOT 落点

- `SettlementIntentLib` 已提供 `BorrowIntentBlocks`、`LendIntentBlocks` 以及对应的 EIP-712 哈希函数，说明签名层已接受显式 `termBlocks` 语义。
- `TermBlocksLib` 当前只提供 legacy `termDays -> termBlocks` 显式映射，用于 day-bucket 基线口径，不等同于 blocks-only 独立白名单。
- `LendingEngine` 当前采用 block-based duration whitelist，但白名单仍对应 legacy bucket 映射后的 blocks 值，并非独立的 blocks-only 产品清单。
- `BlocksOnlyCoordinator` 当前把产品规则直接收口为实现约束：`termBlocks == 1`、`rateBps == 0`、`lender == LenderPoolVault`、借款资产必须通过全局 `AssetWhitelist`。
- `BlocksOnlyView` 当前通过 `ACTION_VIEW_USER_DATA`、`ACTION_VIEW_SYSTEM_DATA` 与 `ACTION_ADMIN` 做 permissioned 查询，不是完全公开的订单视图。

### 3.3 SSOT 参考文档

- 时间依赖改造总原则：见 [Time-Dependency-Refactor-Guide.md](Time-Dependency-Refactor-Guide.md)
- 前端签名与快照消费：见 [Frontend-Modification-Guide.md](Frontend-Modification-Guide.md)
- 前端与合约连接说明：见 [../FRONTEND_CONTRACTS_INTEGRATION.md](../FRONTEND_CONTRACTS_INTEGRATION.md)
- 资金链路：见 [Funds-Flow-Architecture-Guide.md](Funds-Flow-Architecture-Guide.md)
- 奖励与等级约束：见 [Reward/Reward-System-Usage-Guide.md](Reward/Reward-System-Usage-Guide.md)

---

## 4. 当前实现与待实施边界

### 4.0 当前对外可依赖的最小事实

- 当前链上 blocks-only 写路径的目标最小闭环应由 `VaultBusinessLogic.finalizeMatchBlocks(...)`、`BlocksOnlyCoordinator.finalizeMatchBlocks(...)`、`BlocksOnlyCoordinator.repayBlocks(...)`、`closeRepaidTradeBlocks(...)` 与 `settleOrLiquidateBlocks(...)` 组成；其中 `VaultCore.borrowForBlocks(...) / repayForBlocks(...)` 若继续存在，只能视为过渡桥接接口，不应再被解释为产品语义 SSOT。
- 当前链上 blocks-only 只读路径已经存在，`BlocksOnlyView` 可返回订单静态字段与运行时字段，如 `remainingDebt`、`isMatured`、`isClosed`、`canCloseTrade`、`canSettleOrLiquidate`。
- 当前 blocks-only 产品规则不是“可配置矩阵”，而是实现内硬约束：`termBlocks == 1`、`rateBps == 0`、`lender == LenderPoolVault`。
- 当前资产准入不是独立 blocks-only 注册模块，而是先复用全局 `AssetWhitelist`。
- 当前 maturity 后收尾入口是 permissionless 的 `settleOrLiquidateBlocks(...)`；keeper 仍可作为推荐执行角色，但不是权限前置条件。

### 4.0A 当前已落地的生命周期拆分

- `closeRepaidTradeBlocks(...)` 已经落地，用于 blocks-only 的 trade-like 主路径。
- 该入口的设计目标已经成为当前实现：当 trade-like 订单已经完成链上成交、`remainingDebt = 0` 且订单尚未关闭时，可直接完成 close，不再要求额外等待 `maturityBlock`。
- `settleOrLiquidateBlocks(...)` 不应再继续承载“借贷式结算/处置”内核；它只保留 maturity 后的到期收尾职责（`remainingDebt > 0` 为到期交付收尾），并可继续复用既有 keeper 权限门槛。
- 该拆分只收敛在 blocks-only 独立产品面，不改变借贷主体系、legacy day-bucket 与通用结算 / 借贷处置语义。

### 4.0B 三层状态模型（新增，强约束）

- 对 blocks-only，状态设计必须拆成三层，但只有第一层是主状态机：
  - **第一层：主生命周期 + close reason**。主生命周期只回答订单当前处于活动中、已还清、已完成业务收尾、或已进入违约/强制收尾等 coarse business phase；`TRADE_CLOSED`、`SETTLED` 这类差异应迁移到 `closeReason`，而不是继续作为顶层 `status` 名字。
  - **第二层：shortfall 子状态机**。blocks-only 当前目标语义是不进入通用 shortfall 流程，因此这层在目标态应显式读取为 `NONE`；如果为了兼容历史实现临时保留了 loss 相关分支，也必须通过独立字段暴露，不能再把 `LIQUIDATED_WITH_SHORTFALL` 混入第一层。
  - **第三层：collateral custody / disposition 状态**。该层专门回答 collateral 现在还在 `BlocksOnlyCoordinator` 托管、已返还 borrower、还是已交付 lender；这是 blocks-only 的核心业务事实，不能再藏在 `isClosed`、`remainingDebt` 或事件名字里。

- **当前 `BlocksOnlyOrderStatus` 只能视为兼容读面，不是目标 SSOT**：
  - `SETTLED` 与 `TRADE_CLOSED` 本质上是 close reason，不是顶层 business phase。
  - `LIQUIDATED_WITH_SHORTFALL` 会把第二层污染到第一层，只能视为迁移债务。
  - 新增 view、DataPush、前后端聚合字段时，必须直接暴露 `closeReason`、`shortfallStatus`、`collateralDispositionStatus`，不得继续把它们折叠回旧 `status`。

- **blocks-only 写路径必须原子写完整三层事实**：
  - `finalizeMatchBlocks(...)`：写入订单激活事实，同时把第三层写成 coordinator custody。
  - `repayBlocks(...)` / `repayForBlocks(...)`：只更新第一层中的 repay/accounting 进度，不得顺手推断业务终态。
  - `closeRepaidTradeBlocks(...)`：同一交易内写入第一层 close reason 为 trade closeout，并把第三层写成 collateral returned to borrower。
  - `settleOrLiquidateBlocks(...)`：同一交易内写入第一层 close reason，并把第三层明确写成 borrower refund 或 lender delivery；不得只写一个 `SETTLED` / `LIQUIDATED` 再让读面靠 `remainingDebt` 猜 collateral 去向。

- **blocks-only 读路径必须直接暴露终态原因与资产去向**：
  - `remainingDebt` 继续保留为会计/兼容字段，但不得单独承担终态判断职责。
  - `isClosed` 只能视为粗粒度布尔辅助字段，不得再作为前端、后端、测试判断“正常收口”“lender take”“borrower refund”的唯一依据。
  - `BlocksOnlyView` 的目标读面应至少能直接返回：第一层主生命周期、`closeReason`、第二层 `shortfallStatus`、第三层 `collateralDispositionStatus`。

- **测试必须按 transition matrix，而不是按函数名，来校验 blocks-only 状态**：
  - `repay -> closeRepaidTradeBlocks` 应断言 trade closeout reason + borrower refund。
  - `maturity + remainingDebt == 0 -> settleOrLiquidateBlocks` 应断言 maturity closeout reason + borrower refund。
  - `maturity + remainingDebt > 0 -> settleOrLiquidateBlocks` 应断言 maturity closeout reason + lender delivery。
  - 禁止仅用 `remainingDebt == 0`、`isClosed == true` 或旧 `status` 字符串去证明终态正确。

### 4.1 当前仓库已落地能力

- **blocks-term intent 结构已存在**：`SettlementIntentLib` 中已定义 `BorrowIntentBlocks` / `LendIntentBlocks` 及其 EIP-712 哈希逻辑。
- **block-based maturity 语义已确立**：`LendingEngine`、`EarlyRepaymentGuaranteeManager` 等核心模块已将 maturity 语义统一到 block 轴。
- **legacy bucket 的显式映射已存在**：`TermBlocksLib.termDaysToBlocks` 提供 `5/10/15/30/60/90/180/360` 到 blocks 的显式映射。
- **前端文档已为 blocks-only 预留目录口径**：前端文档已要求通过 `blocksOnlyProducts` 目录消费 blocks-only 产品，而不是自行推导。

### 4.2 当前仓库尚未落地的内容

- **独立链上产品入口已落地最小闭环，但还未扩到完整产品矩阵**：当前已存在 `BlocksOnlyCoordinator.finalizeMatchBlocks(...)`、`repayBlocks(...)`、`closeRepaidTradeBlocks(...)`、`settleOrLiquidateBlocks(...)` 与 `VaultCore.borrowForBlocks(...) / repayForBlocks(...)`；但还没有更通用的多 term blocks-only 产品注册、目录治理与只读聚合层。
- **独立 blocks-only 白名单尚未落地**：当前代码中没有名为 `ALLOWED_BLOCKS_ONLY_TERMS` 的链上实现常量或只读接口。
- **保证金直收 termBlocks 入口尚未落地**：`EarlyRepaymentGuaranteeManager` 当前仍以 legacy `termDays` 为入参，再映射到 `termBlocks`。
- **撮合主路径已新增 blocks-only 专用入口，但 legacy helper 仍保留**：`VaultBusinessLogic.finalizeMatchBlocks(...)` 已经接到 `BlocksOnlyCoordinator`；`SettlementMatchLib` 仍保留极薄转发 helper，以兼容现有 module 边界。
- **专属事件与 DataPush 已落地最小集**：当前已实现 `BlocksOnlyMatchFinalized`、`BlocksOnlyRepaymentRecorded`、`BlocksOnlyOrderTradeClosed`、`BlocksOnlyOrderSettled`、`BlocksOnlyOrderDelivered` 以及对应的 `DATA_TYPE_BLOCKS_ONLY_*`；`BLOCKS_ONLY_LIQUIDATED` 仅作为保留哈希常量，不再由当前路径发出。
- **专属读接口已落地最小集**：当前已实现 `BlocksOnlyView`，支持单订单、borrower 分页和 system 分页查询，并返回运行时字段 `remainingDebt / isMatured / isClosed / canCloseTrade / canSettleOrLiquidate`。

### 4.3 文档表达规则

- 本文后续凡写“目标接口”“建议命名”“建议事件”，均表示**建议设计**，不是当前仓库已存在 ABI。
- 集成方若按现有代码开发，应以现有 `SettlementIntentLib`、`TermBlocksLib`、`LendingEngine`、`EarlyRepaymentGuaranteeManager` 的实际实现为准。

### 4.3A 对外集成判断表

- 想判断某资产当前能否进入 blocks-only：先看链上 `AssetWhitelist`，再看链下产品目录是否已接入该资产；两者缺一不可。
- 想判断某订单当前是否可展示为“待收尾/待交付”：优先读 `BlocksOnlyView` 运行时字段，不要自行用本地缓存重算 maturity 与 debt。
- 想判断 maturity 后是否可以由任意账户触发：可以。当前 `settleOrLiquidateBlocks(...)` 是 permissionless，keeper 只是运维职责建议，不是角色门槛。
- 想新增更多 `termBlocks` 产品：不能只改前端目录或链下撮合；当前还必须先改链上 Coordinator 的硬编码约束与治理配置来源。
- 想把全局 `AssetWhitelist` 中的资产默认视为“已上线 blocks-only 产品”：不能这样假设；进入全局白名单只是必要条件，不是产品已上线的充分条件。

### 4.3B 当前实现下，外部集成方不应自行假设的内容

- 不要假设当前存在独立 blocks-only 产品注册合约、独立 blocks-only 白名单合约或完整产品矩阵查询合约。
- 不要假设当前 blocks-only 会自动复用 legacy `SettlementManager`、legacy Reward 回调、`EarlyRepaymentGuaranteeManager` 或 day-bucket order creation。
- 不要假设当前 `termBlocks` 已经开放任意正整数；当前实现只接受 `1`。
- 不要假设 `rateBps` 可以像 legacy 借贷那样按期限自由配置；当前实现固定要求 `0`。
- 不要假设 `BlocksOnlyView` 是完全公开的；当前查询仍受权限控制。

### 4.4 已定稿的实施决策（2026-03-15）

以下规则已定案，后续代码实施必须直接按本节执行，不再按 legacy day-bucket 语义做兼容推导：

- **独立写入口是强约束**：blocks-only 必须新增独立入口，至少包括 `finalizeMatchBlocks`、`borrowForBlocks` 及独立产品创建路径；不得复用 day-bucket 的公开产品入口。
- **产品目标是即时交易，不是计息借贷**：首发 `termBlocks = 1` 产品本质上按“1 block 确认后获得可触发到期收尾/交付资格”建模，不引入 day-bucket 的利息语义。
- **独立交易式关闭入口是既有事实**：为避免 `termBlocks = 1` 在真实网络上把 trade-like 主路径绑死在 maturity 边界上，`BlocksOnlyCoordinator` 已提供独立交易收尾（trade closeout）入口；该入口只服务 blocks-only 独立产品，不修改借贷主体系通用结算 / 借贷处置语义。
- **成交即托管是强约束**：blocks-only 订单一旦撮合成功，订单绑定抵押必须在同一笔 finalize 交易中从 borrower 的 `CollateralManager` 可提现余额转入 `BlocksOnlyCoordinator` 托管；不得只记录 `collateralAsset/collateralAmount` 而继续让 borrower 在订单关闭前自由提走或复用这笔抵押。
- **blocks-only 首版不计息**：对 `termBlocks = 1` 产品，利息口径固定为 `0`，不再使用 `termDays / 365`，也不使用 `termBlocks / YEAR_BLOCKS` 的借贷计息模型。
- **Reward 系统完全独立**：blocks-only 不沿用 legacy 的 `_ON_TIME_WINDOW_BLOCKS`、early/on-time/late 分类或对应 Reward outcome 规则；若 blocks-only 交割完成后需要发放 Easy，必须走 blocks-only 专用的 Easy 发放子路径，而不是把 `BlocksOnlyCoordinator` 伪装成 `KEY_ORDER_ENGINE` 去调用 `RewardManager.onLoanEventByOrder*`。
- **提前还款保证金不适用**：blocks-only 首版不接入 `EarlyRepaymentGuaranteeManager` / `GuaranteeFundManager`，也不生成任何提前还款保证金记录。
- **maturity 交割边界保持 permissionless**：当订单仍有剩余交割额时，`settleOrLiquidateBlocks(...)` 以 maturity 为边界且允许任意账户触发；其结果必须收敛为产品定义的交割终态，例如把订单创建时绑定的 collateral 直接交付给 lender；不得再进入通用借贷处置执行器、shortfall ledger 或 residual debt 账本语义。
- **适用场景是 RWA 与稳定币即时交换**：首版产品面向 RWA 与 USDT/USDC 等稳定币的快速撮合成交，语义上更接近 block-confirmed atomic trade，而非传统借贷周期产品。
- **阶段 1 先采用全局资产白名单**：在社区与产品体系尚未成熟前，blocks-only 首版先复用全局 `AssetWhitelist` 作为 RWA 资产准入门槛；每新增一种可交易 RWA 资产，先加入全局资产白名单，再允许进入 blocks-only 产品流程。
- **当前链上权威来源是 `AssetWhitelist`**：第一阶段链下 `blocksOnlyProducts` 快照只能展示已进入全局 `AssetWhitelist` 的资产；若链下目录与链上白名单冲突，以链上 `AssetWhitelist` 为准。
- **当前 maturity 收尾入口是公开权限**：`settleOrLiquidateBlocks(...)` 当前为 permissionless，任何人都可在 maturity 后直接触发。
- **阶段 2 再拆独立产品注册合约**：当社区成熟、开放上架需求增强后，再把 blocks-only 的“资产准入”和“产品目录/交易模板”从全局 `AssetWhitelist` 中拆分为独立产品注册模块。
- **仅更新资产白名单仍不足以完整上线产品**：在第一阶段，新增 RWA 资产进入 `AssetWhitelist` 只是准入前提；前端展示、撮合配置、事件/DataPush、只读查询仍需同步接入该资产，才能真正可交易。

### 4.5 白名单定稿口径（必须按本节理解）

为避免后续实现时把“独立产品体系”和“独立白名单模块”混为一谈，白名单口径在此单独定稿：

- **Blocks-Only 是独立产品体系**：它在产品编码、签名结构、撮合路径、写入口、收尾语义、Reward 规则、监控口径上都必须作为独立体系处理。
- **独立体系不等于首版必须独立白名单合约**：第一阶段可以复用全局 `AssetWhitelist` 作为链上资产准入门槛，这不改变 blocks-only 作为独立产品体系的事实。
- **阶段 1 的链上资产准入 SSOT 只有一个**：即全局 `AssetWhitelist`。任何 blocks-only 资产，只要链上未进入 `AssetWhitelist`，都不得进入 blocks-only 主路径。
- **阶段 1 的真实上线条件是“双条件”**：
  1.  资产已进入全局 `AssetWhitelist`；
  2.  该资产已被接入 blocks-only 的链下产品目录、前端展示、撮合配置、监控与只读消费链路。
- **因此，进入 `AssetWhitelist` 是必要条件，但不是充分条件**：资产只进了全局白名单，并不自动意味着该资产已经成为“可交易的 blocks-only 产品”。
- **前端展示必须做交集判断**：阶段 1 下，前端展示的 `blocksOnlyProducts` 必须与链上 `AssetWhitelist` 同时成立；链下目录允许、链上白名单不允许时，以链上拒绝为准。
- **撮合与链上执行也必须以链上白名单为准**：即使链下撮合服务已经发布某个 blocks-only 产品，只要链上 `AssetWhitelist` 不允许对应资产，最终执行仍必须失败，而不能放行。
- **阶段 2 才考虑拆独立产品注册模块**：未来若把 blocks-only 的产品目录、模板、参数和准入彻底抽成独立注册模块，那是“独立体系的进一步工程化落地”，不是“今天才能算独立体系”的前置条件。

一句话总结本节：**Blocks-Only 是独立产品体系；但在首版资产准入上，先复用全局 `AssetWhitelist`，而不是现在就强行要求独立 whitelist 合约。**

---

## 5. 当前合约实现要点

### 5.1 LendingEngine

- 当前 `LendingEngine` 已使用 blocks 作为账本期限与 maturity 语义。
- 当前允许的 duration whitelist 仍对应 legacy day-bucket 映射结果：`36000 / 72000 / 108000 / 216000 / 432000 / 648000 / 1296000 / 2592000`。
- 这说明协议已经具备 block-based 账本基础，但尚未把 blocks-only 独立产品白名单单独抽离。
- 当前 blocks-only debt write 并不要求 `LendingEngine` 直接接受 `termBlocks = 1` 作为独立 whitelist 项；实际路径是 `VaultCore.borrowForBlocks(...) / repayForBlocks(...)` 作为独立 debt-ledger bridge，内部写入仍复用现有 debt mutation。

### 5.2 SettlementIntentLib

- `BorrowIntentBlocks` 使用显式 `termBlocks`。
- `LendIntentBlocks` 使用显式 `minTermBlocks / maxTermBlocks`。
- 当前 blocks-only 最可信的“已实现能力”在于签名结构已经为独立产品线铺好路径。

### 5.3 SettlementMatchLib

- 当前撮合主路径仍会把 legacy `termDays` 显式映射到 `termBlocks`。
- blocks-only 已经新增直接消费 `termBlocks` 的 `finalizeMatchBlocks(...) -> BlocksOnlyCoordinator` 路径，不再依赖 day-bucket 入口；`SettlementMatchLib` 只保留极薄桥接 helper。

### 5.4 EarlyRepaymentGuaranteeManager

- 当前保证金锁定入口仍接收 `termDays`，内部再映射为 `termBlocks`。
- 但当前 blocks-only 主路径不会调用 `EarlyRepaymentGuaranteeManager`；该模块仅保留为 legacy / 非 blocks-only 路径的实现背景。

### 5.5 TermBlocksLib

- 当前职责是维护 legacy bucket 的显式 blocks 映射，避免链上做 seconds/days 运算。
- 它不是 blocks-only 产品白名单模块，也不应被误写成 `isBlocksOnlyTermWhitelisted` 之类当前并不存在的接口。

---

## 6. 前端、撮合与链下服务要求

### 6.1 前端要求

- blocks-only 产品必须作为独立产品线展示，不能混入 day-bucket 下拉框并复用 `termDays` 概念。
- 签名时必须写入显式 `termBlocks`，尤其是 `1 block` 产品必须签入 `termBlocks = 1`。
- 期限目录应来自链下快照源，不允许前端自行用“天数乘平均出块时间”推导产品期限。
- 前端应同时展示确定值 `blocksLeft` 与估计值 ETA，并明确 ETA 只是估计。
- 前端读取单订单、borrower 分页与系统分页时，应优先消费 `BlocksOnlyView` 返回的运行时字段，而不是自行拼接 debt 或 maturity 状态。
- 前端应把 `BlocksOnlyView` 读值理解为“当前 RPC / 当前读面已收敛到的最新可见状态”；如果交易刚确认后的短时间内 runtime 字段仍未更新，应展示“状态同步中 / 待读面收敛”，并做短轮询，而不是把临时旧值或 `0` 值当成最终结果。
- 对依赖估值或价格的展示与按钮门槛，前端应优先消费带有效性标记的 view / oracle 结果；当价格无效、过期、或区块元数据明显落后时，应展示“价格待同步 / 价格过期”，而不是把价格、健康度或可清算状态静默渲染为 `0` 或可立即操作。
- 前端应把 blocks-only 主路径的 readiness 读成“是否已 trade-complete 且可 close”；maturity 只保留给 legacy 借贷处置 / maturity 收尾分支。

### 6.2 撮合服务要求

- 撮合服务必须支持 `BorrowIntentBlocks / LendIntentBlocks` 的签名、验签与复现。
- blocks-only 的 borrow/lend 意向单应使用显式 `termBlocks` 范围匹配，不能回退到 `minTermDays / maxTermDays` 语义。
- 若采用链下快照发布期限目录，borrower 与 lender 必须使用同一份快照版本，否则会产生无法撮合的签名不一致。
- 撮合与后端应把 blocks-only 首版产品作为 trade-like 产品维护其主状态机，不再把 maturity 当作成交后继续推进的唯一条件。

### 6.3 快照与配置服务要求

- 推荐由链下服务统一发布 `TermBlocks` 快照。
- 快照中可并行包含 `termBuckets` 与 `blocksOnlyProducts`，前者服务 legacy，后者服务 blocks-only。
- `blocksOnlyProducts` 应至少包含 `productCode`、`label`、`termBlocks`、结算模式等字段。

### 6.4 参考文档

- 前端签名与快照消费：见 [Frontend-Modification-Guide.md](Frontend-Modification-Guide.md)
- 前端与合约连接：见 [../FRONTEND_CONTRACTS_INTEGRATION.md](../FRONTEND_CONTRACTS_INTEGRATION.md)

### 6.5 Live 验收口径：runtime-first、payload-notice

- blocks-only live 验收默认以链上 runtime 状态为第一权威来源，优先读取 `BlocksOnlyView.getBlocksOnlyOrder(...)` 与必要的 coordinator 状态；不要把 `DataPushed` payload 当成结算是否成功的硬 SSOT。
- 对 `settleOrLiquidateBlocks(...)` 这类收尾路径，`status`、`remainingDebt`、`isClosed`、`canSettleOrLiquidate`、`closeBlock` 是否已落账，应以链上 runtime / storage 读值为准。
- `DataPushed(DATA_TYPE_BLOCKS_ONLY_*)` 仍然必须作为可观测性与链下消费入口保留，但在 live 验收脚本里应降级为辅助信号：存在则校验并记录；缺失、延迟、或与 runtime 短暂不一致时，优先输出 notice，而不是直接把业务结果判成失败。
- 在真实链或负载均衡 RPC 上，交易确认后短时间内 view 仍可能返回旧快照；因此前后端都不应假设 `tx.wait()` 之后所有读面立刻一致，而应采用“runtime-first + 短轮询等待收敛”的处理方式。
- 特别是 `payload.closeBlock`，当前只能视为辅助观测字段，不应在 live 验收中被当作比 runtime `closeBlock` 更硬的一致性来源。
- 如果测试目标是“业务落账是否成功”，应只让 runtime / ledger 断言决定通过与否；如果测试目标是“事件总线/推送路径是否健康”，应另起 observability 类脚本，单独把 `DataPushed` 完整性作为验收目标，避免把两类失败混在同一个 live gate 中。

---

## 7. 奖励、清算与风控边界

- **交易收尾边界**：对 trade-like 主路径，当前 blocks-only 交易收尾（trade closeout）入口已经以“交易成功且债务归零”为主要 close 边界，而不是以 maturity 为唯一触发条件。
- **到期收尾边界**：对仍有剩余交割额的订单，blocks-only 产品达到 `maturityBlock` 后才进入到期交付收尾判定，不应叠加 day-bucket 的确认偏移。
- **收尾权限边界**：当前代码将 `settleOrLiquidateBlocks(...)` 设计为 permissionless maturity 收尾入口；是否由 keeper 触发属于运维编排，不是合约权限要求。
- **奖励边界**：blocks-only 产品是独立产品线，Easy 发放应绑定“交割完成”而不是 legacy 的 repay outcome；该路径必须与 `RewardManager` 主写入口解耦。
- **等级约束**：若未来 blocks-only 产品引入奖励门槛、等级门槛或更细粒度风控，应单独定义，不应默认继承 day-bucket 长周期规则。
- **极短周期风险**：`1 block` 产品天然暴露更强的链上拥堵、MEV、预言机延迟、撮合与收尾竞争、价格跳变风险。
- **白名单约束**：只允许治理明确批准的 blocks-only 周期，尤其是首发建议从 `termBlocks = 1` 这种严格白名单选项开始。

参考：

- [Reward/Reward-System-Usage-Guide.md](Reward/Reward-System-Usage-Guide.md)
- [Funds-Flow-Architecture-Guide.md](Funds-Flow-Architecture-Guide.md)
- [Time-Dependency-Refactor-Guide.md](Time-Dependency-Refactor-Guide.md)

---

## 8. 独立体系设计原则与集成建议

blocks-only 产品若作为未来 AMM / RFQ / RWA 自动化交易基础，应与现有 day-bucket / legacy 流程保持结构性解耦。

### 8.1 架构原则

- **完全独立**：产品标识、目录、快照、撮合路由、风控、奖励、收尾策略应独立管理；这里的“独立”首先指产品体系独立，不要求首版必须同步拥有独立白名单合约。
- **接口集成**：外部模块应通过标准接口、事件、快照或服务契约与 blocks-only 集成，而不是依赖内部实现细节。
- **依赖反转**：blocks-only 方案不应要求 legacy 模块感知其内部状态；理想形态是由 blocks-only 向外暴露稳定接口。
- **可扩展**：接口与目录命名要为未来 `termBlocks = N`、AMM、RWA 自动化策略预留空间。

### 8.2 当前可执行的集成建议

- 在链下先把产品目录、签名结构、撮合约束与快照接口独立出来。
- 不要再对外宣称交易收尾（trade closeout）是“待上线能力”；`BlocksOnlyCoordinator` 与 `BlocksOnlyView` 已经是当前可依赖的独立 ABI。
- 文档、前端、撮合、收尾、奖励的产品编码应统一，例如使用稳定的 `productCode` 区分 legacy 与 blocks-only。

### 8.3 已定稿命名与模块边界（后续代码必须按本节实现）

从本节开始，以下命名不再是“建议”，而是本仓库后续 blocks-only 实施的正式口径：

- **独立协调合约名称**：`BlocksOnlyCoordinator`。
- **独立模块 Registry Key**：`KEY_BLOCKS_ONLY_COORDINATOR`。
- **目录口径**：独立实现放在 `src/blocks-only/` 或等价独立目录中，不继续堆进 `VaultCore` / `VaultBusinessLogic` / `SettlementMatchLib` 内部。
- **最小写接口名称**：`IBlocksOnlyCoordinator`。
- **VaultCore 对外新增入口**：`borrowForBlocks(address borrower, address asset, uint256 amount, uint256 termBlocks)`。
- **VaultBusinessLogic 对外新增入口**：`finalizeMatchBlocks(BorrowIntentBlocks borrowIntent, LendIntentBlocks[] lendIntents, bytes sigBorrower, bytes[] sigLenders)`。
- **协调合约核心写入口**：`finalizeMatchBlocks(...)`，由 `VaultBusinessLogic` 转发调用，不再由 `SettlementMatchLib` 直接承担 blocks-only 主路径编排。
- **协调合约交易式关闭入口**：`BlocksOnlyCoordinator.closeRepaidTradeBlocks(orderId)` 已是当前 ABI，供 blocks-only trade-like 主路径使用；其语义独立于 `settleOrLiquidateBlocks(...)`。
- **SettlementMatchLib 的口径**：继续服务 legacy day-bucket 原子撮合；blocks-only 不再把主编排逻辑继续塞进该 library。
- **错误命名**：统一使用 `BlocksOnlyCoordinator__*` 前缀。
- **事件命名**：统一使用 `BlocksOnly*` 前缀，至少保留 `BlocksOnlyMatchFinalized` 作为第一版链上主事件。

### 8.4 三个桥接点的固定职责

本项目已明确要求 blocks-only 为独立产品系统，因此三处 legacy 模块只允许承担“桥接/转发”职责：

- **VaultCore**：若仍保留 `borrowForBlocks(...) / repayForBlocks(...)`，只允许作为过渡桥接存在；不得把它们继续当作 blocks-only 产品状态机的权威来源，更不得在其中复制 blocks-only 撮合、事件、Reward、Guarantee 逻辑。
- **VaultBusinessLogic**：只保留 borrower/lender intent 校验、reserve 消耗与最终转发职责，即新增 `finalizeMatchBlocks(...)` 并把执行收口到 `BlocksOnlyCoordinator`；不得再把 blocks-only 的还款、交割、Reward 或 maturity 收尾主流程直接实现在本合约里。
- **SettlementMatchLib**：保留 legacy `termDays -> termBlocks` 原子借贷撮合实现；如果需要兼容过渡，只允许提供极薄的 helper，不再作为 blocks-only 主流程承载层。

一句话理解：**legacy 三件套只负责 bridge；blocks-only 真正的产品编排必须落在 `BlocksOnlyCoordinator`。**

### 8.5 Blocks-Only Coordinator 的固定职责范围

`BlocksOnlyCoordinator` 第一版必须至少承担以下职责：

- 校验 blocks-only 资产准入：阶段 1 仍以全局 `AssetWhitelist` 为链上 SSOT。
- 校验 `termBlocks`：当前实现直接硬编码只放行 `termBlocks = 1`，尚未抽象成独立链上白名单容器。
- 校验 `rateBps`：当前实现固定只放行 `rateBps = 0`。
- 校验资金来源：当前实现要求 `lender` 必须等于 Registry 中的 `LenderPoolVault`。
- 从 `LenderPoolVault` 出金并向 borrower 放款。
- 创建 blocks-only 订单记录或等价链上订单结果，其中必须显式绑定成交 collateral asset / collateral amount。
- 维护订单本地剩余交割额，并通过 `remainingDebt` 等兼容字段向外暴露，但不得再把该字段解释成通用 debt ledger SSOT。
- 提供独立的交易收尾（trade closeout）写入口，处理“本地剩余交割额归零后立即关闭订单”的 blocks-only 主路径。
- 在 maturity 后提供 keeper 收尾入口，按产品约定完成 collateral 交割；若仍有剩余交割额，则把订单绑定 collateral 直接交付给 lender，而不是进入通用借贷处置 / shortfall 路径。
- 在交割完成后，以 blocks-only 专用窄入口 best-effort 触发 Easy 发放；不得要求放宽 `RewardManager` 的 `KEY_ORDER_ENGINE` caller gate。
- 明确隔离 legacy Reward：不得触发 legacy `Borrow` / `RepayOnTime` / `RepayLate` 等 Reward 语义。
- 明确隔离 early repayment guarantee：不得调用 `EarlyRepaymentGuaranteeManager` / `GuaranteeFundManager`。
- 发出 blocks-only 专属事件，供 DataPush / 前端 / 监控消费。
- 暴露独立读取面：当前已通过 `BlocksOnlyView` 暴露 permissioned 订单与运行时查询。

### 8.6 与现有 ORDER_ENGINE / LendingEngine 的固定边界

实现前必须统一以下边界，否则 `termBlocks = 1` 无法真实上线：

- **不能直接复用当前 legacy `createLoanOrder` 语义而不做隔离**：当前 `LendingEngine.createLoanOrder(...)` 只允许 legacy duration whitelist，`term = 1` 会被 `InvalidTerm` 拒绝。
- **不能让 blocks-only 订单默认触发 legacy Reward borrow 回调**：当前 `LendingEngine.createLoanOrder(...)` 会在创建后尝试触发 `RewardManager.onLoanEventByOrder*`，这与 blocks-only 首版“Reward 完全独立”的定稿冲突。
- **因此 Blocks-Only 必须拥有独立订单创建路径**：可以是独立订单合约、独立 coordinator 内部订单记录、或未来独立 order engine，但第一版不得伪装成 legacy order creation 的一个 term 特例。
- **VaultCore 的 debt 写入与订单创建要解耦**：blocks-only 可以复用 debt ledger，但不能被 legacy order creation 规则反向绑死。

### 8.7 第一版推荐依赖图

为便于后续拆分，第一版按以下依赖方向实施：

1. `VaultBusinessLogic.finalizeMatchBlocks(...)`
2. 校验签名、校验 reserve、汇总金额后调用 `Registry[KEY_BLOCKS_ONLY_COORDINATOR]`
3. `BlocksOnlyCoordinator.finalizeMatchBlocks(...)`
4. 协调合约完成资产白名单校验、termBlocks 校验、资金划拨、债务写入、blocks-only 订单记录、事件发出
5. `VaultCore.borrowForBlocks(...)` 仅作为 debt-ledger bridge 被协调合约调用

该依赖图的关键点是：**blocks-only 自己控制产品语义，legacy 模块只暴露必要桥接面，不再反向主导产品规则。**

---

## 9. 迁移与实施建议

### 9.1 实施顺序建议

1. 先统一链下 SSOT：期限快照、产品目录、签名结构、撮合匹配语义。
2. 再新增链上入口：显式 `termBlocks` 写入路径、独立白名单、独立事件。
3. 最后接收尾、Reward、前端展示与监控面，完成端到端闭环。

### 9.2 最小验收清单

- 链上关键路径不再依赖 `termDays = 1` 这种错误表达来模拟 1 block 产品。
- blocks-only 路径的 maturity 统一为 `openBlock + termBlocks`。
- 签名、撮合、放款、保证金、收尾、Reward 均直接消费显式 `termBlocks`。
- 前端、撮合、清算、风控使用同一份产品目录或快照版本。
- 文档、事件、监控、API 中不再把“目标接口”误写成“现有事实”。

### 9.3 与 legacy 的兼容性结论

- blocks-only 产品应与现有 day-bucket 产品并存，但必须明确分流。
- 它不应破坏现有 legacy 订单、奖励、清算逻辑。
- 只有在前后端、撮合、风控、收尾、Reward 全链路都支持后，blocks-only 才能算完整上线。

---

## 10. FAQ

**Q: blocks-only 产品和 day-bucket 产品能否混用？**

A: 不能混用语义。两者可以并存，但 blocks-only 必须作为独立产品线处理，不能把 `termDays` bucket 当作其内部实现。

**Q: Blocks-Only 到底是不是单独体系？**

A: 是。当前已经定稿的口径是：blocks-only 在产品语义、签名、撮合、写入口、收尾、Reward、前端目录和监控上都按独立体系处理。需要特别区分的是，**独立体系不等于首版就必须独立 whitelist 合约**；首版资产准入先复用全局 `AssetWhitelist`，但产品体系本身仍然是独立的。

**Q: 1 block 产品的 maturityBlock 应如何计算？**

A: 应为 `openBlock + 1`，不再叠加 legacy day-bucket 的 `+1 confirmation offset`。

**Q: 当前仓库是否已经存在 blocks-only 独立合约入口？**

A: 有。当前仓库已经存在 `BlocksOnlyCoordinator`，并通过 `VaultBusinessLogic.finalizeMatchBlocks(...)`、`VaultCore.borrowForBlocks(...) / repayForBlocks(...)` 以及 `repayBlocks(...)`、`settleOrLiquidateBlocks(...)` 形成最小独立闭环。

**Q: 当前仓库是否已经存在 blocks-only 专属白名单常量或只读接口？**

A: 没有。当前仅存在 legacy day-bucket 到 blocks 的显式映射，以及 `LendingEngine` 内部的 block-based whitelist。

**Q: blocks-only 产品的奖励、收尾与前端集成规则去哪里看？**

A: 分别参考 [Reward/Reward-System-Usage-Guide.md](Reward/Reward-System-Usage-Guide.md)、[Funds-Flow-Architecture-Guide.md](Funds-Flow-Architecture-Guide.md)、[Frontend-Modification-Guide.md](Frontend-Modification-Guide.md) 和 [Time-Dependency-Refactor-Guide.md](Time-Dependency-Refactor-Guide.md)。

**Q: 如何扩展更多 blocks-only 周期？**

A: 应通过治理明确增加新的 blocks-only 白名单与产品目录，并同步更新前端、撮合、收尾、Reward 和监控。就当前实现而言，还需要先把 Coordinator 中硬编码的 `termBlocks == 1` / `rateBps == 0` 约束抽象成可治理配置，不能只在 UI 或链下侧单独放开。

---

## 11. 相关文档索引

- [Time-Dependency-Refactor-Guide.md](Time-Dependency-Refactor-Guide.md)
- [Frontend-Modification-Guide.md](Frontend-Modification-Guide.md)
- [Funds-Flow-Architecture-Guide.md](Funds-Flow-Architecture-Guide.md)
- [Reward/Reward-System-Usage-Guide.md](Reward/Reward-System-Usage-Guide.md)
- [../FRONTEND_CONTRACTS_INTEGRATION.md](../FRONTEND_CONTRACTS_INTEGRATION.md)
- [../Architecture-Guide.md](../Architecture-Guide.md)

---

> 本指南是 blocks-only 产品的 SSOT 汇总文档，但“现状”与“目标设计”必须严格区分。若与代码实现冲突，以当前仓库代码和本文第 4 节的状态说明为准；若推进新开发，以本文的 SSOT 语义与相关引用文档为准。
