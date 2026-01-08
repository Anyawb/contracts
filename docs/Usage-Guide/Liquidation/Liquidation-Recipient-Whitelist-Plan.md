## 清算收款地址（A/B 钱包）与多品类 RWA 资金池白名单方案（计划稿）

> ⚠️ 本文为“专题计划稿”。关于整改的权威口径（统一写入口、模块边界、迁移步骤等）请以总纲为准：[`SettlementManager-Refactor-Plan.md`](./SettlementManager-Refactor-Plan.md)

> 目标读者：协议/合约开发、风控与运维（keeper）、集成方  
> 适用范围：多品类 RWA 抵押（ERC20 为主，兼容 ERC721/1155），清算/还款/提前还款全自动执行  
> 治理偏好：**Timelock（48h）慢治理 + Guardian/Keeper 快速冻结止血（不允许提款）**

---

### References（口径来源与关联文档）

- **清算总口径**：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
- **清算机制与调用链**：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
- **清算残值分配与收款配置**：[`Liquidation-Payout-Address-Guide.md`](./Liquidation-Payout-Address-Guide.md)
- **架构指南（直达账本 + 单点推送）**：[`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **双轨治理（Guardian + Timelock）**：[`docs/Usage-Guide/Governance-Dual-Track-Guide.md`](../Governance-Dual-Track-Guide.md)

---

### 背景与术语

- **B（Borrower / 抵押人）**：提供 RWA 抵押的用户
- **A（Lender / 出借人）**：提供借贷资金的用户
- **RWA 抵押资产**：主要为 ERC20 形式的 tokenized 金融产品（REITs、股票、基金、保险份额等），少量为 ERC721/1155
- **资金池（Collateral Pool / Custody）**：抵押资产实际托管的合约地址（“RWA 统一放到一个资金池里”）

---

## 1) 设计目标（你提出的核心约束）

- **全自动**：借贷、还款、提前还款、清算、分配均能自动执行（不依赖每次人工签名）
- **不可挪用**：抵押/费用一旦进入“合约资金池/金库”，任何人（含多签/平台）都不能随意转走
- **只有协议规则能转移**：资金转移只能由智能合约按既定规则触发
- **治理可审计不可偷偷改**：升级/改规则/改参数必须走 Timelock（48h 延迟 + 链上排队）
- **需要强止血**：出现致命 bug 时可立即冻结（Pause），冻结期间任何一方都不能提现；平台方最多只能延长冻结时间
- **可扩展到 1000+ RWA 资产**：不依赖链上遍历资产列表；链上只做校验与事件，枚举/报表交给链下索引

---

## 2) “白名单”的正确含义：静态地址白名单 → 动态关系白名单

你描述的收款方本质上不是“固定地址集合”，而是**随每笔借贷/仓位变化的 A/B 地址**：

- 正常还款/提前还款：抵押资产应回到 **B 钱包**
- 违约清算：抵押资产（或其分配份额）应流向 **A 钱包**（并可能包含平台费/准备金/清算人奖励等分配）

因此建议把“白名单”设计为**基于订单/仓位关系的动态校验**：

- **BorrowerRecipient（B）**：只允许接收 `positionOwner == B` 的抵押返还
- **LenderRecipient（A）**：只允许接收 `currentLender(orderId) == A` 的补偿/抵押份额
- **PlatformFeeVault（合约金库）**：固定唯一地址（合约），只能接收平台费份额
- **ReserveFundVault（合约金库，可选）**：固定唯一地址（合约），只能接收准备金份额
- **LiquidatorRecipient（清算执行者）**：只能是本次清算交易的 `msg.sender`（keeper/机器人或授权清算人），或其声明的接收地址（需强约束）

> 结论：**A/B 不需要预先登记到一个“静态地址白名单”里**；白名单由“仓位关系”自动推导。

---

## 3) 多品类 RWA 资金池的合约拆分建议（支持 1000+ 资产）

### 3.1 Custody 与 Policy 分离（推荐）

- **Custody（托管层）**：只做“持币 + 安全转出”，不包含复杂业务判断
- **Policy（策略层）**：只做“是否允许这次转出”的校验（收款方是谁、份额是多少、是否冻结等）

这种拆分的好处是：资产类型再多也只是“token 地址不同”，不会导致每种资产写一套逻辑。

### 3.2 资产类型适配（成熟做法）

托管层建议支持三类资产，使用最小适配器（Adapter）统一转账：

- **ERC20**：份额类 RWA（主流）
- **ERC721**：单证类 RWA（少量）
- **ERC1155**：多批次/多份额类 RWA（适合大量产品）

> 扩展到 1000+ 资产的关键是：链上只用 `mapping(token => config)`，不做链上枚举；资产清单由链下索引事件生成。

---

## 4) 收款与分配规则（覆盖：按时还款、提前还款、违约清算）

### 4.1 按时还款（到期或未触发清算）

- **抵押物去向**：全部返还给 **B（borrower）**
- **权威写入口**：`SettlementManager`（统一入口）在同一条链路内完成 `LendingEngine.repay` + `CollateralManager.withdrawCollateralTo(..., borrowerAddr)`，将抵押直接返还到 B 钱包（无需用户二次 `withdraw`）。
- **允许的收款地址**：`recipient == borrower(orderId)`（由 SettlementManager 基于订单/仓位关系动态解析）
- **平台费**：如果平台费来自“利息/罚金/手续费（非抵押物）”，建议走独立费用模块（如 `FeeRouter`）进入 **PlatformFeeVault**

### 4.2 提前还款（早还）

- **抵押物去向**：全部返还给 **B（borrower）**
- **权威写入口**：仍由 `SettlementManager` 统一承接（提前还款属于结算分支，不应走清算执行器）。
- **罚金/积分**：
  - 罚金的资金去向建议为：**A（lender）+ PlatformFeeVault**（按策略/参数分配）
  - 积分属于系统内模块（与抵押物返还分离）
- **允许的收款地址**：
  - 抵押返还：`recipient == borrower(orderId)`（B）
  - 罚金分配：`recipient == lender(orderId)`（A）或 `recipient == PlatformFeeVault`

### 4.3 违约清算（未按时还钱，触发清算）

清算需要同时考虑你指出的残值分配示例（平台/准备金/出借人/清算人，3/2/17/78）。

- **权威写入口**：`SettlementManager`（唯一对外写入口）在满足“到期未还/价值过低”等触发条件时进入清算分支；清算执行可由其内部调用 `LiquidationManager`（清算执行器）或直接直达账本（`CM/LE`）。

#### A) “应得方”是谁？

- **A（lender）**：作为出借人补偿与（通常）最终抵押归属方
- **B（borrower）**：清算场景下通常不应再收到抵押返还（除非你们业务另有“清算后返还余额”的规则）

#### B) 清算残值/抵押分配（3/2/17/78）

参考示例（来自 `liquidation-complete-logic.md`）：

- 平台收入：3%
- 风险准备金：2%
- 出借人补偿：17%（应付给 A）
- 清算人奖励：78%（应付给 liquidator/keeper）

#### C) 白名单规则（清算）

对于每笔清算，分配目标地址必须满足：

- **platform recipient**：必须等于 `PlatformFeeVault`（合约金库，固定唯一地址）
- **reserve recipient（可选）**：必须等于 `ReserveFundVault`（合约金库，固定唯一地址）
- **lender recipient**：必须等于 `currentLender(orderId)`（动态解析为 A）
- **liquidator recipient**：必须等于本次调用者（keeper/机器人）或其“受限接收地址”
  - 推荐最强约束：`liquidatorRecipient == msg.sender`
  - 若允许 `liquidatorRecipient != msg.sender`，则必须：
    - `liquidatorRecipient` 为合约（可审计/可冻结），且在 Registry 白名单
    - 或 `liquidatorRecipient` 为 `msg.sender` 的预先登记地址（仍需谨慎）

> 建议：为降低“被挪用/被换地址”的风险，**liquidator 奖励也尽量进入一个合约金库**（例如 `LiquidatorRewardVault`），由可审计策略分发给 keeper 节点。

---

## 5) 平台费统一钱包地址（合约金库）与“不可挪用”要求

你已确认：平台费统一钱包地址希望是**合约金库**（而非多签）。

建议定义：

- **PlatformFeeVault（合约）**
  - 只能接收：平台费份额
  - 只能转出：按合约规则（例如：注入保险池、支付协议预算、或跨链托管），且必须通过 Timelock 治理变更

> 若你们也需要“准备金池”，建议同样用合约金库 `ReserveFundVault`（而非多签）。

---

## 6) 冻结止血（Pause / Freeze）与治理（Timelock）

### 6.1 冻结目标

- 任何一方都不能提款/转出（包括平台/多签）
- 出问题立即冻结（分钟级甚至秒级）
- 平台方只能“延长冻结时间”，不能解冻、不能提款
- 解冻必须走 Timelock（48h 延迟，链上可见）

### 6.2 推荐权限模型（双轨）

- **Guardian/Keeper（快速止血）**
  - 权限：`pause()`（仅冻结，不允许转出）
  - 建议：keeper 自动化地址（链下监控触发），或 guardian 多签的快速通道
- **Platform Multisig（运营/治理发起者）**
  - 权限：发起 Timelock 提案（queue），以及 `extendFreeze(until)`（只能延长冻结）
- **Timelock（唯一执行者）**
  - 权限：`unpause()`、升级、参数变更、策略变更等

### 6.3 链下配合（最小集）

- 监控告警：异常清算、异常转出、预言机异常、revert 激增、余额异常等
- keeper 服务：收到告警 → 自动发 `pause()`（幂等）
- Runbook：冻结后检查清单、何时排队解冻、解冻前审计与回归测试

---

## 7) 与现有“残值分配”文档/口径的对齐说明（需要你确认）

你当前业务口径更接近：

- 清算：抵押（RWA）最终进入 **A 钱包**

但残值分配示例（3/2/17/78）意味着：抵押（或残值）会分拆到平台/准备金/清算人等地址。

为避免口径冲突，这里给出两种可选落地策略（请选其一作为最终 SSOT）：

- **策略 S1（保留 3/2/17/78 分配）**：
  - A 获得“出借人补偿份额”（17%）+（若业务需要，可把更多份额配置给 lender）
  - 平台/准备金/清算人各得其份额（平台费进 PlatformFeeVault）
- **策略 S2（清算时抵押 100% 归 A）**：
  - 将 `platformBps/reserveBps/liquidatorBps` 设为 0
  - 将 `lenderBps` 设为 10_000（100%）
  - 平台费改为从“利息/罚金/手续费”收取（不从抵押拆分）

> 你在问题中明确“清算时 RWA 进入 A 钱包”，更贴近 **S2**；  
> 但你也要求“清算时需要考虑 3/2/17/78 示例”，更贴近 **S1**。  
> 请在实施前明确选择 S1 或 S2，避免链上与文档口径分叉。

---

## 8) 最终白名单（收款地址）建议汇总

### 8.1 固定合约收款地址（不随订单变化）

- **PlatformFeeVault（必须）**：平台费统一合约金库
- **ReserveFundVault（可选）**：风险准备金合约金库（若保留 reserve 份额）

### 8.2 动态收款地址（随订单/仓位变化）

- **Borrower（B）**：`borrower(orderId)`（按时还款/提前还款时返还抵押）
- **Lender（A）**：`currentLender(orderId)`（清算时应得抵押/补偿）
- **Liquidator（keeper）**：`msg.sender`（清算执行者奖励，若保留）

### 8.3 关键原则

- **不维护“地址白名单列表”来覆盖 A/B**（不可扩展、易错）  
- **只维护“关系白名单”**：通过仓位/订单状态机解析 `borrower/lender`，并在转出时强校验

---

## 9) 需要补齐/确认的实现细节清单（用于进入开发阶段）

- **统一入口对接**：`KEY_SETTLEMENT_MANAGER → SettlementManager` 的接口与权限（谁可触发 settleOrLiquidate / repayAndSettle）
- **仓位标识（SSOT）**：本项目统一使用 `orderId` 作为“关系白名单”的主键（历史文档的旧称/旧口径一律视为 `orderId`）。
- **A 的权威来源**：`currentLender(orderId)` 从哪读？（LoanNFT/借贷引擎账本/订单合约）
- **B 的权威来源**：`borrower(orderId)` 从哪读？
- **清算人接收策略**：是否保留 `liquidatorBps`？若保留，接收者是否强制为 `msg.sender`？
- **选择 S1 还是 S2**：是否保留 3/2/17/78 分配，或清算 100% 归 A？

