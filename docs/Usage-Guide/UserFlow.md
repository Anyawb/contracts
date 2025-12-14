用户使用流程文档（User Flow）
🎯 目标简介
平台支持自由借贷匹配，用户可以作为借方或贷方，通过平台撮合匹配，实现对 RWA 抵押资产的资金流转，并以智能合约自动完成借贷、清算、积分发放等全过程。

🧭 用户流程总览
mermaid:
flowchart TD
    A[注册+KYC] --> B[选择或创建借贷意向]
    B --> C{用户角色}
    C -->|借方| D1[创建抵押借贷意向]
    C -->|贷方| D2[发布出借意向]
    C -->|撮合借方| D3[浏览已有借贷订单]
    D1 & D2 & D3 --> E[平台撮合逻辑]
    E --> F[撮合成功 → 自动上链]
    F --> G[借方领取USDT]
    G --> H[进入计息期]
    H --> I[到期或提前还款]
    I --> J{是否履约}
    J -->|履约| K[释放抵押物 + 发放积分]
    J -->|违约| L[违约清算 → 残值分配]
🧑‍💼 用户注册与身份验证
所有用户需通过注册并绑定钱包地址；

平台可选启用 KYC 验证 用于合规限制（例如某类资产只能面向合规用户）；

🔁 借贷意向匹配流程
1. 用户角色分类
用户类型	动作	示例说明
用户1（借方）	发布抵押贷款意向	例如：抵押黄金RWA，借款8500USDT，利率3%，周期30天
用户2（借方）	浏览出借订单，选择认领并借款	例如：找到用户3发布的 10000 USDT 出借意向，匹配800USDT，10天，3%
用户3（贷方）	提交出借意向	例如：出借10000 USDT，利率3%，锁仓10天

⚖️ 撮合规则与优先级
平台基于链下撮合逻辑，采用“最优匹配优先顺序”：

✅ 撮合优先级建议（可用于前端排序或合约匹配逻辑）：
利率匹配程度（越接近优先）

借贷期限匹配程度（越一致优先）

撮合双方剩余可匹配额度是否充足

响应时间顺序（先确认者优先）

📌 若多个用户同时点击确认，默认：

出借人优先于借款人

若同为借款人或出借人，按区块时间戳排序

💰 撮合与上链落地逻辑（统一编排：SettlementMatchLib.finalizeAtomicFull）
撮合成功后（VBL 仅做签名/保留校验），`SettlementMatchLib.finalizeAtomicFull` 执行以下步骤：

1) **白名单与权限检查**：验证资产白名单和调用者权限（ACTION_ORDER_CREATE）

2) **可选抵押物存入**：如果提供了抵押资产，通过 `CollateralManager.depositCollateral` 存入抵押物

3) **账本写入**：通过 `VaultCore.borrowFor(borrower, asset, amount, termDays)` 完成账本写入
   - ⚠️ **注意**：当前 `VaultCore.sol` 中 `borrowFor` 函数在接口 `IVaultCore` 中定义但尚未实现
   - 实际账本写入通过 `VaultView.processUserOperation` 处理，更新 View 层缓存
   - 对于 BORROW 操作，VaultView 更新本地债务缓存 `_userDebt[user][asset]`

4) **订单创建**：调用订单引擎 `LendingEngine.createLoanOrder(order)` 完成：
   - 订单创建与存储
   - LoanNFT 铸造（带重试机制）
   - 统一 DataPush 事件推送
   - 奖励触发（RewardManager.onLoanEvent）

5) **费用分发**：库内先授权 FeeRouter，调用 `FeeRouter.distributeNormal(token, amount)` 拉取并分发费用
   - 平台费和生态费从借款金额中扣除
   - FeeRouter 从调用者（VaultBusinessLogic）拉取费用

6) **净额发放**：将 `amount - 平台费 - 生态费` 的净额转给借方
   - 净额 = amount - (amount × platformFeeBps / 10000) - (amount × ecoFeeBps / 10000)

订单记录包括：
- 抵押资产地址与数量
- 借贷金额、利率、周期
- 借方/贷方钱包地址
- 到期日、利息计算规则
- 违约清算参数

📦 借款释放与记账流程（撮合路径）
借款人在完成抵押（可选）后：

- **账本写入流程**：
  - `SettlementMatchLib.finalizeAtomicFull` 调用 `VaultCore.borrowFor`（当前通过 call 方式，需实现）
  - `VaultCore` 将操作传送至 `VaultView.processUserOperation`
  - `VaultView` 验证操作、更新本地缓存（`_userDebt[user][asset] += amount`）、发出事件
  - 账本写入与风险/视图推送由 LendingEngine + View 路径统一处理；VBL 不直接访问预言机

- **费用处理**：费用在编排中执行：FeeRouter 从 VaultBusinessLogic 拉取费用并分发，借方收到净额
- **示例费率**（可配置）：平台费和生态费各 0.03%（具体费率由 FeeRouter 配置决定）

🧮 示例：800 USDT 借款 → 各扣 0.24 USDT → 借方净得 799.52 USDT（含方向差异以 FeeRouter 配置为准）

