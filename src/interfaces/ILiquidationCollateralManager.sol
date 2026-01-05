// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ⚠️ 重要说明：View合约相关功能已暂时注释
 * 
 * 在View合约部署后再升级内容
 */

/// @title ILiquidationCollateralManager
/// @notice 清算抵押物管理器接口，负责清算时的抵押物处理
/// @dev 从 CollateralManager 拆分出的清算抵押物处理功能
interface ILiquidationCollateralManager {
    /* ============ Events ============ */
    /// @notice 清算抵押物扣押事件
    /// @param liquidator 清算人地址
    /// @param user 被清算用户地址
    /// @param asset 抵押资产地址
    /// @param amount 扣押数量
    /// @param timestamp 操作时间戳
    event LiquidationCollateralSeized(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice 清算抵押物转移事件
    /// @param from 转移方地址
    /// @param to 接收方地址
    /// @param asset 资产地址
    /// @param amount 转移数量
    /// @param timestamp 操作时间戳
    event LiquidationCollateralTransferred(
        address indexed from,
        address indexed to,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice 清算抵押物记录更新事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param oldAmount 旧扣押数量
    /// @param newAmount 新扣押数量
    /// @param timestamp 更新时间戳
    event LiquidationCollateralRecordUpdated(
        address indexed user,
        address indexed asset,
        uint256 oldAmount,
        uint256 newAmount,
        uint256 timestamp
    );

    /* ============ Core Liquidation Functions ============ */
    /// @notice 扣押用户抵押物
    /// @param user 被清算用户地址
    /// @param asset 抵押资产地址
    /// @param amount 扣押数量
    /// @param liquidator 清算人地址
    /// @return seizedAmount 实际扣押数量
    function seizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external returns (uint256 seizedAmount);

    /// @notice 批量扣押用户抵押物
    /// @param user 被清算用户地址
    /// @param assets 抵押资产地址数组
    /// @param amounts 扣押数量数组
    /// @param liquidator 清算人地址
    /// @return seizedAmounts 实际扣押数量数组
    function batchSeizeCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external returns (uint256[] memory seizedAmounts);

    /// @notice 转移清算抵押物给清算人
    /// @param asset 资产地址
    /// @param amount 转移数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external;

    /* ============ Query Functions ============ */
    /// @notice 获取用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address user, address asset) external view returns (uint256 seizableAmount);

    /// @notice 获取用户所有可清算抵押物
    /// @param user 用户地址
    /// @return assets 资产地址数组
    /// @return amounts 数量数组
    function getSeizableCollaterals(address user) external view returns (address[] memory assets, uint256[] memory amounts);

    /// @notice 计算抵押物价值
    /// @param asset 资产地址
    /// @param amount 数量
    /// @return value 价值（以结算币计价）
    function calculateCollateralValue(address asset, uint256 amount) external view returns (uint256 value);

    /// @notice 获取用户抵押物总价值
    /// @param user 用户地址
    /// @return totalValue 总价值
    function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue);

    /// @notice 预览清算抵押物状态
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param seizeAmount 扣押数量
    /// @return newCollateralAmount 新的抵押物数量
    /// @return newTotalValue 新的总价值
    function previewLiquidationCollateralState(
        address user,
        address asset,
        uint256 seizeAmount
    ) external view returns (uint256 newCollateralAmount, uint256 newTotalValue);

    /* ============ Liquidation Record Functions ============ */
    /// @notice 获取用户清算抵押物记录
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizedAmount 已扣押数量
    /// @return lastSeizedTime 最后扣押时间
    function getLiquidationCollateralRecord(
        address user,
        address asset
    ) external view returns (uint256 seizedAmount, uint256 lastSeizedTime);

    /// @notice 获取用户所有清算抵押物记录
    /// @param user 用户地址
    /// @return assets 资产地址数组
    /// @return seizedAmounts 已扣押数量数组
    /// @return lastSeizedTimes 最后扣押时间数组
    function getUserAllLiquidationCollateralRecords(
        address user
    ) external view returns (
        address[] memory assets,
        uint256[] memory seizedAmounts,
        uint256[] memory lastSeizedTimes
    );

    /// @notice 清除用户清算抵押物记录
    /// @param user 用户地址
    /// @param asset 资产地址
    function clearLiquidationCollateralRecord(address user, address asset) external;

    /* ============ Batch Query Functions ============ */
    // TODO: 在View合约部署后取消注释
    // /// @notice 批量获取用户可清算抵押物数量
    // /// @param users 用户地址数组
    // /// @param assets 资产地址数组
    // /// @return seizableAmounts 可清算数量数组
    // function batchGetSeizableAmounts(
    //     address[] calldata users,
    //     address[] calldata assets
    // ) external view returns (uint256[] memory seizableAmounts);

    /// @notice 批量计算抵押物价值
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    /// @return values 价值数组
    function batchCalculateCollateralValues(
        address[] calldata assets,
        uint256[] calldata amounts
    ) external view returns (uint256[] memory values);

    // TODO: 在View合约部署后取消注释
    // /// @notice 批量获取用户总抵押物价值
    // /// @param users 用户地址数组
    // /// @return totalValues 总价值数组
    // function batchGetUserTotalCollateralValues(
    //     address[] calldata users
    // ) external view returns (uint256[] memory totalValues);

    // 注意：优化功能已移至 ILiquidationCalculator 接口
    // Note: Optimization functions have been moved to ILiquidationCalculator interface

    /* ============ Preview Functions ============ */
    // TODO: 在View合约部署后取消注释
    // /// @notice 预览清算抵押物状态
    // /// @param user 用户地址
    // /// @param asset 资产地址
    // /// @param seizeAmount 扣押数量
    // /// @return newCollateralAmount 新的抵押物数量
    // /// @return newTotalValue 新的总价值
    // function previewLiquidationCollateralState(
    //     address user,
    //     address asset,
    //     uint256 seizeAmount
    // ) external view returns (uint256 newCollateralAmount, uint256 newTotalValue);

    /* ============ Admin Functions ============ */
    /// @notice 更新价格预言机地址
    /// @param newPriceOracle 新的价格预言机地址
    function updatePriceOracle(address newPriceOracle) external;

    /// @notice 更新结算币地址
    /// @param newSettlementToken 新的结算币地址
    function updateSettlementToken(address newSettlementToken) external;

    /// @notice 获取价格预言机地址
    /// @return priceOracle 价格预言机地址
    function getPriceOracle() external view returns (address priceOracle);

    /// @notice 获取结算币地址
    /// @return settlementToken 结算币地址
    function getSettlementToken() external view returns (address settlementToken);

    // ============ Dynamic Module Key Functions ============
    
    /// @notice 注册动态模块键
    /// @param name 模块名称（模块键由 RegistryDynamicModuleKey 内部生成）
    function registerDynamicModuleKey(string memory name) external;
    
    /// @notice 注销动态模块键
    /// @param moduleKey 模块键
    function unregisterDynamicModuleKey(bytes32 moduleKey) external;
    
    /// @notice 检查动态模块键是否已注册
    /// @param moduleKey 模块键
    /// @return isRegistered 是否已注册
    function isDynamicModuleKeyRegistered(bytes32 moduleKey) external view returns (bool isRegistered);
    
    /// @notice 获取动态模块键名称
    /// @param moduleKey 模块键
    /// @return name 模块名称
    function getDynamicModuleKeyName(bytes32 moduleKey) external view returns (string memory name);
    
    /// @notice 获取所有动态模块键
    /// @return moduleKeys 模块键数组
    function getAllDynamicModuleKeys() external view returns (bytes32[] memory moduleKeys);
    
    /// @notice 获取所有模块键（包括静态和动态）
    /// @return allKeys 所有模块键数组
    function getAllModuleKeys() external view returns (bytes32[] memory allKeys);
    
    /// @notice 检查模块键是否为动态模块键
    /// @param moduleKey 模块键
    /// @return isDynamic 是否为动态模块键
    function isDynamicModuleKey(bytes32 moduleKey) external view returns (bool isDynamic);
    
    /// @notice 检查模块键是否有效（包括静态和动态）
    /// @param moduleKey 模块键
    /// @return isValid 是否为有效模块键
    function isValidModuleKey(bytes32 moduleKey) external view returns (bool isValid);
    
    /// @notice 根据名称获取模块键
    /// @param name 模块键名称
    /// @return moduleKey 对应的模块键
    function getModuleKeyByName(string calldata name) external view returns (bytes32 moduleKey);
    
    /// @notice 获取模块键总数（包括静态和动态）
    /// @return totalCount 模块键总数
    function getTotalModuleKeyCount() external view returns (uint256 totalCount);
    
    /// @notice 批量注册动态模块键
    /// @param names 模块键名称数组
    /// @return moduleKeys 生成的模块键数组
    function batchRegisterDynamicModuleKeys(string[] calldata names) external returns (bytes32[] memory moduleKeys);
    
    /// @notice 刷新动态模块键缓存
    /// @param moduleKeys 要刷新的模块键数组
    function refreshDynamicModuleKeyCache(bytes32[] calldata moduleKeys) external;
    
    /// @notice 清理过期的动态模块键缓存
    function clearExpiredDynamicModuleKeyCache() external;
} 