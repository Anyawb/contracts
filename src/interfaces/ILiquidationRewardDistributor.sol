// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { LiquidationTypes } from "../Vault/liquidation/types/LiquidationTypes.sol";

/// @title ILiquidationRewardDistributor
/// @notice 清算奖励分配器接口，负责清算残值的分配和平台收入管理
/// @dev 提供残值分配、平台收入管理、风险准备金管理等功能
/// @dev 积分奖励功能已移至 ILiquidationRewardManager
interface ILiquidationRewardDistributor {
    /* ============ Reward Distribution Functions ============ */
    /// @notice 分配残值
    /// @param collateralAsset 抵押资产地址
    /// @param allocation 残值分配结构
    function distributeResidualValue(
        address collateralAsset,
        LiquidationTypes.ResidualAllocation calldata allocation
    ) external;

    /* ============ Admin Functions ============ */
    /// @notice 更新平台收入接收者
    /// @param newReceiver 新的接收者地址
    function updatePlatformRevenueReceiver(address newReceiver) external;

    /// @notice 更新风险准备金池
    /// @param newPool 新的池地址
    function updateRiskReservePool(address newPool) external;

    /// @notice 更新出借人补偿池
    /// @param newPool 新的池地址
    function updateLenderCompensationPool(address newPool) external;

    /* ============ Query Functions ============ */
    /// @notice 获取平台收入接收者
    /// @return receiver 接收者地址
    function getPlatformRevenueReceiver() external view returns (address receiver);

    /// @notice 获取风险准备金池
    /// @return pool 池地址
    function getRiskReservePool() external view returns (address pool);

    /// @notice 获取出借人补偿池
    /// @return pool 池地址
    function getLenderCompensationPool() external view returns (address pool);

    /* ============ Module Management Functions ============ */
    /// @notice 获取模块地址
    /// @param moduleKey 模块键
    /// @return moduleAddress 模块地址
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);

    /// @notice 更新缓存的模块地址
    function updateCachedModuleAddresses() external;

    /// @notice 获取缓存的抵押物管理器地址
    /// @return collateralManager 抵押物管理器地址
    function getCachedCollateralManager() external view returns (address collateralManager);

    /* ============ Registry Management Functions ============ */
    /// @notice 安排模块升级
    /// @param moduleKey 模块键值
    /// @param newAddress 新模块地址
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external;

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external;

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external;

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键值
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending);
} 