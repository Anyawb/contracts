// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { LiquidationTypes } from "../Vault/liquidation/types/LiquidationTypes.sol";

/// @title IResidualAllocation
/// @notice 残值分配接口，定义清算后残值分配的相关功能
/// @dev 用于清算模块的残值分配功能
interface IResidualAllocation {
    /* ============ Events ============ */
    /// @notice 残值分配事件
    /// @param user 被清算用户地址
    /// @param totalResidual 总残值金额
    /// @param platformRevenue 平台收入金额
    /// @param riskReserve 风险准备金金额
    /// @param lenderCompensation 出借人补偿金额
    /// @param liquidatorReward 清算人奖励金额
    /// @param timestamp 操作时间戳
    event ResidualAllocated(
        address indexed user,
        uint256 totalResidual,
        uint256 platformRevenue,
        uint256 riskReserve,
        uint256 lenderCompensation,
        uint256 liquidatorReward,
        uint256 timestamp
    );

    /// @notice 平台收入收取事件
    /// @param user 被清算用户地址
    /// @param amount 平台收入金额
    /// @param receiver 接收者地址
    /// @param timestamp 操作时间戳
    event PlatformRevenueCollected(
        address indexed user,
        uint256 amount,
        address indexed receiver,
        uint256 timestamp
    );

    /// @notice 风险准备金增加事件
    /// @param user 被清算用户地址
    /// @param amount 风险准备金金额
    /// @param reservePool 风险准备金池地址
    /// @param timestamp 操作时间戳
    event RiskReserveIncreased(
        address indexed user,
        uint256 amount,
        address indexed reservePool,
        uint256 timestamp
    );

    /// @notice 出借人补偿发放事件
    /// @param user 被清算用户地址
    /// @param amount 补偿金额
    /// @param lender 出借人地址
    /// @param timestamp 操作时间戳
    event LenderCompensationPaid(
        address indexed user,
        uint256 amount,
        address indexed lender,
        uint256 timestamp
    );

    /* ============ Core Functions ============ */
    /// @notice 计算残值分配
    /// @param totalResidual 总残值金额
    /// @return allocation 残值分配详情
    function calculateResidualAllocation(uint256 totalResidual) external pure returns (LiquidationTypes.ResidualAllocation memory allocation);

    /// @notice 执行残值分配
    /// @param user 被清算用户地址
    /// @param asset 资产地址
    /// @param allocation 残值分配详情
    function distributeResidualValue(
        address user,
        address asset,
        LiquidationTypes.ResidualAllocation memory allocation
    ) external;

    /// @notice 预览残值分配
    /// @param totalResidual 总残值金额
    /// @return allocation 残值分配预览
    function previewResidualAllocation(uint256 totalResidual) external pure returns (LiquidationTypes.ResidualAllocation memory allocation);

    /* ============ Query Functions ============ */
    /// @notice 获取平台收入接收地址
    /// @return receiver 平台收入接收地址
    function getPlatformRevenueReceiver() external view returns (address receiver);

    /// @notice 获取风险准备金池地址
    /// @return pool 风险准备金池地址
    function getRiskReservePool() external view returns (address pool);

    /// @notice 获取出借人补偿池地址
    /// @return pool 出借人补偿池地址
    function getLenderCompensationPool() external view returns (address pool);

    /// @notice 获取残值分配比例
    /// @return platformRate 平台收入比例
    /// @return riskReserveRate 风险准备金比例
    /// @return lenderCompensationRate 出借人补偿比例
    /// @return liquidatorRewardRate 清算人奖励比例
    function getResidualAllocationRates() external pure returns (
        uint256 platformRate,
        uint256 riskReserveRate,
        uint256 lenderCompensationRate,
        uint256 liquidatorRewardRate
    );

    /* ============ Admin Functions ============ */
    /// @notice 更新平台收入接收地址
    /// @param newReceiver 新的平台收入接收地址
    function updatePlatformRevenueReceiver(address newReceiver) external;

    /// @notice 更新风险准备金池地址
    /// @param newPool 新的风险准备金池地址
    function updateRiskReservePool(address newPool) external;

    /// @notice 更新出借人补偿池地址
    /// @param newPool 新的出借人补偿池地址
    function updateLenderCompensationPool(address newPool) external;
} 