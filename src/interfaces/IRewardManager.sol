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
     * @param hfHighEnough 历史遗留命名；当前由 LendingEngine 传入“按期且足额还清”标志（主要在 repay 场景有意义）
     */
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough) external;
} 

/**
 * @title IRewardManagerV2
 * @notice 借贷奖励回调（V2）：提供 orderId/maturity 以支持“按订单”锁定与释放/扣罚
 * @dev
 * - 兼容策略：LendingEngine 优先调用 V2；若目标实现不支持则回退到 V1 的 onLoanEvent
 * - 设计目标：解决多订单并发下“按用户聚合 + 最近一次 maturity 覆盖”导致的错判问题
 */
interface IRewardManagerV2 {
    /// @notice 借贷事件结果（V2）
    /// @dev Solidity enum ABI 传输为 uint8
    enum LoanEventOutcome {
        Borrow,           // 0：借款落账后（锁定）
        RepayOnTimeFull,  // 1：按期且足额还清（释放并发放）
        RepayEarlyFull,   // 2：提前足额还清（不发放、不处罚）
        RepayLateFull     // 3：逾期足额还清（不发放，按 latePenaltyBps 处罚）
    }

    /**
     * @notice 处理一次借贷事件（V2）
     * @param user 用户地址
     * @param orderId 订单ID（LendingEngine 内生成/管理）
     * @param amount 金额（以最小单位；仅用于统计/链下展示，主路径可能不依赖）
     * @param maturity 订单到期时间戳（秒）
     * @param outcome 事件结果（Borrow/Repay*）
     */
    function onLoanEventV2(address user, uint256 orderId, uint256 amount, uint256 maturity, LoanEventOutcome outcome) external;
}