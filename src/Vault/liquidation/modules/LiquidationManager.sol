// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationInterfaceLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILiquidationManager } from "../../../interfaces/ILiquidationManager.sol";
import { LiquidationAccessControl } from "../libraries/LiquidationAccessControl.sol";
import { ILiquidationEventsView } from "../../../interfaces/ILiquidationEventsView.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";

/**
 * @title LiquidationManager
 * @dev 清算管理合约 - 专注于清算协调功能
 * @dev Liquidation management contract - Focused on liquidation coordination
 * @dev 提供清算操作的统一入口，协调各个清算子模块
 * @dev Provides unified entry point for liquidation operations, coordinates various liquidation sub-modules
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 */
abstract contract LiquidationManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationManager
{
    using LiquidationValidationLibrary for *;
    using LiquidationInterfaceLibrary for *;
    using LiquidationCoreOperations for *;
    using ModuleCache for *;
    using LiquidationBase for *;

    // ============ 自定义错误 ============
    /// @dev 清算权限不足错误
    error LiquidationManager__InsufficientLiquidationPermission();
    
    /// @dev Registry地址无效错误
    error LiquidationManager__InvalidRegistryAddress();

    /* ============ Constants ============ */
    
    /**
     * 默认清算奖励比例 - 使用LiquidationTypes中的常量
     * Default liquidation bonus rate - Use constants from LiquidationTypes
     */
    uint256 private constant DEFAULT_LIQUIDATION_BONUS_RATE = LiquidationTypes.MIN_LIQUIDATION_BONUS;

    /**
     * 默认清算阈值 - 使用LiquidationTypes中的常量
     * Default liquidation threshold - Use constants from LiquidationTypes
     */
    uint256 private constant DEFAULT_LIQUIDATION_THRESHOLD = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;

    /* ============ Storage ============ */
    
    /**
     * Registry地址 - 用于模块管理
     * Registry address - For module management
     */
    address private _registryAddr;

    /**
     * 基础存储 - 包含权限控制和缓存管理
     * Base storage - Contains access control and cache management
     */
    LiquidationBase.BaseStorage private _baseStorage;

    /**
     * 模块缓存 - 用于获取其他模块地址
     * Module cache - Used to get other module addresses
     */
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /**
     * 清算配置存储 - 用于存储清算相关的配置参数
     * Liquidation configuration storage - Used to store liquidation-related configuration parameters
     */
    mapping(bytes32 => uint256) internal liquidationConfigStorage;

    /**
     * 用户清算抵押物记录：user → asset → (seizedAmount, lastSeizedTime)
     * User liquidation collateral records: user → asset → (seizedAmount, lastSeizedTime)
     * @dev 记录每个用户每种资产的清算历史
     * @dev Records liquidation history for each user's each asset
     */
    mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) private _userCollateralSeizureRecords;

    /**
     * 用户总清算数量：user → totalAmount
     * User total liquidation amount: user → totalAmount
     * @dev 记录每个用户的总清算数量
     * @dev Records total liquidation amount for each user
     */
    mapping(address => uint256) private _userTotalLiquidationAmount;

    /**
     * 清算人抵押物扣押记录：liquidator → asset → (totalSeizedAmount, totalSeizedCount)
     * Liquidator collateral seizure records: liquidator → asset → (totalSeizedAmount, totalSeizedCount)
     * @dev 记录每个清算人每种资产的扣押统计
     * @dev Records seizure statistics for each liquidator's each asset
     */
    mapping(address => mapping(address => LiquidationTypes.LiquidatorCollateralStats)) private _liquidatorCollateralStats;

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
        
        // 初始化默认参数
        liquidationConfigStorage[keccak256("LIQUIDATION_BONUS_RATE")] = DEFAULT_LIQUIDATION_BONUS_RATE;
        liquidationConfigStorage[keccak256("LIQUIDATION_THRESHOLD")] = DEFAULT_LIQUIDATION_THRESHOLD;
    }

    // ============ 修饰符 ============
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    /// @dev 清算权限验证修饰符 - 明确使用ACTION_LIQUIDATE角色
    modifier onlyLiquidator() {
        if (!LiquidationAccessControl.hasRole(_baseStorage.accessControl, ActionKeys.ACTION_LIQUIDATE, msg.sender)) {
            revert LiquidationManager__InsufficientLiquidationPermission();
        }
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

    /* ============ Core Liquidation Functions ============ */
    
    /// @notice 执行清算操作
    /// @param targetUser 被清算用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 清算抵押物数量
    /// @param debtAmount 清算债务数量
    /// @return bonus 清算奖励金额
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external override whenNotPaused nonReentrant onlyLiquidator returns (uint256 bonus) {
        // 真实落地清算：扣押 → 减债 → 奖励计算 → 事件
        bonus = LiquidationCoreOperations.executeLiquidation(
            targetUser,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            msg.sender,
            liquidationConfigStorage,
            _moduleCache,
            _userCollateralSeizureRecords,
            _userTotalLiquidationAmount,
            _liquidatorCollateralStats
        );

        // 单点推送：仅通过 KEY_LIQUIDATION_VIEW（LiquidatorView）
        // 注意：推送使用调用入参的数量可能与实际落账有偏差；推荐后续扩展 CoreOperations 返回实际变更值用于推送
        _pushLiquidationEvent(targetUser, collateralAsset, debtAsset, collateralAmount, debtAmount, msg.sender, bonus);
    }

    /// @notice 批量清算操作 - 使用批量库优化
    /// @param targetUsers 被清算用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 清算抵押物数量数组
    /// @param debtAmounts 清算债务数量数组
    /// @return bonuses 清算奖励金额数组
    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts
    ) external override whenNotPaused nonReentrant onlyLiquidator returns (uint256[] memory bonuses) {
        bonuses = LiquidationInterfaceLibrary.executeBatchLiquidationInterface(
            targetUsers,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            msg.sender,
            liquidationConfigStorage,
            _moduleCache
        );
        _pushBatchLiquidationEvent(targetUsers, collateralAssets, debtAssets, collateralAmounts, debtAmounts, msg.sender, bonuses);
    }

    /* ============ Internal: Data Push ============ */
    function _pushLiquidationEvent(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus
    ) internal {
        // 单点推送：直接调用 LiquidatorView，避免多跳转发
        address eventsView = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_VIEW);
        ILiquidationEventsView(eventsView).pushLiquidationUpdate(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            liquidator,
            bonus,
            block.timestamp
        );
    }

    function _pushBatchLiquidationEvent(
        address[] memory users,
        address[] memory collateralAssets,
        address[] memory debtAssets,
        uint256[] memory collateralAmounts,
        uint256[] memory debtAmounts,
        address liquidator,
        uint256[] memory bonuses
    ) internal {
        address eventsView = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_VIEW);
        ILiquidationEventsView(eventsView).pushBatchLiquidationUpdate(
            users,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            liquidator,
            bonuses,
            block.timestamp
        );
    }

    /* ============ Core Query Functions ============ */
    
    /// @notice 检查用户是否可被清算
    /// @param targetUser 用户地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(address targetUser) external view override returns (bool liquidatable) {
        return LiquidationCoreOperations.isLiquidatable(targetUser, liquidationConfigStorage, _moduleCache);
    }

    /// @notice 获取用户健康因子
    /// @param targetUser 用户地址
    /// @return healthFactor 健康因子（basis points）
    function getUserHealthFactor(address targetUser) external view override returns (uint256 healthFactor) {
        return LiquidationInterfaceLibrary.getUserHealthFactorInterface(targetUser, _moduleCache);
    }

    /// @notice 获取用户清算风险评分
    /// @param targetUser 用户地址
    /// @return riskScore 风险评分 (0-100)
    function getLiquidationRiskScore(address targetUser) external view override returns (uint256 riskScore) {
        return LiquidationInterfaceLibrary.getLiquidationRiskScoreInterface(targetUser, _moduleCache);
    }

    /* ============ Core Management Functions ============ */
    
    /// @notice 扣押用户抵押物
    /// @param targetUser 被清算用户地址
    /// @param asset 抵押资产地址
    /// @param amount 扣押数量
    /// @param liquidator 清算人地址
    /// @return seizedAmount 实际扣押数量
    function seizeCollateral(
        address targetUser,
        address asset,
        uint256 amount,
        address liquidator
    ) external override onlyLiquidator returns (uint256 seizedAmount) {
        return LiquidationCoreOperations.seizeCollateral(
            targetUser, 
            asset, 
            amount, 
            liquidator, 
            _moduleCache,
            _userCollateralSeizureRecords,
            _userTotalLiquidationAmount,
            _liquidatorCollateralStats
        );
    }

    /// @notice 批量扣押用户抵押物
    /// @param targetUser 被清算用户地址
    /// @param assets 抵押资产地址数组
    /// @param amounts 扣押数量数组
    /// @param liquidator 清算人地址
    /// @return seizedAmounts 实际扣押数量数组
    function batchSeizeCollateral(
        address targetUser,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external view override onlyLiquidator returns (uint256[] memory seizedAmounts) {
        return LiquidationInterfaceLibrary.batchSeizeCollateralInterface(targetUser, assets, amounts, liquidator, _moduleCache);
    }

    /// @notice 转移清算抵押物给清算人
    /// @param asset 资产地址
    /// @param amount 转移数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external override onlyLiquidator {
        LiquidationInterfaceLibrary.transferLiquidationCollateralInterface(asset, amount, liquidator, _moduleCache);
    }

    /// @notice 减少用户债务（清算操作）
    /// @param targetUser 被清算用户地址
    /// @param asset 债务资产地址
    /// @param amount 减少数量
    /// @param liquidator 清算人地址
    /// @return reducedAmount 实际减少数量
    function reduceDebt(
        address targetUser,
        address asset,
        uint256 amount,
        address liquidator
    ) external override onlyLiquidator returns (uint256 reducedAmount) {
        return LiquidationCoreOperations.reduceDebt(targetUser, asset, amount, liquidator, _moduleCache);
    }

    /// @notice 批量减少用户债务 - 使用批量库优化
    /// @param targetUser 被清算用户地址
    /// @param assets 债务资产地址数组
    /// @param amounts 减少数量数组
    /// @param liquidator 清算人地址
    /// @return reducedAmounts 实际减少数量数组
    function batchReduceDebt(
        address targetUser,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external override onlyLiquidator returns (uint256[] memory reducedAmounts) {
        return LiquidationInterfaceLibrary.batchReduceDebtInterface(targetUser, assets, amounts, liquidator, _moduleCache);
    }

    /// @notice 没收用户保证金（清算时）
    /// @param targetUser 用户地址
    /// @param asset 资产地址
    /// @param feeReceiver 费用接收者
    /// @return forfeitedAmount 没收数量
    /// @dev 实际没收操作在 LiquidationGuaranteeManager 中执行，此处仅提供预览功能
    function forfeitGuarantee(
        address targetUser,
        address asset,
        address feeReceiver
    ) external view override onlyLiquidator returns (uint256 forfeitedAmount) {
        return LiquidationInterfaceLibrary.forfeitGuaranteeInterface(targetUser, asset, feeReceiver, _moduleCache);
    }

    /* ============ Core Query Functions ============ */
    
    /// @notice 获取用户可清算的抵押物数量
    /// @param targetUser 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address targetUser, address asset) external view override returns (uint256 seizableAmount) {
        return LiquidationInterfaceLibrary.getSeizableCollateralAmountInterface(targetUser, asset, _moduleCache);
    }

    /// @notice 获取用户可清算的债务数量
    /// @param targetUser 用户地址
    /// @param asset 资产地址
    /// @return reducibleAmount 可清算数量
    function getReducibleDebtAmount(address targetUser, address asset) external view override returns (uint256 reducibleAmount) {
        return LiquidationInterfaceLibrary.getReducibleDebtAmountInterface(targetUser, asset, _moduleCache);
    }

    /// @notice 计算清算奖励 - 使用计算库优化
    /// @param amount 清算金额
    /// @return bonus 清算奖励
    function calculateLiquidationBonus(uint256 amount) external view override returns (uint256 bonus) {
        return LiquidationInterfaceLibrary.calculateLiquidationBonusInterface(amount, liquidationConfigStorage);
    }

    /// @notice 获取清算奖励比例
    /// @return bonusRate 清算奖励比例（basis points）
    function getLiquidationBonusRate() external view override returns (uint256 bonusRate) {
        return LiquidationInterfaceLibrary.getLiquidationBonusRateInterface(liquidationConfigStorage);
    }

    /* ============ Emergency Functions ============ */
    
    /// @notice 紧急暂停所有清算操作
    function emergencyPause() external onlyLiquidator {
        _pause();
    }

    /// @notice 紧急恢复所有清算操作
    function emergencyUnpause() external onlyLiquidator {
        _unpause();
    }

    /* ============ UUPS Upgradeable ============ */
    
    /**
     * 授权升级 - 检查调用者是否具有升级权限
     * Authorize upgrade - Check if caller has upgrade permission
     * @param newImplementation 新实现地址 New implementation address
     */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationValidationLibrary.validateAddress(newImplementation, "Implementation");
    }
} 