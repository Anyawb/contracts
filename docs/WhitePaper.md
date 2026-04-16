# Easy 代币经济学白皮书

副标题：EasiFi 抵押借贷协议的平台治理与生态通证说明

最后更新：2026年4月6日

适用范围：本文以当前仓库已经实现并可验证的链上模块为准，重点覆盖 EasyToken、Reward、EasyEmission、EasyConsumption、EasyRecycle、EasyStaking、GovernanceGate 与 AICreditsVault 的现行口径。

---

## 一、项目概述

### 1.1 项目背景

EasiFi 致力于在现实世界资产、稳定币与主流加密资产之间建立可组合的链上借贷与治理基础设施。协议希望把 RWA 的稳健收益特征与 DeFi 的开放流动性结合起来，为用户提供透明、可审计、可治理的金融服务。

### 1.2 协议定位

EasiFi 的核心链上能力围绕以下几类模块展开：

- 抵押借贷与结算
- 奖励与扣罚
- 通证发行、消费与回收
- 质押治理与权限门控
- AI Credits 的链上审计余额与批量结算

Easy 是这些机制中的统一生态通证，但并不承担所有高频业务计费。当前实现中，Easy 与 AI Credits 已经被明确拆分为两套账本与场景。

### 1.3 Easy 的角色

Easy 是 EasiFi 协议当前唯一的治理与生态通证，承担三类核心职责：

- 作为借贷激励通证，在满足条件的订单结清后发放给借款人与出借方
- 作为部分生态能力的链上支付通证，用于按次调用 EasiM 与策略 API
- 作为治理权益底层资产，经质押后生成 stEASY，用于链上投票与治理资格校验

---

## 二、Easy 的基础信息

### 2.1 名称与符号

- 代币全称：Easy Governance Token
- 代币符号：Easy
- 质押包装资产：stEASY

### 2.2 技术标准

当前实现中的 EasyToken 具备以下属性：

- ERC-20
- ERC20Permit
- ERC20Votes
- 18 位小数
- UUPS 可升级
- 可暂停

stEASY 是 Easy 的 1:1 质押包装资产，具备 ERC20Votes 的投票快照能力，但不允许普通地址之间自由转移。

### 2.3 供应机制

- Easy 没有预挖、私募或 ICO 逻辑
- Easy 总量不预设上限，供应由借贷奖励发放与后续销毁机制动态决定
- 当前推荐单点发行者为 EasyEmissionController
- 当前推荐 burn 执行者为 RewardAccrualManager 与 EasyRecycleDistributor

### 2.4 当前支持的链上范围

当前仓库与测试体系以 EVM 网络为主，重点覆盖：

- Arbitrum Sepolia
- BNB Testnet
- localhost / fork / 测试环境

未来可以扩展到更多网络，但是否上线、何时上线、上线何种模块，以社区治理与正式部署公告为准。

---

## 三、Easy 的发行规则

### 3.1 发放触发条件

Easy 的主发行路径不是“借出即发”，而是“订单足额结清后再发”。当前链上实现的触发口径如下：

- 借款创建时：只记录 Reward 锁定，不直接铸币
- 订单结清时：由 EasyEmissionController 根据 repay outcome 判断是否进入发放逻辑
- 支持发放的 outcome：RepayOnTimeFull、RepayEarlyFull、RepayLateFull

这意味着，用户在借款刚发生时看不到钱包余额增加，是当前实现的正常表现。

### 3.2 最低门槛与计价口径

- 只有当订单金额折算后的统一 value 不低于 1000U 时，才进入 Easy 发放逻辑
- 当前统一估值口径采用 18 decimals 的 system valuation unit
- 如果价格不可用、估值无效或参数不兼容，发放会被跳过，但不会回滚借贷主流程

### 3.3 手续费与净额口径

平台总费率目前维持在 0.6% 的白皮书口径，其中：

- 借款侧费率：0.3%
- 还款侧费率：0.3%

