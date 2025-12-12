// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationTokenLibrary.sol";
import "../libraries/LiquidationInterfaceLibrary.sol";
import "../libraries/LiquidationUtilityLibrary.sol";
import "../libraries/ModuleCache.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationViewLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";

import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILiquidationRewardManager } from "../../../interfaces/ILiquidationRewardManager.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";

/**
 * @title LiquidationRewardManager
 * @notice 清算积分奖励管理器 - 负责清算积分奖励的存储、查询和管理
 * @notice Liquidation Reward Manager - Responsible for liquidation reward storage, query and management
 * @dev 从 LiquidationDebtManager 拆分出的清算积分奖励管理功能
 * @dev Liquidation reward management functions split from LiquidationDebtManager
 * @dev 提供清算积分奖励的增删改查功能
 * @dev Provides CRUD operations for liquidation rewards
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
abstract contract LiquidationRewardManager is 
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationRewardManager,
    IRegistryUpgradeEvents
{
    using LiquidationValidationLibrary for *;
    using LiquidationTokenLibrary for *;
    using LiquidationInterfaceLibrary for *;
    using LiquidationUtilityLibrary for *;
    using LiquidationBase for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using LiquidationEventLibrary for *;
    using LiquidationViewLibrary for *;
    using LiquidationCoreOperations for *;
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    // ============ 自定义错误 ============
    /// @dev Registry未初始化错误
    error LiquidationRewardManager__RegistryNotInitialized();
    /// @dev 模块调用失败错误
    error LiquidationRewardManager__ModuleCallFailed();
    /// @dev 升级未准备就绪错误
    error LiquidationRewardManager__UpgradeNotReady();

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

    /// @notice 清算积分存储 - 包含清算积分相关配置
    /// @notice Liquidation reward storage - Contains liquidation reward configuration
    LiquidationBase.LiquidationRewardStorage internal liquidationRewardStorage;

    /**
     * @notice 清算人统计：liquidator → (totalRewards, totalLiquidations, lastLiquidationTime)
     * @notice Liquidator stats: liquidator → (totalRewards, totalLiquidations, lastLiquidationTime)
     * @dev 记录每个清算人的统计信息
     * @dev Records statistics for each liquidator
     */
    mapping(address => LiquidationTypes.LiquidatorStats) private _liquidatorStats;

    /**
     * @notice 用户清算统计：user → (totalLiquidations, totalPenalties, lastLiquidationTime)
     * @notice User liquidation stats: user → (totalLiquidations, totalPenalties, lastLiquidationTime)
     * @dev 记录每个用户的清算统计信息
     * @dev Records liquidation statistics for each user
     */
    mapping(address => LiquidationTypes.UserLiquidationStats) private _userLiquidationStats;

    /**
     * @notice 全局清算统计 - 记录全局清算统计信息
     * @notice Global liquidation stats - Records global liquidation statistics
     * @dev 包含总清算次数、总奖励金额、活跃清算人数等
     * @dev Includes total liquidations, total rewards, active liquidators, etc.
     */
    LiquidationTypes.GlobalLiquidationStats private _globalStats;

    /* ============ Events ============ */
    // Registry升级相关事件已在 IRegistryUpgradeEvents 接口中定义

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
        
        // 初始化清算积分存储
        // 注意：这些字段在LiquidationRewardStorage结构体中未定义，已移除
    }

    // ============ 修饰符 ============
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    /// @dev 清算权限验证修饰符
    modifier onlyLiquidator() {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_LIQUIDATE, msg.sender);
        _;
    }

    /// @dev Registry验证修饰符
    /// @dev Registry validation modifier
    modifier registryInitialized() {
        if (_registryAddr == address(0)) revert LiquidationRewardManager__RegistryNotInitialized();
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
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        // 获取当前模块地址用于事件
        address currentAddress = Registry(_registryAddr).getModule(moduleKey);
        (address pendingAddress, uint256 executeAfter, ) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeScheduled(moduleKey, currentAddress, pendingAddress, executeAfter);
    }

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        address oldAddress = Registry(_registryAddr).getModule(moduleKey);
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
        address newAddress = Registry(_registryAddr).getModule(moduleKey);
        
        emit RegistryModuleUpgradeExecuted(moduleKey, oldAddress, newAddress);
    }

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
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

    /* ============ Core Reward Management Functions ============ */
    
    /**
     * @notice 发放清算奖励 - 为清算人发放清算奖励积分
     * @notice Issue liquidation reward - Issue liquidation reward points for liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @param user 被清算用户地址 Liquidated user address
     * @param debtAmount 债务金额 Debt amount
     * @param collateralAmount 抵押物金额 Collateral amount
     * @dev 只有具有清算权限的角色才能调用此函数
     * @dev Only roles with liquidation permission can call this function
     * @dev 更新清算人统计、用户统计和全局统计
     * @dev Updates liquidator stats, user stats and global stats
     */
    function issueLiquidationReward(
        address liquidator,
        address user,
        uint256 debtAmount,
        uint256 collateralAmount
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");
        LiquidationValidationLibrary.validateAddress(user, "User");
        if (debtAmount == 0 && collateralAmount == 0) revert LiquidationValidationLibrary.InvalidParameter("Reward data", 0);

        // 计算奖励金额
        uint256 reward = LiquidationBase.calculateLiquidationReward(
            debtAmount,
            liquidationRewardStorage.liquidationRewardRate
        );

        if (reward > 0) {
            // 更新清算人统计
            LiquidationTypes.LiquidatorStats storage liquidatorStat = _liquidatorStats[liquidator];
            liquidatorStat.totalProfit += reward;
            liquidatorStat.totalLiquidations++;
            liquidatorStat.lastLiquidationTime = block.timestamp;

            // 更新用户清算统计
            LiquidationTypes.UserLiquidationStats storage userStat = _userLiquidationStats[user];
            userStat.totalLiquidations++;
            userStat.lastLiquidationTime = block.timestamp;

            // 更新全局清算统计
            // Update global liquidation statistics
            _globalStats.totalLiquidations++;
            _globalStats.totalProfitDistributed += reward;
            _globalStats.lastUpdateTime = block.timestamp;

            emit LiquidationRewardIssued(liquidator, user, reward, block.timestamp);
        }
    }

    /**
     * @notice 批量处理清算积分 - 批量处理多个清算人的积分
     * @notice Batch process liquidation points - Batch process points for multiple liquidators
     * @param liquidators 清算人地址数组 Array of liquidator addresses
     * @param points 积分数组 Array of points
     * @dev 只有具有清算权限的角色才能调用此函数
     * @dev Only roles with liquidation permission can call this function
     * @dev 验证数组长度匹配
     * @dev Validates array length match
     */
    function batchProcessLiquidationPoints(
        address[] calldata liquidators,
        uint256[] calldata points
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        if (liquidators.length != points.length) revert LiquidationValidationLibrary.ArrayLengthMismatch(liquidators.length, points.length);

        uint256 length = liquidators.length;
        for (uint256 i = 0; i < length;) {
            address liquidator = liquidators[i];
            uint256 pointsAmount = points[i];
            
            if (liquidator != address(0) && pointsAmount > 0) {
                // 更新清算人统计
                LiquidationTypes.LiquidatorStats storage liquidatorStat = _liquidatorStats[liquidator];
                liquidatorStat.totalLiquidations++;
                liquidatorStat.lastLiquidationTime = block.timestamp;

                emit LiquidationPointsProcessed(liquidator, pointsAmount, block.timestamp);
            }
            unchecked { ++i; }
        }

        // 更新全局清算统计
        // Update global liquidation statistics
        _globalStats.totalLiquidations += length;
        _globalStats.lastUpdateTime = block.timestamp;
    }

    /**
     * @notice 计算清算奖励 - 基于债务和抵押物计算清算奖励
     * @notice Calculate liquidation reward - Calculate liquidation reward based on debt and collateral
     * @param debtAmount 债务金额 Debt amount
     * @param collateralAmount 抵押物金额 Collateral amount
     * @return reward 奖励金额 Reward amount
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function calculateLiquidationReward(
        uint256 debtAmount,
        uint256 collateralAmount
    ) external view override returns (uint256 reward) {
        // 基于债务金额和抵押物金额计算奖励
        // Calculate reward based on debt amount and collateral amount
        uint256 totalValue = debtAmount + collateralAmount;
        if (totalValue == 0) return 0;
        
        // 使用债务金额作为主要计算依据，抵押物金额作为权重因子
        // Use debt amount as primary calculation basis, collateral amount as weight factor
        uint256 weightedDebt = debtAmount + (collateralAmount / 2); // 抵押物权重为50% Collateral weight is 50%
        
        return LiquidationBase.calculateLiquidationReward(
            weightedDebt,
            liquidationRewardStorage.liquidationRewardRate
        );
    }

    /**
     * @notice 计算清算惩罚 - 基于债务和抵押物计算清算惩罚
     * @notice Calculate liquidation penalty - Calculate liquidation penalty based on debt and collateral
     * @param debtAmount 债务金额 Debt amount
     * @param collateralAmount 抵押物金额 Collateral amount
     * @return penalty 惩罚金额 Penalty amount
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function calculateLiquidationPenalty(
        uint256 debtAmount,
        uint256 collateralAmount
    ) external view override returns (uint256 penalty) {
        // 基于债务金额和抵押物金额计算惩罚
        // Calculate penalty based on debt amount and collateral amount
        uint256 totalValue = debtAmount + collateralAmount;
        if (totalValue == 0) return 0;
        
        // 使用债务金额作为主要计算依据，抵押物金额作为权重因子
        // Use debt amount as primary calculation basis, collateral amount as weight factor
        uint256 weightedDebt = debtAmount + (collateralAmount / 2); // 抵押物权重为50% Collateral weight is 50%
        
        return LiquidationBase.calculateLiquidationPenalty(
            weightedDebt,
            liquidationRewardStorage.liquidationPenaltyRate
        );
    }

    /* ============ Query Functions ============ */
    
    /**
     * @notice 获取清算统计 - 获取全局清算统计信息
     * @notice Get liquidation stats - Get global liquidation statistics
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalRewards 总奖励金额 Total rewards
     * @return totalPenalties 总惩罚金额 Total penalties
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getLiquidationStats() external view override returns (
        uint256 totalLiquidations,
        uint256 totalRewards,
        uint256 totalPenalties
    ) {
        // 返回本合约维护的全局清算统计
        // Return global liquidation statistics maintained by this contract
        totalLiquidations = _globalStats.totalLiquidations;
        totalRewards = _globalStats.totalProfitDistributed; // 使用总收益分配作为总奖励
        totalPenalties = 0; // 暂时设为0，因为GlobalLiquidationStats中没有totalPenalties字段
    }

    /**
     * @notice 获取清算人统计 - 获取指定清算人的统计信息
     * @notice Get liquidator stats - Get statistics for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @return totalRewards 总奖励金额 Total rewards
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return lastLiquidationTime 最后清算时间 Last liquidation time
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getLiquidatorStats(
        address liquidator
    ) external view override returns (
        uint256 totalRewards,
        uint256 totalLiquidations,
        uint256 lastLiquidationTime
    ) {
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");

        LiquidationTypes.LiquidatorStats memory stats = _liquidatorStats[liquidator];
        totalRewards = stats.totalProfit;
        totalLiquidations = stats.totalLiquidations;
        lastLiquidationTime = stats.lastLiquidationTime;
    }

    /**
     * @notice 获取用户清算统计 - 获取指定用户的清算统计信息
     * @notice Get user liquidation stats - Get liquidation statistics for specified user
     * @param user 用户地址 User address
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalPenalties 总惩罚金额 Total penalties
     * @return lastLiquidationTime 最后清算时间 Last liquidation time
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getUserLiquidationStats(
        address user
    ) external view override returns (
        uint256 totalLiquidations,
        uint256 totalPenalties,
        uint256 lastLiquidationTime
    ) {
        LiquidationValidationLibrary.validateAddress(user, "User");

        LiquidationTypes.UserLiquidationStats memory stats = _userLiquidationStats[user];
        totalLiquidations = stats.totalLiquidations;
        totalPenalties = stats.totalPenalties;
        lastLiquidationTime = stats.lastLiquidationTime;
    }

    /**
     * @notice 获取清算奖励率 - 查询当前清算奖励率
     * @notice Get liquidation reward rate - Query current liquidation reward rate
     * @return rewardRate 奖励率 Reward rate
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getLiquidationRewardRate() external view override returns (uint256 rewardRate) {
        return liquidationRewardStorage.liquidationRewardRate;
    }

    /**
     * @notice 获取清算惩罚率 - 查询当前清算惩罚率
     * @notice Get liquidation penalty rate - Query current liquidation penalty rate
     * @return penaltyRate 惩罚率 Penalty rate
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getLiquidationPenaltyRate() external view override returns (uint256 penaltyRate) {
        return liquidationRewardStorage.liquidationPenaltyRate;
    }

    /* ============ Getter Functions ============ */
    
    /**
     * @notice 获取基础存储信息 - 查询合约的基础配置信息
     * @notice Get base storage - Query contract's basic configuration information
     * @return priceOracle 价格预言机地址，用于获取资产价格 Price oracle address for asset pricing
     * @return settlementToken 结算币地址，用于债务结算的币种 Settlement token address for debt settlement
     * @return registry Registry地址，用于模块地址管理 Registry address for module address management
     * @return acm 权限控制管理器地址，用于权限验证 Access control manager address for permission validation
     * @dev 这是一个只读查询函数，返回合约的核心配置信息
     * @dev This is a read-only query function that returns contract's core configuration information
     */
    function getBaseStorage() external view returns (address priceOracle, address settlementToken, address registry, address acm) {
        return (_baseStorage.priceOracleAddr, _baseStorage.settlementTokenAddr, _registryAddr, address(this));
    }

    /**
     * @notice 获取清算奖励存储信息 - 查询清算奖励相关配置
     * @notice Get reward storage - Query liquidation reward configuration
     * @return rewardRate 奖励比例 Reward rate
     * @return penaltyRate 惩罚比例 Penalty rate
     * @return profitRate 收益比例 Profit rate
     * @dev 这是一个只读查询函数，返回清算奖励配置信息
     * @dev This is a read-only query function that returns liquidation reward configuration
     */
    function getRewardStorage() external view returns (uint256 rewardRate, uint256 penaltyRate, uint256 profitRate) {
        return (liquidationRewardStorage.liquidationRewardRate, liquidationRewardStorage.liquidationPenaltyRate, liquidationRewardStorage.liquidatorProfitRate);
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
     * @notice 获取Registry地址 - 查询当前Registry地址
     * @notice Get Registry address - Query current Registry address
     * @return registry Registry地址，用于模块地址管理 Registry address for module address management
     * @dev 这是一个只读查询函数，返回Registry地址
     * @dev This is a read-only query function that returns Registry address
     */
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    /**
     * @notice 获取权限控制管理器地址 - 查询当前权限控制管理器地址
     * @notice Get access control manager - Query current access control manager address
     * @return acm 权限控制管理器地址，用于权限验证 Access control manager address for permission validation
     * @dev 这是一个只读查询函数，返回当前合约地址作为权限控制管理器
     * @dev This is a read-only query function that returns current contract address as access control manager
     */
    function getAccessControlManager() external view returns (address acm) {
        return address(this);
    }

    /**
     * @notice 获取清算人收益率 - 查询当前清算人收益率
     * @notice Get liquidator profit rate - Query current liquidator profit rate
     * @return profitRate 清算人收益率 Liquidator profit rate
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getLiquidatorProfitRate() external view returns (uint256 profitRate) {
        return liquidationRewardStorage.liquidatorProfitRate;
    }

    /**
     * @notice 获取全局清算统计信息 - 查询全局清算统计
     * @notice Get global liquidation stats - Query global liquidation statistics
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalProfitDistributed 总分配利润 Total distributed profit
     * @return lastUpdateTime 最后更新时间 Last update time
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getGlobalLiquidationStats() external view returns (
        uint256 totalLiquidations,
        uint256 totalProfitDistributed,
        uint256 lastUpdateTime
    ) {
        // 返回本合约维护的全局清算统计
        // Return global liquidation statistics maintained by this contract
        totalLiquidations = _globalStats.totalLiquidations;
        totalProfitDistributed = _globalStats.totalProfitDistributed;
        lastUpdateTime = _globalStats.lastUpdateTime;
    }

    /* ============ Admin Functions ============ */
    
    /**
     * @notice 更新清算奖励率 - 设置新的清算奖励率
     * @notice Update liquidation reward rate - Set new liquidation reward rate
     * @param newRate 新奖励率 New reward rate
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 验证新奖励率的有效性
     * @dev Validates new reward rate validity
     */
    function updateLiquidationRewardRate(
        uint256 newRate
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (newRate > 10000) revert LiquidationValidationLibrary.InvalidRange();

        uint256 oldRate = liquidationRewardStorage.liquidationRewardRate;
        liquidationRewardStorage.liquidationRewardRate = newRate;

        emit LiquidationEventLibrary.ConfigurationUpdated("liquidationRewardRate", oldRate, newRate, msg.sender, block.timestamp);
    }

    /**
     * @notice 更新清算惩罚率 - 设置新的清算惩罚率
     * @notice Update liquidation penalty rate - Set new liquidation penalty rate
     * @param newRate 新惩罚率 New penalty rate
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 验证新惩罚率的有效性
     * @dev Validates new penalty rate validity
     */
    function updateLiquidationPenaltyRate(
        uint256 newRate
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (newRate > 10000) revert LiquidationValidationLibrary.InvalidRange();

        uint256 oldRate = liquidationRewardStorage.liquidationPenaltyRate;
        liquidationRewardStorage.liquidationPenaltyRate = newRate;

        emit LiquidationEventLibrary.ConfigurationUpdated("liquidationPenaltyRate", oldRate, newRate, msg.sender, block.timestamp);
    }

    /**
     * @notice 更新清算人收益率 - 设置新的清算人收益率
     * @notice Update liquidator profit rate - Set new liquidator profit rate
     * @param newRate 新收益率 New profit rate
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 验证新收益率的有效性
     * @dev Validates new profit rate validity
     */
    function updateLiquidatorProfitRate(
        uint256 newRate
    ) external override whenNotPaused nonReentrant onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (newRate > 10000) revert LiquidationValidationLibrary.InvalidRange();

        uint256 oldRate = liquidationRewardStorage.liquidatorProfitRate;
        liquidationRewardStorage.liquidatorProfitRate = newRate;

        emit LiquidationEventLibrary.ConfigurationUpdated("liquidatorProfitRate", oldRate, newRate, msg.sender, block.timestamp);
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * @notice 获取模块地址 - 从Registry获取指定模块的地址
     * @notice Get module address - Get address of specified module from Registry
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return 模块地址，如果未找到则返回零地址 Module address, returns zero address if not found
     * @dev 直接从 Registry 获取最新地址，不经过缓存
     * @dev Gets latest address directly from Registry, bypassing cache
     */
    function getModule(bytes32 moduleKey) public view override returns (address) {
        if (_registryAddr == address(0)) return address(0);
        return Registry(_registryAddr).getModule(moduleKey);
    }

    /**
     * @notice 更新模块 - 更新指定模块的缓存地址
     * @notice Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     */
    function updateModule(bytes32 key, address addr) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /**
     * @notice 批量更新模块 - 一次性更新多个模块
     * @notice Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 验证数组长度匹配
     * @dev Validates array length match
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (keys.length != addresses.length) revert LiquidationValidationLibrary.ArrayLengthMismatch(keys.length, addresses.length);
        
        for (uint256 i = 0; i < keys.length;) {
            ModuleCache.set(_moduleCache, keys[i], addresses[i], msg.sender);
            unchecked { ++i; }
        }
    }

    /**
     * @notice 移除模块 - 从缓存中移除指定模块
     * @notice Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     */
    function removeModule(bytes32 key) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.remove(_moduleCache, key, msg.sender);
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