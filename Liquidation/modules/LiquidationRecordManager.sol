// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ILiquidationRecordManager } from "../../../interfaces/ILiquidationRecordManager.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { LiquidationAccessControl } from "../libraries/LiquidationAccessControl.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";

/**
 * @title LiquidationRecordManager
 * @notice 清算记录管理器 - 负责清算记录和事件管理
 * @dev Liquidation Record Manager - Responsible for liquidation record and event management
 * @dev 提供清算记录存储、事件发出、记录开关管理等功能
 * @dev Provides record storage, event emission, and record switch management
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
 * @dev Integrates with ActionKeys and ModuleKeys, provides standardized permission and module management
 * @dev 遵循存储结构统一规范，使用标准化的存储布局
 * @dev Follows storage structure unification guidelines, uses standardized storage layout
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 */
abstract contract LiquidationRecordManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationRecordManager
{
    using LiquidationValidationLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationEventLibrary for *;
    using LiquidationBase for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    /* ============ Constants ============ */
    /// @notice 缓存最大有效期（秒）
    /// @notice Maximum cache validity period (seconds)
    uint256 public constant CACHE_MAX_AGE = 1 days;

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address private _registryAddr;

    /// @notice 基础存储 - 所有模块共享
    /// @notice Base storage - Shared by all modules
    LiquidationBase.BaseStorage private _baseStorage;
    
    /// @notice 模块缓存 - 用于缓存模块地址
    /// @notice Module cache - For caching module addresses
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /// @notice 用户清算时间戳记录：user → liquidationTimestamps[]
    /// @notice User liquidation timestamp records: user → liquidationTimestamps[]
    mapping(address => uint256[]) private _userLiquidationTimestamps;
    
    /// @notice 清算记录开关标志
    /// @notice Liquidation record switch flag
    bool public recordEnabled = true;

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器，防止直接调用
    /// @dev Disable initializer for implementation contract to prevent direct calls
    constructor() {
        _disableInitializers();
    }

    /* ============ Initializer ============ */
    
    /**
     * 初始化函数 - 设置Registry地址和权限控制接口
     * Initialize function - Set Registry address and access control interface
     * @param initialRegistryAddr Registry合约地址 Registry contract address
     * @param initialAccessControl 权限控制接口地址 Access control interface address
     */
    function initialize(address initialRegistryAddr, address initialAccessControl) external initializer {
        LiquidationValidationLibrary.validateAddress(initialRegistryAddr, "Registry");
        LiquidationValidationLibrary.validateAddress(initialAccessControl, "AccessControl");
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(_baseStorage.accessControl, initialAccessControl, initialAccessControl);
        
        // 初始化模块缓存
        ModuleCache.initialize(_moduleCache, false, address(this));
    }

    /* ============ Modifiers ============ */
    
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    // ============ Registry 模块获取函数 ============
    
    /// @notice 从Registry获取模块地址
    /// @param moduleKey 模块键值
    /// @return 模块地址
    function getModuleFromRegistry(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 检查模块是否在Registry中注册
    /// @param moduleKey 模块键值
    /// @return 是否已注册
    function isModuleRegistered(bytes32 moduleKey) internal view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /* ============ Record Management Functions ============ */
    
    /**
     * @notice 记录清算操作 - 记录用户的清算操作
     * @notice Record liquidation operation - Record user's liquidation operation
     * @param user 用户地址 User address
     * @dev 只有在记录功能启用时才记录
     * @dev Only records when record function is enabled
     * @dev 使用内部函数更新清算记录
     * @dev Uses internal function to update liquidation record
     */
    function recordLiquidation(address user) external override whenNotPaused nonReentrant {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        if (recordEnabled) {
            _userLiquidationTimestamps[user].push(block.timestamp);
        }
    }

    /**
     * @notice 发出清算事件 - 发出完整的清算事件
     * @notice Emit liquidation events - Emit complete liquidation events
     * @param user 用户地址 User address
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param result 清算结果 Liquidation result
     * @param liquidator 清算人地址 Liquidator address
     * @dev 验证所有输入参数的有效性
     * @dev Validates all input parameters
     * @dev 发出清算执行事件和残值分配事件
     * @dev Emits liquidation executed event and residual allocation event
     */
    function emitLiquidationEvents(
        address user,
        address collateralAsset,
        address debtAsset,
        LiquidationTypes.LiquidationResult calldata result,
        address liquidator
    ) external override whenNotPaused {
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(collateralAsset, "CollateralAsset");
        LiquidationValidationLibrary.validateAddress(debtAsset, "DebtAsset");
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");
        
        // 发出清算执行事件
        emit LiquidationTypes.LiquidationExecuted(
            liquidator,
            user,
            collateralAsset,
            debtAsset,
            result.seizedCollateral,
            result.reducedDebt,
            result.residualValue,
            block.timestamp
        );
        
        // 如果有残值，发出残值分配事件
        if (result.residualValue > 0) {
            emit LiquidationTypes.ResidualAllocated(
                user,
                result.allocation.totalResidual,
                result.allocation.platformRevenue,
                result.allocation.riskReserve,
                result.allocation.lenderCompensation,
                result.allocation.liquidatorReward,
                block.timestamp
            );
        }
    }

    /* ============ Query Functions ============ */
    
    /**
     * @notice 获取用户清算次数 - 获取指定用户的清算次数
     * @notice Get user liquidation count - Get liquidation count for specified user
     * @param user 用户地址 User address
     * @return count 清算次数 Liquidation count
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getUserLiquidationCount(address user) external view override returns (uint256 count) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        return _userLiquidationTimestamps[user].length;
    }

    /**
     * @notice 获取用户清算时间戳 - 获取指定用户的所有清算时间戳
     * @notice Get user liquidation timestamps - Get all liquidation timestamps for specified user
     * @param user 用户地址 User address
     * @return timestamps 时间戳数组 Timestamp array
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getUserLiquidationTimestamps(address user) external view override returns (uint256[] memory timestamps) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        return _userLiquidationTimestamps[user];
    }

    /**
     * @notice 获取用户指定索引的清算时间戳 - 获取指定用户指定索引的清算时间戳
     * @notice Get user liquidation timestamp at index - Get liquidation timestamp at specified index for specified user
     * @param user 用户地址 User address
     * @param index 索引 Index
     * @return timestamp 时间戳 Timestamp
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     * @dev 如果索引超出范围，返回0
     * @dev Returns 0 if index is out of range
     */
    function getUserLiquidationTimestampAtIndex(address user, uint256 index) external view override returns (uint256 timestamp) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        uint256[] storage timestamps = _userLiquidationTimestamps[user];
        if (index >= timestamps.length) return 0;
        return timestamps[index];
    }

    /**
     * @notice 检查记录功能是否启用 - 检查清算记录功能是否启用
     * @notice Check if record function is enabled - Check if liquidation record function is enabled
     * @return enabled 是否启用 Whether enabled
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function isRecordEnabled() external view override returns (bool) {
        return recordEnabled;
    }

    /* ============ Admin Functions ============ */
    
    /**
     * @notice 更新清算记录开关 - 启用或禁用清算记录功能
     * @notice Update liquidation record switch - Enable or disable liquidation record function
     * @param newEnabled 新的开关状态 New switch state
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 触发清算记录开关更新事件
     * @dev Emits liquidation record switch updated event
     */
    function updateLiquidationRecordEnabled(bool newEnabled) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        bool oldEnabled = recordEnabled;
        recordEnabled = newEnabled;
        
        // 触发清算记录开关更新事件
        emit LiquidationTypes.LiquidationRecordEnabledUpdated(oldEnabled, newEnabled, block.timestamp);
    }

    /**
     * @notice 清除用户清算记录 - 清除指定用户的所有清算记录
     * @notice Clear user liquidation records - Clear all liquidation records for specified user
     * @param user 用户地址 User address
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 触发清算记录清除事件
     * @dev Emits liquidation record cleared event
     */
    function clearUserLiquidationRecords(address user) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        delete _userLiquidationTimestamps[user];
    }

    /**
     * @notice 清除所有清算记录 - 清除所有用户的清算记录
     * @notice Clear all liquidation records - Clear liquidation records for all users
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 注意：实际生产环境应谨慎实现
     * @dev Note: Should be implemented carefully in production environment
     * @dev 触发所有清算记录清除事件
     * @dev Emits all liquidation records cleared event
     */
    function clearAllLiquidationRecords() external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 注意：实际生产环境应谨慎实现
        // Note: Should be implemented carefully in production environment
        recordEnabled = false;
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * @notice 获取模块地址 - 从缓存中获取指定模块的地址
     * @notice Get module address - Get address of specified module from cache
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return moduleAddress 模块地址，如果缓存失效则返回零地址 Module address, returns zero address if cache expired
     * @dev 优先从缓存获取以提高性能，缓存失效时从 VaultStorage 获取最新地址
     * @dev Prioritizes cache for performance, falls back to VaultStorage for latest address when cache expires
     */
    function getModule(bytes32 moduleKey) public view override returns (address) {
        return ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
    }

    /**
     * @notice 更新模块 - 更新指定模块的缓存地址
     * @notice Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     */
    function updateModule(bytes32 key, address addr) external whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /**
     * @notice 批量更新模块 - 一次性更新多个模块
     * @notice Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.batchSet(_moduleCache, keys, addresses, msg.sender);
    }

    /**
     * @notice 移除模块 - 从缓存中移除指定模块
     * @notice Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     */
    function removeModule(bytes32 key) external whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /* ============ Emergency Functions ============ */
    
    /**
     * @notice 紧急暂停 - 紧急情况下暂停所有操作
     * @notice Emergency pause - Pause all operations in emergency situations
     * @dev 只有具有清算权限的角色才能调用此函数
     * @dev Only roles with liquidation permission can call this function
     */
    function emergencyPause() external whenNotPaused onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        _pause();
    }

    /**
     * @notice 紧急恢复 - 紧急情况下恢复所有操作
     * @notice Emergency unpause - Resume all operations in emergency situations
     * @dev 只有具有清算权限的角色才能调用此函数
     * @dev Only roles with liquidation permission can call this function
     */
    function emergencyUnpause() external whenPaused onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        _unpause();
    }

    /* ============ Getter Functions ============ */
    
    /**
     * @notice 获取基础存储信息 - 查询合约的基础配置信息
     * @notice Get base storage - Query contract's basic configuration information
     * @return priceOracle 价格预言机地址，用于获取资产价格 Price oracle address for asset pricing
     * @return settlementToken 结算币地址，用于债务结算的币种 Settlement token address for debt settlement
     * @return vaultStorage Vault存储地址，用于模块地址管理 Vault storage address for module address management
     * @return acm 权限控制管理器地址，用于权限验证 Access control manager address for permission validation
     * @dev 这是一个只读查询函数，返回合约的核心配置信息
     * @dev This is a read-only query function that returns contract's core configuration information
     */
    function getBaseStorage() external view returns (address priceOracle, address settlementToken, address vaultStorage, address acm) {
        return ( _baseStorage.priceOracleAddr, _baseStorage.settlementTokenAddr, _baseStorage.vaultStorageAddr, address(this));
    }

    /**
     * @notice 获取模块缓存信息 - 从缓存中获取指定模块的地址
     * @notice Get cached module - Get address of specified module from cache
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return moduleAddress 模块地址，如果缓存失效则返回零地址 Module address, returns zero address if cache expired
     * @dev 这是一个只读查询函数，优先从缓存获取以提高性能
     * @dev This is a read-only query function that prioritizes cache for performance
     * @dev 使用最大缓存有效期进行查询，确保缓存数据的时效性
     * @dev Uses maximum cache age for query to ensure cache data timeliness
     */
    function getCachedModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
    }

    /**
     * @notice 获取价格预言机地址 - 查询当前价格预言机地址
     * @notice Get price oracle - Query current price oracle address
     * @return priceOracle 价格预言机地址，用于获取资产价格 Price oracle address for asset pricing
     * @dev 这是一个只读查询函数，返回价格预言机地址
     * @dev This is a read-only query function that returns price oracle address
     */
    function getPriceOracle() external view returns (address priceOracle) {
        return _baseStorage.priceOracleAddr;
    }

    /**
     * @notice 获取结算币地址 - 查询当前结算币地址
     * @notice Get settlement token - Query current settlement token address
     * @return settlementToken 结算币地址，用于债务结算的币种 Settlement token address for debt settlement
     * @dev 这是一个只读查询函数，返回结算币地址
     * @dev This is a read-only query function that returns settlement token address
     */
    function getSettlementToken() external view returns (address settlementToken) {
        return _baseStorage.settlementTokenAddr;
    }

    /**
     * @notice 获取Vault存储地址 - 查询当前Vault存储地址
     * @notice Get vault storage - Query current vault storage address
     * @return vaultStorage Vault存储地址，用于模块地址管理 Vault storage address for module address management
     * @dev 这是一个只读查询函数，返回Vault存储地址
     * @dev This is a read-only query function that returns vault storage address
     */
    function getVaultStorage() external view returns (address vaultStorage) {
        return _baseStorage.vaultStorageAddr;
    }

    /**
     * @notice 获取权限控制管理器地址 - 查询当前权限控制管理器地址
     * @notice Get access control manager - Query current access control manager address
     * @return acm 权限控制管理器地址，用于权限验证 Access control manager address for permission validation
     * @dev 这是一个只读查询函数，返回权限控制管理器地址
     * @dev This is a read-only query function that returns access control manager address
     */
    function getAccessControlManager() external view returns (address acm) {
        return address(this);
    }

    /* ============ UUPS Upgradeable ============ */
    
    /**
     * @notice 授权升级函数 - 验证升级权限并检查新实现合约地址
     * @notice Authorize upgrade - Validate upgrade permission and check new implementation address
     * @param newImplementation 新实现合约地址，用于升级当前合约 New implementation contract address for upgrading current contract
     * @dev 只有具有升级模块权限的角色才能调用此函数
     * @dev Only roles with module upgrade permission can call this function
     * @dev 验证新实现合约地址的有效性，确保升级安全性
     * @dev Validates new implementation contract address to ensure upgrade security
     * @dev 这是 UUPS 升级模式的核心安全机制
     * @dev This is the core security mechanism for UUPS upgrade pattern
     */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        // 验证新实现合约地址的有效性
        // Validate new implementation contract address
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }
} 