Easy 发放基于借款侧扣除 0.3% 手续费后的净借款额，而不是原始毛额。

### 3.4 红利期与通缩期公式

当前 EasyEmissionConfig 的默认参数与实现逻辑如下：

- 红利期阈值：平台累计借贷量低于 100,000,000 个统一 value 单位
- 红利期发放：每 1000U 发行 10 Easy
- 发放分配：借款人与出借方各 50%

红利期公式：

$$
\text{minted} = \frac{\text{netBorrowValue}}{1000} \times 10
$$

进入通缩期后，发放与链上留存 Easy 数量负相关。当前实现以 Easy 总供应量折算后的留存量作为公式输入：

$$
\text{minted} = \frac{\text{borrowValue}}{100} \div \left(1 + k \times \text{retainedEasy}\right)
$$

其中：

- $k = \frac{kNum}{kDen}$
- 默认参数为 $kNum = 1$、$kDen = 10{,}000{,}000$
- retainedEasy 采用 EasyToken.totalSupply() 按 18 decimals 折算后的数量

### 3.5 欠账抵扣规则

如果借款人或出借方存在待抵扣 penalty debt，系统会先用本次应发放的 Easy 进行抵扣，再对剩余额度执行 mint。

因此：

- 本次理论发放数量不一定等于实际到账数量
- 在极端情况下，本次发放可能被全部抵扣，最终不产生新增余额

---

## 四、Reward 锁定、释放与扣罚

### 4.1 借款阶段：先锁定，不立即发币

RewardManagerCore 会在借款时为符合门槛的订单记录锁定 Easy。当前默认基线为：

- 每笔合格订单基线锁定 1 Easy
- 再乘以用户当前 Reward Level 对应的 levelMultiplierBps
- 可选叠加动态奖励倍数

只有当订单本金达到 1000 USDC 基线门槛时，才会进入这条锁定路径。

### 4.2 订单结清后的处理

- 按期足额还款：释放锁定，增加按期计数，并允许后续发放逻辑执行
- 提前足额还款：锁定失效，不处罚，但仍可进入 Easy 发放逻辑
- 逾期足额还款：锁定失效，并按 latePenaltyBps 计入扣罚

当前默认 latePenaltyBps 为 500，即 5%。

### 4.3 清算扣罚

如果订单进入清算或违约处置，GuaranteeFundManager 会通过 RewardManager 触发清算惩罚。当前实现中：

- 清算罚值以用户当前 aggregated lockedEasy 为基数
- 默认 liquidationPenaltyBps 为 500，即 5%
- 优先直接 burn 用户 Easy
- 若余额不足，则进入 penalty ledger，等待后续奖励抵扣

### 4.4 等级体系

当前实现中需要区分两套等级：

- Reward Level：1 到 5，用于借贷奖励、长期借款门槛与 Earn 侧倍率
- ServiceLevel：Basic、Standard、Premium、VIP，用于治理与功能门控

两套等级不等价，也不能混用。

---

## 五、Easy 的使用与回收

### 5.1 当前已经落地的链上消费场景

当前代码里已经稳定实现的 Easy 按次消费，只有两类：

- 每次调用 EasiM，消耗 1 Easy
- 每次调用策略 API，消耗 1 Easy

这两种消费统一走：

$$
\text{EasyConsumption} \rightarrow \text{EasyRecycleDistributor}
$$

任何旁路消费都不属于推荐主路径。

### 5.2 回收、销毁与分配

EasyRecycleDistributor 会对每次消费进入的 Easy 按固定比例处理：

- 75% 永久销毁
- 15% 分配给 team recipient
- 10% 分配给 ecosystem recipient

该拆分是当前实现的固定主路径，也是 Easy 通缩机制的核心来源之一。

### 5.3 异常余额恢复

如果用户误将 Easy 直接转入 EasyRecycleDistributor，而不是通过 EasyConsumption 进入，系统仍可通过：

