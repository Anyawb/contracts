// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/LiquidationViewLibrary.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILiquidationDebtRecordManager } from "../../../interfaces/ILiquidationDebtRecordManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";

/**
 * @title LiquidationDebtRecordManager
 * @dev 清算债务记录管理器 - 负责清算债务记录的存储、查询和管理
 * @dev Liquidation Debt Record Manager - Responsible for liquidation debt record storage, query and management
 * @dev 从 LiquidationDebtManager 拆分出的清算债务记录管理功能
 * @dev Liquidation debt record management functions split from LiquidationDebtManager
 * @dev 提供清算债务记录的增删改查功能
 * @dev Provides CRUD operations for liquidation debt records
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
 * @dev Integrates with ActionKeys and ModuleKeys, provides standardized permission and module management
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 */
contract LiquidationDebtRecordManager is 
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationDebtRecordManager,
    IRegistryUpgradeEvents
{
    using LiquidationValidationLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationViewLibrary for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using ModuleCache for ModuleCache.ModuleCacheStorage;
    using LiquidationBase for *;

    // ============ 自定义错误 ============
    /// @dev 记录不存在错误
    error RecordNotFound();
    /// @dev 记录已存在错误
    error RecordAlreadyExists();
    /// @dev 无效记录数据错误
    error InvalidRecordData();

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address private _registryAddr;

    /**
     * 基础存储 - 包含权限控制和缓存管理
     * Base storage - Contains access control and cache management
     */
    LiquidationBase.BaseStorage private _baseStorage;

    /**
     * 权限控制存储 - 使用 LiquidationAccessControl 库
     * Access control storage - Using LiquidationAccessControl library
     */
    LiquidationAccessControl.Storage internal accessControlStorage;

    /**
     * 模块缓存 - 用于缓存模块地址
     * Module cache - Used to cache module addresses
     */
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /**
     * 清算积分存储 - 包含清算积分相关配置
     * Liquidation reward storage - Contains liquidation reward configuration
     */
    LiquidationBase.LiquidationRewardStorage internal liquidationRewardStorage;

    /**
     * 用户清算债务记录：user → asset → (reducedAmount, lastReducedTime)
     * User liquidation debt records: user → asset → (reducedAmount, lastReducedTime)
     * @dev 记录每个用户每种资产的清算历史
     * @dev Records liquidation history for each user's each asset
     */
    mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) private _userLiquidationDebtRecords;

    /**
     * 用户清算债务总记录：user → totalReducedAmount
     * User total liquidation debt records: user → totalReducedAmount
     * @dev 记录每个用户的总清算债务数量
     * @dev Records total liquidation debt amount for each user
     */
    mapping(address => uint256) private _userTotalLiquidationDebtAmount;

    /* ============ Constructor ============ */
    
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

    // ============ 修饰符 ============
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

    /// @notice 安排模块升级
    /// @param moduleKey 模块键值
    /// @param newAddress 新模块地址
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        // 获取当前模块地址用于事件
        address currentAddress = Registry(_registryAddr).getModule(moduleKey);
        (address pendingAddress, uint256 executeAfter, ) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeScheduled(moduleKey, currentAddress, pendingAddress, executeAfter);
    }

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        address oldAddress = Registry(_registryAddr).getModule(moduleKey);
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
        address newAddress = Registry(_registryAddr).getModule(moduleKey);
        
        emit RegistryModuleUpgradeExecuted(moduleKey, oldAddress, newAddress);
    }

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        address oldAddress = Registry(_registryAddr).getModule(moduleKey);
        (address pendingAddress, , ) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeCancelled(moduleKey, oldAddress, pendingAddress);
    }

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键值
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending) {
        return Registry(_registryAddr).getPendingUpgrade(moduleKey);
    }

    /* ============ Core Record Management Functions ============ */
    
    /// @notice 更新清算债务记录
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 清算数量
    /// @param liquidator 清算人地址
    function updateLiquidationDebtRecord(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateLiquidationParameters(user, asset, amount, liquidator);

        // 使用 LiquidationCoreOperations 进行记录更新
        LiquidationCoreOperations.updateLiquidationRecord(
            user,
            asset,
            amount,
            liquidator,
            _userLiquidationDebtRecords,
            _userTotalLiquidationDebtAmount
        );
    }

    /// @notice 清除用户清算债务记录
    /// @param user 用户地址
    /// @param asset 资产地址
    function clearLiquidationDebtRecord(
        address user,
        address asset
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");

        // 使用 LiquidationCoreOperations 进行记录清除
        LiquidationCoreOperations.clearLiquidationRecord(
            user,
            asset,
            _userLiquidationDebtRecords,
            _userTotalLiquidationDebtAmount
        );
    }

    /// @notice 批量清除用户清算债务记录
    /// @param user 用户地址
    /// @param assets 资产地址数组
    function batchClearLiquidationDebtRecords(
        address user,
        address[] calldata assets
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateBatchSize(assets.length, 100); // 最大批量大小100

        uint256 totalCleared = 0;
        uint256 length = assets.length;
        
        for (uint256 i = 0; i < length;) {
            address asset = assets[i];
            if (!LiquidationValidationLibrary.isZeroAddress(asset)) {
                uint256 oldAmount = _userLiquidationDebtRecords[user][asset].amount;
                if (oldAmount > 0) {
                    delete _userLiquidationDebtRecords[user][asset];
                    totalCleared += oldAmount;
                    
                    // 使用 LiquidationEventLibrary 触发事件
                    LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
                        user,
                        asset,
                        oldAmount,
                        0,
                        block.timestamp
                    );
                }
            }
            unchecked { ++i; }
        }
        
        if (totalCleared > 0) {
            _userTotalLiquidationDebtAmount[user] -= totalCleared;
        }
    }

    /* ============ Query Functions ============ */
    
    /// @notice 获取用户清算债务记录
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return reducedAmount 已清算债务数量
    /// @return lastReducedTime 最后清算时间
    function getLiquidationDebtRecord(
        address user,
        address asset
    ) external view override returns (uint256 reducedAmount, uint256 lastReducedTime) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");

        // 使用 LiquidationCoreOperations 获取记录
        (reducedAmount, lastReducedTime) = LiquidationCoreOperations.getLiquidationRecord(
            user,
            asset,
            _userLiquidationDebtRecords
        );
    }

    /// @notice 获取用户所有清算债务记录
    /// @param user 用户地址
    /// @return assets 资产地址数组
    /// @return reducedAmounts 已清算债务数量数组
    /// @return lastReducedTimes 最后清算时间数组
    function getUserAllLiquidationDebtRecords(
        address user
    ) external view override returns (
        address[] memory assets,
        uint256[] memory reducedAmounts,
        uint256[] memory lastReducedTimes
    ) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        // 使用 ModuleCache 获取借贷引擎地址
        address lendingEngine = ModuleCache.get(_moduleCache, ModuleKeys.KEY_LE, 1 days);
        if (lendingEngine != address(0)) {
            assets = ILendingEngineBasic(lendingEngine).getUserDebtAssets(user);
            uint256 length = assets.length;
            reducedAmounts = new uint256[](length);
            lastReducedTimes = new uint256[](length);
            
            for (uint256 i = 0; i < length;) {
                address asset = assets[i];
                LiquidationTypes.LiquidationRecord memory record = _userLiquidationDebtRecords[user][asset];
                reducedAmounts[i] = record.amount;
                lastReducedTimes[i] = record.timestamp;
                unchecked { ++i; }
            }
        }
    }

    /// @notice 获取用户总清算债务数量
    /// @param user 用户地址
    /// @return totalAmount 总清算债务数量
    function getUserTotalLiquidationDebtAmount(
        address user
    ) external view override returns (uint256 totalAmount) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        return _userTotalLiquidationDebtAmount[user];
    }

    /// @notice 检查用户是否有清算债务记录
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return hasRecord 是否有记录
    function hasLiquidationDebtRecord(
        address user,
        address asset
    ) external view override returns (bool hasRecord) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");
        return _userLiquidationDebtRecords[user][asset].amount > 0;
    }

    /// @notice 获取用户清算债务记录数量
    /// @param user 用户地址
    /// @return recordCount 记录数量
    function getUserLiquidationDebtRecordCount(
        address user
    ) external view override returns (uint256 recordCount) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        address lendingEngine = ModuleCache.get(_moduleCache, ModuleKeys.KEY_LE, 1 days);
        if (lendingEngine != address(0)) {
            address[] memory assets = ILendingEngineBasic(lendingEngine).getUserDebtAssets(user);
            uint256 length = assets.length;
            for (uint256 i = 0; i < length;) {
                if (_userLiquidationDebtRecords[user][assets[i]].amount > 0) {
                    recordCount++;
                }
                unchecked { ++i; }
            }
        }
    }

    /* ============ Batch Query Functions ============ */
    
    /// @notice 批量获取用户清算债务记录
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return reducedAmounts 已清算债务数量数组
    /// @return lastReducedTimes 最后清算时间数组
    function batchGetLiquidationDebtRecords(
        address[] calldata users,
        address[] calldata assets
    ) external view override returns (
        uint256[] memory reducedAmounts,
        uint256[] memory lastReducedTimes
    ) {
        // 使用 LiquidationViewLibrary 进行批量查询
        return LiquidationViewLibrary.batchGetLiquidationDebtRecords(users, assets, _moduleCache);
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从缓存中获取模块地址
     * Get module address - Get module address from cache
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) public view override returns (address) {
        return ModuleCache.get(_moduleCache, moduleKey, 1 days);
    }

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external override {
        // 使用 LiquidationAccessControl 进行权限检查
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 使用 ModuleCache 进行模块更新
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external override {
        // 使用 LiquidationAccessControl 进行权限检查
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 使用 ModuleCache 进行批量更新
        ModuleCache.batchSet(_moduleCache, keys, addresses, msg.sender);
    }

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external override {
        // 使用 LiquidationAccessControl 进行权限检查
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 使用 ModuleCache 进行模块移除
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /* ============ UUPS Upgradeable ============ */
    /// @notice 授权升级函数
    /// @param newImplementation 新实现合约地址
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationValidationLibrary.validateAddress(newImplementation, "Implementation");
    }
} 