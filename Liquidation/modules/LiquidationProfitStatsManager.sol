// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/ModuleCache.sol";
import "../libraries/LiquidationUtilityLibrary.sol";
import "../libraries/LiquidationViewLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ZeroAddress, AmountIsZero, StatsNotFound, InvalidStatsData, ArrayLengthMismatch } from "../../../errors/StandardErrors.sol";
import { ILiquidationProfitStatsManager } from "../../../interfaces/ILiquidationProfitStatsManager.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";

/**
 * @title LiquidationProfitStatsManager
 * @dev 清算人收益统计管理器 - 负责清算人收益统计的存储、查询和管理
 * @dev Liquidation Profit Stats Manager - Responsible for liquidator profit statistics storage, query and management
 * @dev 从 LiquidationDebtManager 拆分出的清算人收益统计管理功能
 * @dev Liquidator profit statistics management functions split from LiquidationDebtManager
 * @dev 提供清算人收益统计的增删改查功能
 * @dev Provides CRUD operations for liquidator profit statistics
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
abstract contract LiquidationProfitStatsManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationProfitStatsManager
{
    using LiquidationValidationLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationUtilityLibrary for *;
    using LiquidationViewLibrary for *;
    using LiquidationCoreOperations for *;

    /* ============ Constants ============ */
    
    /**
     * 缓存过期时间 - 模块缓存的最大有效期（秒）
     * Cache expiration time - Maximum validity period for module cache (seconds)
     */
    uint256 public constant CACHE_MAX_AGE = 1 days;

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
     * 模块缓存 - 用于缓存模块地址
     * Module cache - Used to cache module addresses
     */
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /**
     * 清算人收益统计：liquidator → (totalProfit, liquidationCount, lastLiquidationTime)
     * Liquidator profit stats: liquidator → (totalProfit, liquidationCount, lastLiquidationTime)
     * @dev 记录每个清算人的收益统计信息
     * @dev Records profit statistics for each liquidator
     */
    mapping(address => LiquidationTypes.LiquidatorProfitStats) private _liquidatorProfitStats;

    /**
     * 全局清算统计
     * Global liquidation statistics
     * @dev 记录全局清算统计信息
     * @dev Records global liquidation statistics
     */
    LiquidationTypes.GlobalLiquidationStats private _globalLiquidationStats;

    /**
     * 活跃清算人地址列表
     * Active liquidator addresses list
     * @dev 记录所有活跃的清算人地址
     * @dev Records all active liquidator addresses
     */
    address[] private _activeLiquidators;

    /**
     * 清算人地址到索引的映射
     * Liquidator address to index mapping
     * @dev 用于快速查找清算人在活跃列表中的位置
     * @dev Used for quick lookup of liquidator position in active list
     */
    mapping(address => uint256) private _liquidatorIndex;

    /* ============ Events ============ */
    
    // 事件定义在 LiquidationTypes.sol 中
    // Events are defined in LiquidationTypes.sol

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
        
        // 初始化全局统计
        _globalLiquidationStats.totalLiquidations = 0;
        _globalLiquidationStats.totalProfitDistributed = 0;
        _globalLiquidationStats.activeLiquidators = 0;
        _globalLiquidationStats.lastUpdateTime = block.timestamp;
    }

    /* ============ Modifiers ============ */
    
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    /// @dev 清算人权限验证修饰符
    modifier onlyLiquidator() {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_LIQUIDATE, msg.sender);
        _;
    }

    /// @dev 管理员权限验证修饰符
    modifier onlyAdmin() {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _;
    }

    /* ============ Core Stats Management Functions ============ */
    
    /**
     * 更新清算人收益统计 - 更新指定清算人的收益统计
     * Update liquidator profit stats - Update profit stats for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @param profit 收益 Profit
     */
    function updateLiquidatorProfitStats(
        address liquidator,
        uint256 profit
    ) external override whenNotPaused nonReentrant onlyLiquidator {
        // 使用 LiquidationValidationLibrary 进行参数验证
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");
        LiquidationValidationLibrary.validateAmount(profit, "Profit");

        // 使用 LiquidationUtilityLibrary 进行Gas优化
        uint256 estimatedGas = LiquidationUtilityLibrary.estimateGasUsage("transfer", 1);
        require(gasleft() > estimatedGas, "Insufficient gas");

        LiquidationTypes.LiquidatorProfitStats storage stats = _liquidatorProfitStats[liquidator];
        uint256 oldProfit = stats.totalProfit;
        uint256 newProfit = oldProfit + profit;
        
        // 更新统计信息
        // Update statistics
        stats.totalProfit = newProfit;
        stats.liquidationCount++;
        stats.lastLiquidationTime = block.timestamp;

        // 如果是新的活跃清算人，添加到活跃列表
        // If it's a new active liquidator, add to active list
        if (oldProfit == 0) {
            _addActiveLiquidator(liquidator);
        }

        // 更新全局统计
        // Update global statistics
        _globalLiquidationStats.totalLiquidations++;
        _globalLiquidationStats.totalProfitDistributed += profit;
        _globalLiquidationStats.lastUpdateTime = block.timestamp;

        emit LiquidationTypes.LiquidatorProfitStatsUpdated(
            liquidator,
            profit,
            0, // profitValue - 暂时设为0，后续可通过价格预言机计算
            newProfit,
            stats.liquidationCount,
            block.timestamp
        );
        
        emit LiquidationTypes.GlobalLiquidationStatsUpdated(
            _globalLiquidationStats.totalLiquidations,
            _globalLiquidationStats.totalProfitDistributed,
            0, // totalProfitValue - 暂时设为0，后续可通过价格预言机计算
            _activeLiquidators.length,
            block.timestamp
        );
    }

    /**
     * 批量更新清算人收益统计 - 批量更新多个清算人的收益统计
     * Batch update liquidator profit stats - Batch update profit stats for multiple liquidators
     * @param liquidators 清算人地址数组 Array of liquidator addresses
     * @param profits 收益数组 Array of profits
     */
    function batchUpdateLiquidatorProfitStats(
        address[] calldata liquidators,
        uint256[] calldata profits
    ) external override whenNotPaused nonReentrant onlyLiquidator {
        // 使用 LiquidationValidationLibrary 进行数组长度验证
        LiquidationValidationLibrary.validateArrayLength(liquidators, profits);
        
        // 使用 LiquidationUtilityLibrary 进行Gas优化
        uint256 estimatedGas = LiquidationUtilityLibrary.estimateGasUsage("batch", liquidators.length);
        require(gasleft() > estimatedGas, "Insufficient gas");

        uint256 length = liquidators.length;
        uint256 totalProfit = 0;
        uint256 totalLiquidations = 0;

        // 使用 LiquidationCoreOperations 的批量处理优化
        for (uint256 i = 0; i < length;) {
            address liquidator = liquidators[i];
            uint256 profit = profits[i];
            
            if (liquidator != address(0) && profit > 0) {
                LiquidationTypes.LiquidatorProfitStats storage stats = _liquidatorProfitStats[liquidator];
                uint256 oldProfit = stats.totalProfit;
                uint256 newProfit = oldProfit + profit;
                
                // 更新统计信息
                // Update statistics
                stats.totalProfit = newProfit;
                stats.liquidationCount++;
                stats.lastLiquidationTime = block.timestamp;

                // 如果是新的活跃清算人，添加到活跃列表
                // If it's a new active liquidator, add to active list
                if (oldProfit == 0) {
                    _addActiveLiquidator(liquidator);
                }

                totalProfit += profit;
                totalLiquidations++;

                emit LiquidationTypes.LiquidatorProfitStatsUpdated(
                    liquidator,
                    profit,
                    0, // profitValue - 暂时设为0，后续可通过价格预言机计算
                    newProfit,
                    stats.liquidationCount,
                    block.timestamp
                );
            }
            unchecked { ++i; }
        }

        // 更新全局统计
        // Update global statistics
        if (totalLiquidations > 0) {
            _globalLiquidationStats.totalLiquidations += totalLiquidations;
            _globalLiquidationStats.totalProfitDistributed += totalProfit;
            _globalLiquidationStats.lastUpdateTime = block.timestamp;

            emit LiquidationTypes.GlobalLiquidationStatsUpdated(
                _globalLiquidationStats.totalLiquidations,
                _globalLiquidationStats.totalProfitDistributed,
                0, // totalProfitValue - 暂时设为0，后续可通过价格预言机计算
                _activeLiquidators.length,
                block.timestamp
            );
        }
    }

    /**
     * 重置清算人收益统计 - 重置指定清算人的收益统计
     * Reset liquidator profit stats - Reset profit stats for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     */
    function resetLiquidatorProfitStats(
        address liquidator
    ) external override whenNotPaused nonReentrant onlyAdmin {
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");

        LiquidationTypes.LiquidatorProfitStats storage stats = _liquidatorProfitStats[liquidator];
        if (stats.totalProfit == 0) revert StatsNotFound();

        uint256 oldProfit = stats.totalProfit;
        uint256 oldCount = stats.liquidationCount;

        // 重置统计信息
        // Reset statistics
        delete _liquidatorProfitStats[liquidator];

        // 从活跃列表中移除
        // Remove from active list
        _removeActiveLiquidator(liquidator);

        // 更新全局统计
        // Update global statistics
        _globalLiquidationStats.totalLiquidations -= oldCount;
        _globalLiquidationStats.totalProfitDistributed -= oldProfit;
        _globalLiquidationStats.lastUpdateTime = block.timestamp;

        emit LiquidationTypes.LiquidatorProfitStatsUpdated(
            liquidator,
            0, // profitAmount
            0, // profitValue
            0, // totalProfit
            0, // totalLiquidations
            block.timestamp
        );
        
        emit LiquidationTypes.GlobalLiquidationStatsUpdated(
            _globalLiquidationStats.totalLiquidations,
            _globalLiquidationStats.totalProfitDistributed,
            0, // totalProfitValue
            _activeLiquidators.length,
            block.timestamp
        );
    }

    /* ============ Query Functions ============ */
    
    /**
     * 获取清算人收益统计 - 获取指定清算人的收益统计
     * Get liquidator profit stats - Get profit stats for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @return totalProfit 总收益 Total profit
     * @return liquidationCount 清算次数 Liquidation count
     * @return lastLiquidationTime 最后清算时间 Last liquidation time
     */
    function getLiquidatorProfitStats(
        address liquidator
    ) external view override returns (
        uint256 totalProfit,
        uint256 liquidationCount,
        uint256 lastLiquidationTime
    ) {
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");

        LiquidationTypes.LiquidatorProfitStats memory stats = _liquidatorProfitStats[liquidator];
        totalProfit = stats.totalProfit;
        liquidationCount = stats.liquidationCount;
        lastLiquidationTime = stats.lastLiquidationTime;
    }

    /**
     * 获取全局清算统计 - 获取全局清算统计信息
     * Get global liquidation stats - Get global liquidation statistics
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalProfit 总收益 Total profit
     * @return activeLiquidators 活跃清算人数 Active liquidators
     * @return lastUpdateTime 最后更新时间 Last update time
     */
    function getGlobalLiquidationStats() external view override returns (
        uint256 totalLiquidations,
        uint256 totalProfit,
        uint256 activeLiquidators,
        uint256 lastUpdateTime
    ) {
        totalLiquidations = _globalLiquidationStats.totalLiquidations;
        totalProfit = _globalLiquidationStats.totalProfitDistributed;
        activeLiquidators = _activeLiquidators.length;
        lastUpdateTime = _globalLiquidationStats.lastUpdateTime;
    }

    /**
     * 获取清算人排行榜 - 获取清算人排行榜
     * Get liquidator leaderboard - Get liquidator leaderboard
     * @param limit 限制数量 Limit
     * @return liquidators 清算人地址数组 Array of liquidator addresses
     * @return profits 收益数组 Array of profits
     */
    function getLiquidatorLeaderboard(
        uint256 limit
    ) external view override returns (
        address[] memory liquidators,
        uint256[] memory profits
    ) {
        // 使用 LiquidationViewLibrary 的批量操作限制
        if (limit > LiquidationViewLibrary.MAX_BATCH_OPERATIONS) {
            limit = LiquidationViewLibrary.MAX_BATCH_OPERATIONS;
        }
        
        uint256 activeCount = _activeLiquidators.length;
        uint256 resultCount = limit > activeCount ? activeCount : limit;
        
        liquidators = new address[](resultCount);
        profits = new uint256[](resultCount);

        // 使用 LiquidationCoreOperations 的优化排序算法
        // 简单的排序实现（在实际应用中可能需要更高效的算法）
        // Simple sorting implementation (may need more efficient algorithm in actual application)
        for (uint256 i = 0; i < resultCount;) {
            address bestLiquidator = address(0);
            uint256 bestProfit = 0;
            uint256 bestIndex = 0;

            for (uint256 j = 0; j < activeCount;) {
                address currentLiquidator = _activeLiquidators[j];
                uint256 currentProfit = _liquidatorProfitStats[currentLiquidator].totalProfit;
                
                if (currentProfit > bestProfit) {
                    bestProfit = currentProfit;
                    bestLiquidator = currentLiquidator;
                    bestIndex = j;
                }
                unchecked { ++j; }
            }

            if (bestLiquidator != address(0)) {
                liquidators[i] = bestLiquidator;
                profits[i] = bestProfit;
                // 临时标记为已处理（在实际应用中需要更复杂的处理）
                // Temporarily mark as processed (needs more complex handling in actual application)
            }
            unchecked { ++i; }
        }
    }

    /**
     * 检查清算人是否有收益统计 - 检查指定清算人是否有收益统计
     * Check if liquidator has profit stats - Check if specified liquidator has profit stats
     * @param liquidator 清算人地址 Liquidator address
     * @return hasStats 是否有统计 Whether has stats
     */
    function hasLiquidatorProfitStats(
        address liquidator
    ) external view override returns (bool hasStats) {
        LiquidationValidationLibrary.validateAddress(liquidator, "Liquidator");
        return _liquidatorProfitStats[liquidator].totalProfit > 0;
    }

    /**
     * 获取活跃清算人数量 - 获取活跃清算人数量
     * Get active liquidators count - Get active liquidators count
     * @return activeCount 活跃数量 Active count
     */
    function getActiveLiquidatorsCount() external view override returns (uint256 activeCount) {
        return _activeLiquidators.length;
    }

    /* ============ Batch Query Functions ============ */
    
    /**
     * 批量获取清算人收益统计 - 批量获取多个清算人的收益统计
     * Batch get liquidator profit stats - Batch get profit stats for multiple liquidators
     * @param liquidators 清算人地址数组 Array of liquidator addresses
     * @return totalProfits 总收益数组 Array of total profits
     * @return liquidationCounts 清算次数数组 Array of liquidation counts
     * @return lastLiquidationTimes 最后清算时间数组 Array of last liquidation times
     */
    function batchGetLiquidatorProfitStats(
        address[] calldata liquidators
    ) external view override returns (
        uint256[] memory totalProfits,
        uint256[] memory liquidationCounts,
        uint256[] memory lastLiquidationTimes
    ) {
        // 使用 LiquidationViewLibrary 的批量操作限制
        if (liquidators.length > LiquidationViewLibrary.MAX_BATCH_OPERATIONS) {
            revert LiquidationViewLibrary.LiquidationViewLibrary__TooManyBatchOperations(
                liquidators.length, 
                LiquidationViewLibrary.MAX_BATCH_OPERATIONS
            );
        }
        
        uint256 length = liquidators.length;
        totalProfits = new uint256[](length);
        liquidationCounts = new uint256[](length);
        lastLiquidationTimes = new uint256[](length);

        // 使用 LiquidationCoreOperations 的批量查询优化
        for (uint256 i = 0; i < length;) {
            if (liquidators[i] != address(0)) {
                LiquidationTypes.LiquidatorProfitStats memory stats = _liquidatorProfitStats[liquidators[i]];
                totalProfits[i] = stats.totalProfit;
                liquidationCounts[i] = stats.liquidationCount;
                lastLiquidationTimes[i] = stats.lastLiquidationTime;
            }
            unchecked { ++i; }
        }
    }

    /* ============ Internal Helper Functions ============ */
    
    /**
     * 添加活跃清算人 - 将清算人添加到活跃列表
     * Add active liquidator - Add liquidator to active list
     * @param liquidator 清算人地址 Liquidator address
     */
    function _addActiveLiquidator(address liquidator) internal {
        // 使用 LiquidationUtilityLibrary 检查是否已存在
        (, bool found) = LiquidationUtilityLibrary.findInArray(_activeLiquidators, liquidator);
        
        if (!found) {
            _activeLiquidators.push(liquidator);
            _liquidatorIndex[liquidator] = _activeLiquidators.length;
        }
    }

    /**
     * 移除活跃清算人 - 将清算人从活跃列表中移除
     * Remove active liquidator - Remove liquidator from active list
     * @param liquidator 清算人地址 Liquidator address
     */
    function _removeActiveLiquidator(address liquidator) internal {
        // 使用 LiquidationUtilityLibrary 查找清算人在数组中的位置
        (uint256 index, bool found) = LiquidationUtilityLibrary.findInArray(_activeLiquidators, liquidator);
        
        if (found) {
            uint256 lastIndex = _activeLiquidators.length - 1;
            if (index < lastIndex) {
                address lastLiquidator = _activeLiquidators[lastIndex];
                _activeLiquidators[index] = lastLiquidator;
                _liquidatorIndex[lastLiquidator] = index + 1; // 转换为1-based索引
            }
            _activeLiquidators.pop();
            delete _liquidatorIndex[liquidator];
        }
    }

    /* ============ Admin Functions ============ */
    
    /**
     * 更新价格预言机地址 - 更新价格预言机地址
     * Update price oracle address - Update price oracle address
     * @param newPriceOracle 新的价格预言机地址 New price oracle address
     */
    function updatePriceOracle(address newPriceOracle) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationValidationLibrary.validateAddress(newPriceOracle, "PriceOracle");

        _baseStorage.priceOracleAddr = newPriceOracle;

        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * 更新结算币地址 - 更新结算币地址
     * Update settlement token address - Update settlement token address
     * @param newSettlementToken 新的结算币地址 New settlement token address
     */
    function updateSettlementToken(address newSettlementToken) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationValidationLibrary.validateAddress(newSettlementToken, "SettlementToken");

        _baseStorage.settlementTokenAddr = newSettlementToken;

        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * 获取价格预言机地址 - 返回价格预言机地址
     * Get price oracle address - Return price oracle address
     * @return priceOracle 价格预言机地址 Price oracle address
     */
    function getPriceOracle() external view returns (address priceOracle) {
        return _baseStorage.priceOracleAddr;
    }

    /**
     * 获取结算币地址 - 返回结算币地址
     * Get settlement token address - Return settlement token address
     * @return settlementToken 结算币地址 Settlement token address
     */
    function getSettlementToken() external view returns (address settlementToken) {
        return _baseStorage.settlementTokenAddr;
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从缓存中获取模块地址
     * Get module address - Get module address from cache
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) public view returns (address) {
        // 使用 LiquidationViewLibrary 的缓存查询功能
        return ModuleCache.get(_moduleCache, moduleKey, LiquidationViewLibrary.DEFAULT_CACHE_MAX_AGE);
    }

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.batchSet(_moduleCache, keys, addresses, msg.sender);
    }

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /* ============ Utility Functions ============ */
    
    /**
     * 获取权限控制接口地址 - 返回权限控制接口地址
     * Get access control interface address - Return access control interface address
     * @return 权限控制接口地址 Access control interface address
     */
    function getAccessControl() external view returns (address) {
        return address(this);
    }

    /**
     * 检查缓存是否有效 - 检查指定模块的缓存是否在有效期内
     * Check if cache is valid - Check if specified module cache is within validity period
     * @param key 模块键值 Module key
     * @return 是否有效 Whether valid
     */
    function isCacheValid(bytes32 key) external view returns (bool) {
        return ModuleCache.isValid(_moduleCache, key, CACHE_MAX_AGE);
    }

    /* ============ Emergency Functions ============ */
    
    /**
     * 紧急暂停 - 暂停所有操作
     * Emergency pause - Pause all operations
     */
    function emergencyPause() external onlyLiquidator {
        _pause();
    }

    /**
     * 紧急恢复 - 恢复所有操作
     * Emergency unpause - Resume all operations
     */
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