⏱️ 计息周期内处理
借方收到资金后，计息开始；

贷方资产处于锁仓状态；

用户可以在 UI 查看实时还款、清算、积分状态；

🧾 到期还款流程
✅ 借方主动还款（履约）

**还款流程**（通过 `LendingEngine.repay(orderId, repayAmount)`）：

1. **借方还款**：借方调用 `LendingEngine.repay`，传入订单ID和还款金额（本金 + 利息）
   - 需要 `ACTION_REPAY` 权限
   - 还款金额必须 > 0 且 ≤ 剩余应还金额
   - 订单必须存在且未完全还清

2. **费用计算与分发**：
   - 还款手续费 = 还款金额 × 0.06% (REPAY_FEE_BPS = 6)
   - 贷方收到金额 = 还款金额 - 还款手续费
   - 手续费从借方转入 LendingEngine 合约，再授权给 FeeRouter
   - 手续费通过 `FeeRouter.distributeNormal` 分发（带优雅降级，失败时记录但不中断流程）

3. **资金流转**：
   - 借方需先授权 LendingEngine 合约可转出还款金额
   - 手续费部分转入 LendingEngine，再授权给 FeeRouter
   - 贷方收到金额从借方直接转入贷方地址（`safeTransferFrom`）

4. **状态更新**：
   - 更新订单还款状态：`ord.repaidAmount += _repayAmount`
   - 如果全部还清（`repaidAmount >= totalDue`），更新 LoanNFT 状态为 `Repaid`
   - 发出 `LoanRepaid` 事件和 DataPush 事件（DATA_TYPE_LOAN_REPAID）

5. **奖励触发**：
   - 检查是否按期且足额还款：
     - 按期窗口：到期日 ±24小时（ON_TIME_WINDOW = 24 hours）
     - 足额：`repaidAmount >= totalDue`
   - 调用 `RewardManager.onLoanEvent(borrower, repayAmount, 0, isOnTimeAndFullyRepaid)` 触发积分奖励
   - 借方和贷方根据履约情况获得积分

**示例**：还款 800 USDT（本金 + 利息）
- 还款手续费：800 × 0.06% = 0.48 USDT
- 贷方收到：800 - 0.48 = 799.52 USDT

❌ 违约清算逻辑
情况一：到期未还
若借方在到期后 24h 内未还清，将进入清算流程：

没收抵押品

由系统判断 已归还金额占比（如只还400/800）

情况二：资产波动超过 ±5%
若 RWA 资产价格浮动超过 ±5%，

系统发送提示，借方需在 24h 内补足/偿还本金；

否则按 全额违约清算 处理。

🧠 清算价值分配规则
条件	抵押资产价值	分配方式
借方只还 400/800 USDT	黄金RWA=1000 USDT	用户2（贷方）拿回 500；
剩余 500 分配：
• 用户3（借方） 97%
• 残值池 2%
• 平台 1%
全额违约	0 USDT 归还	黄金RWA 全额清算，平台根据价格进行再分配

🧮 示例流程图（更新后）
mermaid:
sequenceDiagram
    participant Borrower as 用户2（借方）
    participant Lender as 用户3（贷方）
    participant VBL as VaultBusinessLogic
    participant MatchLib as SettlementMatchLib
    participant VaultCore as VaultCore
    participant VaultView as VaultView
    participant LE as LendingEngine
    participant Router as FeeRouter
    participant System as 撮合系统

    Borrower->>System: 提交借贷意向（800 USDT）
    Lender->>System: 提交出借意向（10000 USDT）
    System-->>VBL: 撮合成功（校验签名/保留）→ finalizeMatch
    VBL->>MatchLib: finalizeAtomicFull(...)
    MatchLib->>MatchLib: 1. 白名单与权限检查
    MatchLib->>MatchLib: 2. 可选抵押物存入（CollateralManager）
    MatchLib->>VaultCore: 3. borrowFor(borrower, asset, 800, termDays)
    Note over VaultCore: ⚠️ 当前需实现此函数
    VaultCore->>VaultView: processUserOperation(ACTION_BORROW)
    VaultView->>VaultView: 更新本地缓存 _userDebt
    VaultView-->>MatchLib: 账本写入完成
    MatchLib->>LE: 4. createLoanOrder(order)
    LE->>LE: 创建订单、铸造NFT、触发奖励、DataPush
    MatchLib->>Router: 5. approve & distributeNormal(token, 800)
    Router->>Router: 扣除平台费和生态费
    Router-->>MatchLib: 费用分发完成
    MatchLib->>MatchLib: 6. 计算净额 = 800 - 平台费 - 生态费
    MatchLib-->>Borrower: 转账净额（约 799.52 USDT）
    Note over Borrower, Lender: 开始计息周期
🎁 积分激励机制（可扩展）
触发行为	借方奖励	贷方奖励
成功履约	获得平台积分 10	获得平台积分 8
参与清算（执行人）	-	清算额 2% 奖励

🔐 风控提醒（平台 & 前端联动）
健康因子 < 1 → 前端高亮并提示补仓；

Vault 未注册或未审核 → 禁止借贷操作；

池子资金利用率过高 → 提示等待或提高利率；