- settleOutstandingEasyBalance()

把该余额按同样的 75/15/10 规则补做结算，避免出现长期滞留的异常余额。

### 5.4 AI Credits 的独立边界

需要特别说明的是：

- 高频 AI 调用计费不应直接通过逐次 burn Easy 完成
- 当前仓库已经实现 AICreditsVault，作为 AI Credits 的链上审计余额 SSOT
- 高频扣次、失败退款、链下 usage ledger 与批量 settle，不属于 Reward 域主账本

因此，Easy 与 AI Credits 在现行架构中是并存但分工不同的两套机制。

### 5.5 其它生态场景

Easy 仍然可以作为更广义的生态激励与治理通证，例如：

- 社区任务激励
- 模拟场排行榜奖励
- 生态合作奖励

但这些场景是否上线、如何上线、是否直接由当前主合约承载，需要以后续治理与版本迭代为准。本文只把当前仓库中已经实现的主路径作为强口径。

---

## 六、Easy 与平台治理

### 6.1 质押获得投票权

用户若要参与治理，不是直接拿钱包里的 Easy 余额去投票，而是需要先把 Easy 质押到 EasyStaking：

- 质押多少 Easy，就铸造多少 stEASY
- stEASY 是不可自由转移的治理包装资产
- 用户首次质押时会自动 self-delegate，激活 ERC20Votes 快照投票能力

### 6.2 投票权的计算方式

治理资格与投票权读取遵循当前实现的标准 IVotes 快照模式：

$$
\text{votingPower} = \text{IVotes.getPastVotes}(user, snapshotBlock)
$$

推荐快照口径为：

$$
snapshotBlock = proposal.startBlock - 1
$$

这样可以避免同区块快照带来的边界问题。

### 6.3 GovernanceGate 的当前默认策略

当前 GovernanceGate 默认启用，并采用以下基线策略：

- 仅 VIP 用户可 vote / propose
- 可以叠加最小投票权门槛
- 如果 votesToken 未正确配置，治理资格会被直接判定为不合格

这保证了治理门控具有明确的链上 SSOT，不依赖链下口径或前端推断。

### 6.4 DAO 演进方向

EasiFi 的治理目标是逐步把参数调整、模块升级、生态资源使用等关键决策，收敛到更透明的社区治理流程中。当前代码已经提供了：

- 投票权质押基础设施
- 治理资格门控
- 参数写入口聚合
- 可升级模块的权限化治理路径

未来治理范围的进一步扩大，将通过正式治理升级逐步开放。

---

## 七、风险提示

### 7.1 智能合约与系统风险

包括但不限于：

- 智能合约漏洞
- 模块升级配置错误
- 权限授予错误
- Price Oracle 异常或估值失效
- 观测镜像推送失败

需要注意的是，RewardView 的 DataPushed 属于统一观测层，但当前 push 仍是 best-effort。观测失败不必然代表主账本失败。

### 7.2 市场与流动性风险

Easy 在二级市场上的流动性、价格与波动情况由市场决定，协议不对价格稳定性、流动性深度或收益结果作任何承诺。

### 7.3 合规与监管风险

不同司法辖区对加密资产、DeFi 协议、治理通证与 RWA 业务的监管要求可能存在显著差异。用户应自行理解并承担合规义务。

### 7.4 用户责任风险

用户需要自行妥善保管私钥、签名设备、授权额度与操作流程。因密钥丢失、误授权、误转账、钓鱼攻击等造成的损失，由用户自行承担。

---

## 八、附则

### 8.1 文档效力

本文是 EasiFi Easy 经济模型的公开说明文档，但任何最终执行结果都以当前链上合约、治理升级结果和正式部署配置为准。

### 8.2 非投资建议

本文不构成任何形式的投资建议、收益承诺、理财意见或法律要约。

### 8.3 更新机制

当协议参数、治理策略、部署网络或消费边界发生重大变化时，本文将同步更新。

easifi.io

2026年4月