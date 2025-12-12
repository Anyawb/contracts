// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationTokenLibrary.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/LiquidationViewLibrary.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILiquidationGuaranteeManager } from "../../../interfaces/ILiquidationGuaranteeManager.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { Registry } from "../../../registry/Registry.sol";

/**
 * @title LiquidationGuaranteeManager
 * @dev 清算保证金管理器 - 负责清算保证金的存储、查询和管理
 * @dev Liquidation Guarantee Manager - Responsible for liquidation guarantee storage, query and management
 * @dev 从 LiquidationDebtManager 拆分出的清算保证金管理功能
 * @dev Liquidation guarantee management functions split from LiquidationDebtManager
 * @dev 提供清算保证金的增删改查功能
 * @dev Provides CRUD operations for liquidation guarantees
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
 * @dev Integrates with ActionKeys and ModuleKeys, provides standardized permission and module management
 * @dev 完全集成Registry系统进行模块管理
 * @dev Fully integrated with Registry system for module management
 */
contract LiquidationGuaranteeManager is 
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationGuaranteeManager
{
    using LiquidationValidationLibrary for *;
    using LiquidationTokenLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationViewLibrary for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using ModuleCache for ModuleCache.ModuleCacheStorage;
    using LiquidationBase for *;

    // ============ 自定义错误 ============
    /// @dev 保证金不足错误
    error LiquidationGuaranteeManager__InsufficientGuarantee();
    /// @dev 无效保证金数据错误
    error LiquidationGuaranteeManager__InvalidGuaranteeData();
    /// @dev Registry未初始化错误
    error LiquidationGuaranteeManager__RegistryNotInitialized();
    /// @dev 模块调用失败错误
    error LiquidationGuaranteeManager__ModuleCallFailed();
    /// @dev 升级未准备就绪错误
    error LiquidationGuaranteeManager__UpgradeNotReady();
    /// @dev 升级已安排错误
    error LiquidationGuaranteeManager__UpgradeAlreadyScheduled();
    /// @dev 无效模块地址错误
    error LiquidationGuaranteeManager__InvalidModuleAddress();
    /// @dev 模块未注册错误
    error LiquidationGuaranteeManager__ModuleNotRegistered();

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address public immutable registryAddr;

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
     * 用户保证金：user → asset → guaranteeAmount
     * User guarantees: user → asset → guaranteeAmount
     * @dev 记录每个用户每种资产的保证金
     * @dev Records guarantee for each user's each asset
     */
    mapping(address => mapping(address => uint256)) private _userGuarantees;

    /* ============ Events ============ */
    // Registry升级相关事件已在 IRegistryUpgradeEvents 接口中定义

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器，防止直接调用
    constructor(address initialRegistryAddr) {
        _disableInitializers();
        registryAddr = initialRegistryAddr;
    }

    /* ============ Initializer ============ */
    
    /**
     * 初始化函数 - 设置Registry地址和权限控制接口
     * Initialize function - Set Registry address and access control interface
     * @param initialAccessControl 权限控制接口地址 Access control interface address
     */
    function initialize(address initialAccessControl) external initializer {
        LiquidationValidationLibrary.validateAddress(initialAccessControl, "AccessControl");
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
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

    /// @dev Registry验证修饰符
    /// @dev Registry validation modifier
    modifier registryInitialized() {
        if (registryAddr == address(0)) revert LiquidationGuaranteeManager__RegistryNotInitialized();
        _;
    }

    // ============ Registry 模块获取函数 ============
    
    /// @notice 从Registry获取模块地址
    /// @param moduleKey 模块键值
    /// @return 模块地址
    function getModuleFromRegistry(bytes32 moduleKey) internal view returns (address) {
        return Registry(registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 检查模块是否在Registry中注册
    /// @param moduleKey 模块键值
    /// @return 是否已注册
    function isModuleRegistered(bytes32 moduleKey) internal view returns (bool) {
        return Registry(registryAddr).isModuleRegistered(moduleKey);
    }

    /// @notice 安全获取模块地址 - 带错误处理
    /// @param moduleKey 模块键值
    /// @return 模块地址
    function safeGetModule(bytes32 moduleKey) internal view returns (address) {
        if (registryAddr == address(0)) revert LiquidationGuaranteeManager__RegistryNotInitialized();
        
        try Registry(registryAddr).getModuleOrRevert(moduleKey) returns (address module) {
            return module;
        } catch {
            revert LiquidationGuaranteeManager__ModuleNotRegistered();
        }
    }

    /// @notice 安排模块升级
    /// @param moduleKey 模块键值
    /// @param newAddress 新模块地址
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        LiquidationValidationLibrary.validateAddress(newAddress, "NewModuleAddress");
        
        // 检查是否已有待升级
        (address pendingAddress, , bool hasPending) = Registry(registryAddr).getPendingUpgrade(moduleKey);
        if (hasPending) revert LiquidationGuaranteeManager__UpgradeAlreadyScheduled();
        
        // 验证当前待升级地址不为零地址（如果存在）
        if (hasPending && pendingAddress == address(0)) revert LiquidationGuaranteeManager__InvalidModuleAddress();
        
        Registry(registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        // 获取当前模块地址用于事件
        address currentAddress = Registry(registryAddr).getModule(moduleKey);
        (address pendingAddr, uint256 executeAfter, ) = Registry(registryAddr).getPendingUpgrade(moduleKey);
        
        // 验证新安排的升级地址与请求的地址一致
        if (pendingAddr != newAddress) revert LiquidationGuaranteeManager__InvalidModuleAddress();
        
        emit RegistryModuleUpgradeScheduled(moduleKey, currentAddress, pendingAddr, executeAfter);
    }

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        // 检查升级是否准备就绪
        (address pendingAddress, uint256 executeAfter, bool hasPending) = Registry(registryAddr).getPendingUpgrade(moduleKey);
        if (!hasPending) revert LiquidationGuaranteeManager__UpgradeNotReady();
        if (block.timestamp < executeAfter) revert LiquidationGuaranteeManager__UpgradeNotReady();
        
        // 验证待升级地址不为零地址
        if (pendingAddress == address(0)) revert LiquidationGuaranteeManager__InvalidModuleAddress();
        
        address oldAddress = Registry(registryAddr).getModule(moduleKey);
        Registry(registryAddr).executeModuleUpgrade(moduleKey);
        address newAddress = Registry(registryAddr).getModule(moduleKey);
        
        // 更新模块缓存
        ModuleCache.set(_moduleCache, moduleKey, newAddress, msg.sender);
        
        emit RegistryModuleUpgradeExecuted(moduleKey, oldAddress, newAddress);
        emit ModuleCacheUpdated(moduleKey, oldAddress, newAddress);
    }

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        address oldAddress = Registry(registryAddr).getModule(moduleKey);
        (address pendingAddress, , bool hasPending) = Registry(registryAddr).getPendingUpgrade(moduleKey);
        
        if (!hasPending) revert LiquidationGuaranteeManager__UpgradeNotReady();
        
        Registry(registryAddr).cancelModuleUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeCancelled(moduleKey, oldAddress, pendingAddress);
    }

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键值
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending) {
        return Registry(registryAddr).getPendingUpgrade(moduleKey);
    }

    /// @notice 检查升级是否准备就绪
    /// @param moduleKey 模块键值
    /// @return isReady 是否准备就绪
    function isUpgradeReady(bytes32 moduleKey) external view returns (bool isReady) {
        (address pendingAddress, uint256 executeAfter, bool hasPending) = Registry(registryAddr).getPendingUpgrade(moduleKey);
        // 验证待升级地址不为零地址，确保升级数据有效
        if (hasPending && pendingAddress == address(0)) {
            return false;
        }
        return hasPending && block.timestamp >= executeAfter;
    }

    /* ============ Core Guarantee Management Functions ============ */
    
    /// @notice 没收用户保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 没收数量
    function forfeitGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateLiquidationParameters(user, asset, amount, msg.sender);

        uint256 currentGuarantee = _userGuarantees[user][asset];
        if (currentGuarantee < amount) revert LiquidationGuaranteeManager__InsufficientGuarantee();

        uint256 newGuarantee = currentGuarantee - amount;
        _userGuarantees[user][asset] = newGuarantee;

        // 使用 LiquidationTokenLibrary 进行安全转账
        LiquidationTokenLibrary.safeTransferERC20(asset, user, address(this), amount);

        // 使用 LiquidationEventLibrary 触发事件
        LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
            user,
            asset,
            currentGuarantee,
            newGuarantee,
            block.timestamp
        );
    }

    /// @notice 批量没收用户保证金
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @param amounts 没收数量数组
    function batchForfeitGuarantees(
        address[] calldata users,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        // 使用 LiquidationValidationLibrary 进行数组长度验证
        LiquidationValidationLibrary.validateArrayLength(users, assets);
        LiquidationValidationLibrary.validateArrayLength(users, amounts);
        LiquidationValidationLibrary.validateBatchSize(users.length, 100); // 最大批量大小100

        uint256 length = users.length;
        for (uint256 i = 0; i < length;) {
            address user = users[i];
            address asset = assets[i];
            uint256 amount = amounts[i];
            
            if (!LiquidationValidationLibrary.isZeroAddress(user) && 
                !LiquidationValidationLibrary.isZeroAddress(asset) && 
                !LiquidationValidationLibrary.isZeroAmount(amount)) {
                
                uint256 currentGuarantee = _userGuarantees[user][asset];
                if (currentGuarantee >= amount) {
                    uint256 newGuarantee = currentGuarantee - amount;
                    _userGuarantees[user][asset] = newGuarantee;

                    // 使用 LiquidationTokenLibrary 进行安全转账
                    LiquidationTokenLibrary.safeTransferERC20(asset, user, address(this), amount);

                    // 使用 LiquidationEventLibrary 触发事件
                    LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
                        user,
                        asset,
                        currentGuarantee,
                        newGuarantee,
                        block.timestamp
                    );
                }
            }
            unchecked { ++i; }
        }
    }

    /// @notice 更新用户保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 保证金数量
    function updateUserGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");

        uint256 oldAmount = _userGuarantees[user][asset];
        _userGuarantees[user][asset] = amount;

        // 使用 LiquidationEventLibrary 触发配置更新事件
        LiquidationEventLibrary.emitConfigurationUpdated(
            "userGuarantee",
            oldAmount,
            amount,
            msg.sender
        );
    }

    /* ============ Query Functions ============ */
    
    /// @notice 获取用户保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return guaranteeAmount 保证金数量
    function getUserGuarantee(
        address user,
        address asset
    ) external view override returns (uint256 guaranteeAmount) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");
        return _userGuarantees[user][asset];
    }

    /// @notice 获取用户所有保证金
    /// @param user 用户地址
    /// @return assets 资产地址数组
    /// @return amounts 保证金数量数组
    function getUserAllGuarantees(
        address user
    ) external view override returns (
        address[] memory assets,
        uint256[] memory amounts
    ) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        // 使用 Registry 获取借贷引擎地址
        address lendingEngine = safeGetModule(ModuleKeys.KEY_LE);
        if (lendingEngine != address(0)) {
            assets = ILendingEngineBasic(lendingEngine).getUserDebtAssets(user);
            uint256 length = assets.length;
            amounts = new uint256[](length);
            for (uint256 i = 0; i < length;) {
                address asset = assets[i];
                amounts[i] = _userGuarantees[user][asset];
                unchecked { ++i; }
            }
        }
    }

    /// @notice 预览没收保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 没收数量
    /// @return forfeitedAmount 实际没收数量
    function previewForfeitGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external view override returns (uint256 forfeitedAmount) {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");
        
        uint256 currentGuarantee = _userGuarantees[user][asset];
        return currentGuarantee < amount ? currentGuarantee : amount;
    }

    /// @notice 检查用户是否有保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return hasGuarantee 是否有保证金
    function hasUserGuarantee(
        address user,
        address asset
    ) external view override returns (bool hasGuarantee) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        LiquidationValidationLibrary.validateAddress(asset, "Asset");
        return _userGuarantees[user][asset] > 0;
    }

    /// @notice 获取用户保证金数量
    /// @param user 用户地址
    /// @return guaranteeCount 保证金数量
    function getUserGuaranteeCount(
        address user
    ) external view override returns (uint256 guaranteeCount) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        address lendingEngine = safeGetModule(ModuleKeys.KEY_LE);
        if (lendingEngine != address(0)) {
            address[] memory assets = ILendingEngineBasic(lendingEngine).getUserDebtAssets(user);
            uint256 length = assets.length;
            for (uint256 i = 0; i < length;) {
                if (_userGuarantees[user][assets[i]] > 0) {
                    guaranteeCount++;
                }
                unchecked { ++i; }
            }
        }
    }

    /* ============ Batch Query Functions ============ */
    
    /// @notice 批量获取用户保证金
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return amounts 保证金数量数组
    function batchGetUserGuarantees(
        address[] calldata users,
        address[] calldata assets
    ) external view override returns (uint256[] memory amounts) {
        // 使用 LiquidationValidationLibrary 进行数组长度验证
        LiquidationValidationLibrary.validateArrayLength(users, assets);

        uint256 length = users.length;
        amounts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            if (!LiquidationValidationLibrary.isZeroAddress(users[i]) && 
                !LiquidationValidationLibrary.isZeroAddress(assets[i])) {
                amounts[i] = _userGuarantees[users[i]][assets[i]];
            }
            unchecked { ++i; }
        }
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从Registry获取指定模块的地址
     * Get module address - Get address of specified module from Registry
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return 模块地址，如果未找到则返回零地址 Module address, returns zero address if not found
     * @dev 直接从 Registry 获取最新地址，不经过缓存
     * @dev Gets latest address directly from Registry, bypassing cache
     */
    function getModule(bytes32 moduleKey) public view override returns (address) {
        if (registryAddr == address(0)) return address(0);
        return Registry(registryAddr).getModule(moduleKey);
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

    /* ============ Getter Functions ============ */
    
    /// @notice 获取基础存储信息
    /// @return priceOracle 价格预言机地址
    /// @return settlementToken 结算币地址
    /// @return registry Registry地址
    /// @return acm 权限控制管理器地址
    function getBaseStorage() external view returns (address priceOracle, address settlementToken, address registry, address acm) {
        return (_baseStorage.priceOracleAddr, _baseStorage.settlementTokenAddr, registryAddr, address(this));
    }

    /// @notice 获取Registry地址 - 查询当前Registry地址
    /// @return registry Registry地址，用于模块地址管理 Registry address for module address management
    function getRegistry() external view returns (address registry) {
        return registryAddr;
    }

    /// @notice 获取清算奖励存储信息
    /// @return rewardRate 奖励比例
    /// @return penaltyRate 惩罚比例
    /// @return profitRate 收益比例
    function getRewardStorage() external view returns (uint256 rewardRate, uint256 penaltyRate, uint256 profitRate) {
        return (liquidationRewardStorage.liquidationRewardRate, liquidationRewardStorage.liquidationPenaltyRate, liquidationRewardStorage.liquidatorProfitRate);
    }

    /// @notice 获取模块缓存信息
    /// @param moduleKey 模块键
    /// @return moduleAddress 模块地址
    function getCachedModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return ModuleCache.get(_moduleCache, moduleKey, 1 days);
    }

    /// @notice 获取价格预言机地址
    /// @return priceOracle 价格预言机地址
    function getPriceOracle() external view returns (address priceOracle) {
        return _baseStorage.priceOracleAddr;
    }

    /// @notice 获取结算币地址
    /// @return settlementToken 结算币地址
    function getSettlementToken() external view returns (address settlementToken) {
        return _baseStorage.settlementTokenAddr;
    }

    /// @notice 获取权限控制管理器地址
    /// @return acm 权限控制管理器地址
    function getAccessControlManager() external view returns (address acm) {
        return address(this);
    }

    /// @notice 获取清算奖励率
    /// @return rewardRate 清算奖励率
    function getLiquidationRewardRate() external view returns (uint256 rewardRate) {
        return liquidationRewardStorage.liquidationRewardRate;
    }

    /// @notice 获取清算惩罚率
    /// @return penaltyRate 清算惩罚率
    function getLiquidationPenaltyRate() external view returns (uint256 penaltyRate) {
        return liquidationRewardStorage.liquidationPenaltyRate;
    }

    /// @notice 获取清算人收益率
    /// @return profitRate 清算人收益率
    function getLiquidatorProfitRate() external view returns (uint256 profitRate) {
        return liquidationRewardStorage.liquidatorProfitRate;
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