// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistryUpgradeEvents } from "./IRegistryUpgradeEvents.sol";

/**
 * @title ILiquidationGuaranteeManager
 * @dev 清算保证金管理器接口 - 负责清算保证金的存储、查询和管理
 * @dev Liquidation Guarantee Manager Interface - Responsible for liquidation guarantee storage, query and management
 * @dev 从 ILiquidationDebtManager 拆分出的清算保证金管理接口
 * @dev Liquidation guarantee management interface split from ILiquidationDebtManager
 * @dev 完全集成Registry系统进行模块管理
 * @dev Fully integrated with Registry system for module management
 */
interface ILiquidationGuaranteeManager is IRegistryUpgradeEvents {
    /* ============ Events ============ */
    
    /**
     * 保证金没收事件 - 当用户保证金被没收时触发
     * Guarantee forfeited event - Triggered when user guarantee is forfeited
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param amount 没收数量 Forfeited amount
     * @param timestamp 时间戳 Timestamp
     */
    event GuaranteeForfeited(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /**
     * 保证金更新事件 - 当用户保证金更新时触发
     * Guarantee updated event - Triggered when user guarantee is updated
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param oldAmount 旧数量 Old amount
     * @param newAmount 新数量 New amount
     * @param timestamp 时间戳 Timestamp
     */
    event GuaranteeUpdated(
        address indexed user,
        address indexed asset,
        uint256 oldAmount,
        uint256 newAmount,
        uint256 timestamp
    );

    // Registry升级相关事件已在 IRegistryUpgradeEvents 中定义

    /* ============ Registry Management Functions ============ */
    
    /**
     * 安排模块升级 - 安排指定模块的升级
     * Schedule module upgrade - Schedule upgrade for specified module
     * @param moduleKey 模块键值 Module key
     * @param newAddress 新模块地址 New module address
     */
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external;

    /**
     * 执行模块升级 - 执行指定模块的升级
     * Execute module upgrade - Execute upgrade for specified module
     * @param moduleKey 模块键值 Module key
     */
    function executeModuleUpgrade(bytes32 moduleKey) external;

    /**
     * 取消模块升级 - 取消指定模块的升级
     * Cancel module upgrade - Cancel upgrade for specified module
     * @param moduleKey 模块键值 Module key
     */
    function cancelModuleUpgrade(bytes32 moduleKey) external;

    /**
     * 获取待升级信息 - 获取指定模块的待升级信息
     * Get pending upgrade info - Get pending upgrade info for specified module
     * @param moduleKey 模块键值 Module key
     * @return newAddress 新地址 New address
     * @return executeAfter 执行时间 Execute after timestamp
     * @return hasPending 是否有待升级 Whether has pending upgrade
     */
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending);

    /**
     * 检查升级是否准备就绪 - 检查指定模块的升级是否准备就绪
     * Check if upgrade is ready - Check if upgrade is ready for specified module
     * @param moduleKey 模块键值 Module key
     * @return isReady 是否准备就绪 Whether is ready
     */
    function isUpgradeReady(bytes32 moduleKey) external view returns (bool isReady);

    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从缓存中获取模块地址
     * Get module address - Get module address from cache
     * @param moduleKey 模块键值 Module key
     * @return moduleAddress 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external;

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external;

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external;

    /* ============ Core Guarantee Management Functions ============ */
    
    /**
     * 没收用户保证金 - 没收指定用户的保证金
     * Forfeit user guarantee - Forfeit guarantee for specified user
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param amount 没收数量 Forfeited amount
     */
    function forfeitGuarantee(address user, address asset, uint256 amount) external;

    /**
     * 批量没收用户保证金 - 批量没收多个用户的保证金
     * Batch forfeit user guarantees - Batch forfeit guarantees for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @param amounts 没收数量数组 Array of forfeited amounts
     */
    function batchForfeitGuarantees(
        address[] calldata users,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;

    /**
     * 更新用户保证金 - 更新指定用户的保证金
     * Update user guarantee - Update guarantee for specified user
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param amount 保证金数量 Guarantee amount
     */
    function updateUserGuarantee(address user, address asset, uint256 amount) external;

    /* ============ Query Functions ============ */
    
    /**
     * 获取用户保证金 - 获取指定用户的保证金
     * Get user guarantee - Get guarantee for specified user
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @return guaranteeAmount 保证金数量 Guarantee amount
     */
    function getUserGuarantee(address user, address asset) external view returns (uint256 guaranteeAmount);

    /**
     * 获取用户所有保证金 - 获取指定用户的所有保证金
     * Get user's all guarantees - Get all guarantees for specified user
     * @param user 用户地址 User address
     * @return assets 资产地址数组 Array of asset addresses
     * @return amounts 保证金数量数组 Array of guarantee amounts
     */
    function getUserAllGuarantees(
        address user
    ) external view returns (
        address[] memory assets,
        uint256[] memory amounts
    );

    /**
     * 预览没收保证金 - 预览没收保证金的金额
     * Preview forfeit guarantee - Preview forfeited guarantee amount
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @param amount 没收数量 Forfeited amount
     * @return forfeitedAmount 实际没收数量 Actual forfeited amount
     */
    function previewForfeitGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external view returns (uint256 forfeitedAmount);

    /**
     * 检查用户是否有保证金 - 检查指定用户是否有保证金
     * Check if user has guarantee - Check if specified user has guarantee
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @return hasGuarantee 是否有保证金 Whether has guarantee
     */
    function hasUserGuarantee(address user, address asset) external view returns (bool hasGuarantee);

    /**
     * 获取用户保证金数量 - 获取指定用户的保证金数量
     * Get user guarantee count - Get guarantee count for specified user
     * @param user 用户地址 User address
     * @return guaranteeCount 保证金数量 Guarantee count
     */
    function getUserGuaranteeCount(address user) external view returns (uint256 guaranteeCount);

    /* ============ Batch Query Functions ============ */
    
    /**
     * 批量获取用户保证金 - 批量获取多个用户的保证金
     * Batch get user guarantees - Batch get guarantees for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @return amounts 保证金数量数组 Array of guarantee amounts
     */
    function batchGetUserGuarantees(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (uint256[] memory amounts);
} 