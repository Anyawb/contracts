// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IEarlyRepaymentGuaranteeManager
/// @notice 提前还款保证金管理接口
/// @dev 定义提前还款保证金管理的核心功能接口
interface IEarlyRepaymentGuaranteeManager {
    /* ============ Structs ============ */
    /// @notice 保证金记录结构
    struct GuaranteeRecord {
        uint256 principal;                    // 借款本金
        uint256 promisedInterest;             // 承诺的利息（保证金）
        uint256 startTime;                    // 借款开始时间
        uint256 maturityTime;                 // 到期时间
        uint256 earlyRepayPenaltyDays;        // 提前还款罚金天数
        bool isActive;                        // 是否活跃
        address lender;                       // 贷款方地址
        address asset;                        // 资产地址
    }

    /// @notice 提前还款结果结构
    struct EarlyRepaymentResult {
        uint256 penaltyToLender;              // 给贷款方的罚金
        uint256 refundToBorrower;             // 返还给借款方的金额
        uint256 platformFee;                  // 平台手续费
        uint256 actualInterestPaid;           // 实际支付的利息
    }

    /* ============ Events ============ */
    /// @notice 保证金锁定事件
    event GuaranteeLocked(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 startTime,
        uint256 maturityTime,
        uint256 timestamp
    );

    /// @notice 提前还款处理事件
    event EarlyRepaymentProcessed(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 penaltyToLender,
        uint256 refundToBorrower,
        uint256 platformFee,
        uint256 actualInterestPaid,
        uint256 timestamp
    );

    /// @notice 保证金没收事件（违约）
    event GuaranteeForfeited(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 forfeitedAmount,
        uint256 timestamp
    );

    /* ============ View Functions ============ */
    /// @notice 查询保证金记录
    /// @param guaranteeId 保证金ID
    /// @return record 保证金记录
    function getGuaranteeRecord(uint256 guaranteeId) external view returns (GuaranteeRecord memory record);

    /// @notice 查询用户的保证金ID
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return guaranteeId 保证金ID
    function getUserGuaranteeId(address user, address asset) external view returns (uint256 guaranteeId);

    /// @notice 查询用户是否有活跃的保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return isActive 是否有活跃保证金
    function hasActiveGuarantee(address user, address asset) external view returns (bool isActive);

    /// @notice 预览提前还款结果
    /// @param guaranteeId 保证金ID
    /// @param actualRepayAmount 实际还款金额
    /// @return result 提前还款结果
    function previewEarlyRepayment(
        uint256 guaranteeId,
        uint256 actualRepayAmount
    ) external view returns (EarlyRepaymentResult memory result);

    /* ============ Core Functions ============ */
    /// @notice 锁定保证金记录
    /// @param borrower 借款方地址
    /// @param lender 贷款方地址
    /// @param asset 资产地址
    /// @param principal 本金金额
    /// @param promisedInterest 承诺利息金额
    /// @param termDays 借款期限（天）
    /// @return guaranteeId 保证金ID
    function lockGuaranteeRecord(
        address borrower,
        address lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 termDays
    ) external returns (uint256 guaranteeId);

    /// @notice 处理提前还款
    /// @param borrower 借款方地址
    /// @param asset 资产地址
    /// @param actualRepayAmount 实际还款金额
    /// @return result 提前还款结果
    function settleEarlyRepayment(
        address borrower,
        address asset,
        uint256 actualRepayAmount
    ) external returns (EarlyRepaymentResult memory result);

    /// @notice 处理违约（没收保证金）
    /// @param borrower 借款方地址
    /// @param asset 资产地址
    /// @return forfeitedAmount 没收金额
    function processDefault(
        address borrower,
        address asset
    ) external returns (uint256 forfeitedAmount);
} 