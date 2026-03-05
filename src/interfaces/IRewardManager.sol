// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRewardManager 奖励管理接口
/// @notice 当借款/还款/抵押变动发生时触发激励逻辑
/// @dev 实现合约可根据业务规则累积积分或分发 Token
interface IRewardManager {
    /**
     * @notice 处理一次借贷事件（落账后触发的标准入口）
     * @param user 用户地址
     * @param amount 金额（以最小单位，USDT/USDC按 6 位，ETH 按 18 位）
     * @param duration 借款时长（秒），还款时可为 0
     * @param hfHighEnough 历史遗留命名；当前语义为 `isOnTimeAndFullyRepaid`（按期且足额还清，由 LendingEngine 计算并传入；主要在 repay 场景有意义）。
     *        注意：**不要**将其按旧名误解为“健康因子足够（HealthFactor）”。
     */
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough) external;
} 

/**
 * @title IRewardManagerByOrder
 * @notice 借贷奖励回调（按订单维度）：提供 orderId/maturity 以支持“按订单”锁定与释放/扣罚
 * @dev
 * - 兼容策略：LendingEngine 优先调用“按订单维度”入口；若目标实现不支持则回退到 legacy 的 onLoanEvent
 * - 设计目标：解决多订单并发下“按用户聚合 + 最近一次 maturity 覆盖”导致的错判问题
 */
interface IRewardManagerByOrder {
    /// @notice 借贷事件结果（按订单维度）
    /// @dev Solidity enum ABI 传输为 uint8
    enum LoanEventOutcome {
        Borrow,           // 0：借款落账后（锁定）
        RepayOnTimeFull,  // 1：按期且足额还清（释放并发放）
        RepayEarlyFull,   // 2：提前足额还清（不发放、不处罚）
        RepayLateFull     // 3：逾期足额还清（不发放，按 latePenaltyBps 处罚）
    }

    /**
     * @notice 处理一次借贷事件（按订单维度）
     * @param user 用户地址
     * @param orderId 订单ID（LendingEngine 内生成/管理）
     * @param amount 金额（以最小单位；仅用于统计/链下展示，主路径可能不依赖）
     * @param maturity 订单到期区块高度（maturityBlock，SSOT：block-based；非 timestamp 秒）
     * @param outcome 事件结果（Borrow/Repay*）
     */
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        LoanEventOutcome outcome
    ) external;
}

/**
 * @title IRewardManagerByOrderWithLender
 * @notice Order-based callback with lender + asset context for Easy emission
 */
interface IRewardManagerByOrderWithLender {
    /**
     * @notice 处理一次借贷事件（按订单维度，含 lender 与 asset）
     * @param borrower 借款人地址
     * @param lender 出借人地址（lender signer）
     * @param asset 借贷资产地址
     * @param orderId 订单ID
     * @param amount 金额（以最小单位；建议为本金）
     * @param maturity 订单到期区块高度（maturityBlock）
     * @param outcome 事件结果（Borrow/Repay*）
     */
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external;
}