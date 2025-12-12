// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";

/// @dev 本地最小接口：仅用于健康检查，避免接口不匹配导致的编译错误
interface IPriceOracleHealth {
    function checkPriceOracleHealth(address asset) external view returns (bool isHealthy, string memory details);
}

/// @title ValuationOracleView
/// @notice 价格预言机视图模块 - 专门提供价格预言机相关的查询功能
/// @dev 提供价格查询、健康检查、预言机状态等功能的统一接口
/// @dev 已迁移到Registry系统，使用标准化的模块管理方式
/// @dev 增强权限隔离：细粒度权限控制、数据访问审计
/// @custom:security-contact security@example.com
contract ValuationOracleView is Initializable, UUPSUpgradeable {
    
    /// @notice Registry 合约地址
    address private _registryAddr;
    
    /// @notice 价格数据访问审计事件
    event PriceDataAccess(
        address indexed caller,
        address indexed asset,
        string operation,
        uint256 timestamp
    );
    
    /// @notice 预言机健康检查事件
    event OracleHealthCheck(
        address indexed asset,
        bool isHealthy,
        string details,
        uint256 timestamp
    );
    
    /// @notice 批量价格查询事件
    event BatchPriceQuery(
        address indexed caller,
        uint256 assetCount,
        uint256 timestamp
    );
    
    /// @notice Registry 有效性验证修饰符
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 权限验证逻辑改由 ViewAccessLib 统一提供
    /// @notice 价格数据查看权限修饰符
    modifier onlyPriceViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        _;
    }

    /// @notice 初始化 ValuationOracleView 模块
    /// @param initialRegistryAddr Registry合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /* ============ 价格查询功能 ============ */

    /// @notice 获取单个资产价格
    /// @param asset 资产地址
    /// @return price 价格
    /// @return timestamp 时间戳
    function getAssetPrice(address asset) external onlyValidRegistry onlyPriceViewer 
        returns (uint256 price, uint256 timestamp) {
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        (price, timestamp, ) = IPriceOracle(priceOracle).getPrice(asset);
        
        emit PriceDataAccess(msg.sender, asset, "getAssetPrice", block.timestamp);
    }

    /// @notice 批量获取资产价格
    /// @param assets 资产地址数组
    /// @return prices 价格数组
    /// @return timestamps 时间戳数组
    function getAssetPrices(address[] calldata assets) external onlyValidRegistry onlyPriceViewer 
        returns (uint256[] memory prices, uint256[] memory timestamps) {
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        (prices, timestamps, ) = IPriceOracle(priceOracle).getPrices(assets);
        
        emit BatchPriceQuery(msg.sender, assets.length, block.timestamp);
    }

    /// @notice 检查价格是否有效
    /// @param asset 资产地址
    /// @return isValid 价格是否有效
    function isPriceValid(address asset) external onlyValidRegistry onlyPriceViewer 
        returns (bool isValid) {
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        isValid = IPriceOracle(priceOracle).isPriceValid(asset);
        
        emit PriceDataAccess(msg.sender, asset, "isPriceValid", block.timestamp);
    }

    /* ============ 预言机状态查询 ============ */

    /// @notice 获取资产的预言机地址
    /// @param asset 资产地址
    /// @return oracle 预言机地址
    // NOTE: 旧接口 getAssetOracle 移除

    /// @notice 检查价格预言机健康状态
    /// @param asset 资产地址
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function checkPriceOracleHealth(address asset) external onlyValidRegistry onlyPriceViewer 
        returns (bool isHealthy, string memory details) {
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        (isHealthy, details) = IPriceOracleHealth(priceOracle).checkPriceOracleHealth(asset);
        
        emit OracleHealthCheck(asset, isHealthy, details, block.timestamp);
    }

    /// @notice 获取默认预言机地址
    /// @return 默认预言机地址
    // NOTE: 旧接口 getDefaultOracle 移除

    /// @notice 获取结算币地址
    /// @return 结算币地址
    // NOTE: 旧接口 getSettlementToken 移除

    /* ============ 批量健康检查 ============ */

    /// @notice 批量检查价格预言机健康状态
    /// @param assets 资产地址数组
    /// @return healthStatuses 健康状态数组
    /// @return details 详细信息数组
    function batchCheckPriceOracleHealth(
        address[] calldata assets
    ) external onlyValidRegistry onlyPriceViewer returns (
        bool[] memory healthStatuses,
        string[] memory details
    ) {
        require(assets.length > 0, "ValuationOracleView: empty assets array");
        require(assets.length <= ViewConstants.MAX_BATCH_SIZE, "ValuationOracleView: batch too large");
        
        uint256 length = assets.length;
        healthStatuses = new bool[](length);
        details = new string[](length);
        
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        for (uint256 i = 0; i < length; ++i) {
            (bool isHealthy, string memory detail) = 
                IPriceOracleHealth(priceOracle).checkPriceOracleHealth(assets[i]);
            
            healthStatuses[i] = isHealthy;
            details[i] = detail;
        }
        
        emit BatchPriceQuery(msg.sender, assets.length, block.timestamp);
    }

    /* ============ 管理功能 ============ */

    /// @notice 获取Registry地址（仅管理员）
    /// @return Registry地址
    function getRegistry() external view onlyValidRegistry returns (address) {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        return _registryAddr;
    }

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        // 发出Registry地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }

    /// @notice 获取当前合约版本信息
    /// @return version 版本号
    /// @return implementation 当前实现地址
    function getVersionInfo() external view onlyValidRegistry returns (uint256 version, address implementation) {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        // 这里可以返回合约版本信息，暂时返回默认值
        version = 1;
        implementation = address(this);
    }

    /// @notice 检查升级权限
    /// @param user 用户地址
    /// @return hasUpgradePermission 是否有升级权限
    function hasUpgradePermission(address user) external view onlyValidRegistry returns (bool) {
        // 通过Registry系统检查用户是否有升级权限
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, user);
    }

    /* ============ Registry升级管理 ============ */

    /// @notice 安排模块升级
    /// @param targetModuleKey 目标模块键
    /// @param newModuleAddress 新模块地址
    /// @dev 需要升级权限
    function scheduleModuleUpgrade(bytes32 targetModuleKey, address newModuleAddress) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).scheduleModuleUpgrade(targetModuleKey, newModuleAddress);
    }

    /// @notice 执行模块升级
    /// @param targetModuleKey 目标模块键
    /// @dev 需要升级权限
    function executeModuleUpgrade(bytes32 targetModuleKey) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).executeModuleUpgrade(targetModuleKey);
    }

    /// @notice 取消模块升级
    /// @param targetModuleKey 目标模块键
    /// @dev 需要升级权限
    function cancelModuleUpgrade(bytes32 targetModuleKey) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).cancelModuleUpgrade(targetModuleKey);
    }

    /// @notice 获取待升级信息
    /// @param targetModuleKey 目标模块键
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 targetModuleKey) external view onlyValidRegistry returns (
        address newAddress, 
        uint256 executeAfter, 
        bool hasPending
    ) {
        return Registry(_registryAddr).getPendingUpgrade(targetModuleKey);
    }

    /// @notice 检查升级是否准备就绪
    /// @param targetModuleKey 目标模块键
    /// @return 是否准备就绪
    function isUpgradeReady(bytes32 targetModuleKey) external view onlyValidRegistry returns (bool) {
        return Registry(_registryAddr).isUpgradeReady(targetModuleKey);
    }

    /// @notice 获取模块的升级历史数量
    /// @param targetModuleKey 目标模块键
    /// @return 升级历史数量
    function getUpgradeHistoryCount(bytes32 targetModuleKey) external view onlyValidRegistry returns (uint256) {
        return Registry(_registryAddr).getUpgradeHistoryCount(targetModuleKey);
    }

    /// @notice 获取模块的升级历史记录
    /// @param targetModuleKey 目标模块键
    /// @param historyIndex 历史记录索引
    /// @return oldAddress 旧地址
    /// @return newAddress 新地址
    /// @return timestamp 时间戳
    /// @return executor 执行者
    function getUpgradeHistory(bytes32 targetModuleKey, uint256 historyIndex) external view onlyValidRegistry returns (
        address oldAddress,
        address newAddress,
        uint256 timestamp,
        address executor
    ) {
        return Registry(_registryAddr).getUpgradeHistory(targetModuleKey, historyIndex);
    }

    /* ============ UUPS Upgradeable ============ */
    /// @notice 升级授权函数
    /// @dev 只有具有升级权限的用户可以升级
    function _authorizeUpgrade(address newImplementation) internal view override {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        // 验证新实现地址不为零
        if (newImplementation == address(0)) revert ZeroAddress();
    }
}
