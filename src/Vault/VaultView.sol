// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";

/// @title VaultView
/// @notice 双架构智能协调器 - 事件驱动 + View层缓存
/// @dev 双架构设计：用户操作处理、模块分发、View层缓存、数据推送、免费查询
/// @dev 事件驱动架构：统一事件发出，支持数据库收集和AI分析
/// @dev View层缓存：提供快速免费查询，所有查询函数使用view（0 gas）
/// @custom:security-contact security@example.com
contract VaultView is Initializable, UUPSUpgradeable {
    
    /*━━━━━━━━━━━━━━━ 基础配置 ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry 合约地址
    address private _registryAddrVar;
    
    /// @notice 最后升级时间戳
    uint256 private _lastUpgradeTimestamp;
    
    /*━━━━━━━━━━━━━━━ 模块地址缓存 ━━━━━━━━━━━━━━━*/
    
    /// @notice 抵押管理器地址缓存
    address private _cachedCollateralManager;
    
    /// @notice 借贷引擎地址缓存
    address private _cachedLendingEngine;
    
    // legacy: 健康因子计算器地址缓存（保留字段避免升级破坏，但不再使用）
    address private _cachedHealthFactorCalculator;
    
    /// @notice 价格预言机地址缓存
    address private _cachedPriceOracle;
    
    /// @notice 模块缓存时间戳
    uint256 private _moduleCacheTimestamp;
    
    /// @notice 模块缓存有效期（1小时）
    uint256 private constant MODULE_CACHE_DURATION = 3600;
    
    /*━━━━━━━━━━━━━━━ View层缓存数据 ━━━━━━━━━━━━━━━*/
    
    /// @notice 用户抵押缓存：用户地址 => 资产地址 => 抵押数量
    mapping(address => mapping(address => uint256)) private _userCollateral;
    
    /// @notice 用户债务缓存：用户地址 => 资产地址 => 债务数量
    mapping(address => mapping(address => uint256)) private _userDebt;
    
    /// @notice 缓存时间戳：用户地址 => 最后更新时间戳
    mapping(address => uint256) private _cacheTimestamps;
    
    /// @notice 缓存有效期（5分钟）
    uint256 private constant CACHE_DURATION = 300;
    
    /// @notice 缓存用户总数
    uint256 private _totalCachedUsers;
    
    /// @notice 有效缓存用户数
    uint256 private _validCachedUsers;
    
    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error VaultView__ZeroAddress();
    error VaultView__InvalidAmount();
    error VaultView__UnauthorizedAccess();
    error VaultView__ModuleNotFound();
    error VaultView__ModuleCacheExpired();
    
    /*━━━━━━━━━━━━━━━ 权限控制 ━━━━━━━━━━━━━━━*/
    
    /// @notice 安全修饰符 - 验证 Registry 地址
    modifier onlyValidRegistry() {
        if (_registryAddrVar == address(0)) revert VaultView__ZeroAddress();
        _;
    }
    
    /// @notice 授权合约验证修饰符
    modifier onlyAuthorizedContract() {
        // 允许VaultCore和VaultCoreRefactored调用
        address vaultCore = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        if (msg.sender != vaultCore) revert VaultView__UnauthorizedAccess();
        _;
    }
    
    /// @notice 业务合约验证修饰符
    modifier onlyBusinessContract() {
        // 允许业务模块调用：CollateralManager / LendingEngineBasic / VaultBusinessLogic
        address collateralManager = _getCachedCollateralManager();
        address lendingEngine = _getCachedLendingEngine();
        address vbl = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        if (msg.sender != collateralManager && msg.sender != lendingEngine && msg.sender != vbl) {
            revert VaultView__UnauthorizedAccess();
        }
        _;
    }
    
    /// @notice 管理员权限验证修饰符
    modifier onlyAdmin() {
        address acmAddr = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_ADMIN, msg.sender), "Not admin");
        _;
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/
    
    /// @notice 初始化函数
    /// @param initialRegistryAddr Registry合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert VaultView__ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddrVar = initialRegistryAddr;
        _lastUpgradeTimestamp = block.timestamp;
        
        // 初始化模块缓存时间戳，但不立即刷新（等模块注册后再刷新）
        _moduleCacheTimestamp = block.timestamp;
    }
    
    /// @notice 显式暴露 Registry 地址（与外部依赖保持兼容）
    function registryAddrVar() external view returns (address) {
        return _registryAddrVar;
    }
    
    /*━━━━━━━━━━━━━━━ 模块缓存管理 ━━━━━━━━━━━━━━━*/
    
    /// @notice 刷新模块地址缓存
    /// @dev 内部函数，用于更新模块地址缓存
    function _refreshModuleCache() internal {
        _cachedCollateralManager = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_CM);
        _cachedLendingEngine = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_LE);
        // 兼容保留：不再依赖 HF_CALC
        _cachedHealthFactorCalculator = address(0);
        _cachedPriceOracle = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        _moduleCacheTimestamp = block.timestamp;
    }
    
    /// @notice 获取缓存的抵押管理器地址
    /// @return collateralManager 抵押管理器地址
    function _getCachedCollateralManager() internal view returns (address collateralManager) {
        if (block.timestamp - _moduleCacheTimestamp > MODULE_CACHE_DURATION) {
            revert VaultView__ModuleCacheExpired();
        }
        return _cachedCollateralManager;
    }
    
    /// @notice 获取缓存的借贷引擎地址
    /// @return lendingEngine 借贷引擎地址
    function _getCachedLendingEngine() internal view returns (address lendingEngine) {
        if (block.timestamp - _moduleCacheTimestamp > MODULE_CACHE_DURATION) {
            revert VaultView__ModuleCacheExpired();
        }
        return _cachedLendingEngine;
    }
    
    /// @notice 获取缓存的健康因子计算器地址
    /// @return healthFactorCalculator 健康因子计算器地址
    function _getCachedHealthFactorCalculator() internal view returns (address healthFactorCalculator) {
        if (block.timestamp - _moduleCacheTimestamp > MODULE_CACHE_DURATION) {
            revert VaultView__ModuleCacheExpired();
        }
        return _cachedHealthFactorCalculator;
    }
    
    /// @notice 获取缓存的价格预言机地址
    /// @return priceOracle 价格预言机地址
    function _getCachedPriceOracle() internal view returns (address priceOracle) {
        if (block.timestamp - _moduleCacheTimestamp > MODULE_CACHE_DURATION) {
            revert VaultView__ModuleCacheExpired();
        }
        return _cachedPriceOracle;
    }
    
    /// @notice 手动刷新模块缓存（管理员功能）
    /// @dev 当模块地址更新时，管理员可以手动刷新缓存
    function refreshModuleCache() external onlyAdmin {
        _refreshModuleCache();
        emit ModuleCacheRefreshed(block.timestamp);
        // 统一数据推送：模块缓存刷新
        DataPushLibrary._emitData(
            keccak256("MODULE_CACHE_REFRESHED"),
            abi.encode(block.timestamp)
        );
    }
    
    /*━━━━━━━━━━━━━━━ 用户操作处理（双架构核心）━━━━━━━━━━━━━━━*/
    
    /// @notice 处理用户操作 - 双架构智能协调器核心功能
    /// @param user 用户地址
    /// @param operationType 操作类型
    /// @param asset 资产地址
    /// @param amount 操作金额
    /// @param timestamp 时间戳
    /// @dev 双架构设计：验证操作、分发到模块、更新缓存、发出事件
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    ) external onlyAuthorizedContract {
        // 1. 验证操作
        _validateOperation(user, operationType, asset, amount);
        
        // 2. 分发到相应模块
        _distributeToModule(user, operationType, asset, amount);
        
        // 3. 更新View层缓存
        _updateLocalState(user, operationType, asset, amount);
        
        // 4. 发出事件（事件驱动架构）
        emit UserOperation(user, operationType, asset, amount, timestamp);
        
        // 5. 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            keccak256("USER_OPERATION"),
            abi.encode(user, operationType, asset, amount, timestamp)
        );
    }
    
    /// @notice 验证用户操作
    /// @param user 用户地址
    /// @param operationType 操作类型
    /// @param asset 资产地址
    /// @param amount 操作金额
    function _validateOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount
    ) internal pure {
        if (user == address(0)) revert VaultView__ZeroAddress();
        if (asset == address(0)) revert VaultView__ZeroAddress();
        if (amount == 0) revert VaultView__InvalidAmount();
        
        // 验证操作类型
        require(
            operationType == ActionKeys.ACTION_DEPOSIT ||
            operationType == ActionKeys.ACTION_BORROW  ||
            operationType == ActionKeys.ACTION_REPAY   ||
            operationType == ActionKeys.ACTION_WITHDRAW,
            "Invalid operation type"
        );
    }
    
    /// @notice 分发操作到相应模块（优化版本）
    /// @param user 用户地址
    /// @param operationType 操作类型
    /// @param asset 资产地址
    /// @param amount 操作金额
    function _distributeToModule(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount
    ) internal onlyValidRegistry {
        if (operationType == ActionKeys.ACTION_DEPOSIT) {
            // 分发到抵押管理器 - 存入抵押物
            address collateralManager = _getCachedCollateralManager();
            ICollateralManager(collateralManager).depositCollateral(user, asset, amount);
        } else if (operationType == ActionKeys.ACTION_WITHDRAW) {
            // 分发到抵押管理器 - 提取抵押物
            address collateralManager = _getCachedCollateralManager();
            ICollateralManager(collateralManager).withdrawCollateral(user, asset, amount);
        } else if (operationType == ActionKeys.ACTION_BORROW) {
            // 账本写入统一由 VaultCore 执行；View 层不再直写账本
            // 这里仅进行本地缓存更新由上层调用触发（processUserOperation 后续 _updateLocalState）
        } else if (operationType == ActionKeys.ACTION_REPAY) {
            // 账本写入统一由 VaultCore 执行；View 层不再直写账本
            // 这里仅进行本地缓存更新由上层调用触发（processUserOperation 后续 _updateLocalState）
        }
    }
    
    /// @notice 更新本地状态缓存
    /// @param user 用户地址
    /// @param operationType 操作类型
    /// @param asset 资产地址
    /// @param amount 操作金额
    function _updateLocalState(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount
    ) internal {
        // 检查是否是新用户
        bool isNewUser = _cacheTimestamps[user] == 0;
        
        if (operationType == ActionKeys.ACTION_DEPOSIT) {
            _userCollateral[user][asset] += amount;
        } else if (operationType == ActionKeys.ACTION_WITHDRAW) {
            if (_userCollateral[user][asset] >= amount) {
                _userCollateral[user][asset] -= amount;
            }
        } else if (operationType == ActionKeys.ACTION_BORROW) {
            _userDebt[user][asset] += amount;
        } else if (operationType == ActionKeys.ACTION_REPAY) {
            if (_userDebt[user][asset] >= amount) {
                _userDebt[user][asset] -= amount;
            }
        }
        
        // 更新缓存时间戳
        _cacheTimestamps[user] = block.timestamp;
        
        // 更新缓存统计
        if (isNewUser) {
            _totalCachedUsers++;
        }
        _updateValidCacheCount();
    }
    
    /// @notice 更新有效缓存计数
    function _updateValidCacheCount() internal {
        // 这里简化实现，实际可以通过遍历或维护一个有效用户列表来精确计算
        // 为了性能考虑，这里使用估算值
        _validCachedUsers = _totalCachedUsers; // 简化实现
    }
    
    /*━━━━━━━━━━━━━━━ 数据推送接口（事件驱动架构）━━━━━━━━━━━━━━━*/
    
    /// @notice 推送用户位置更新 - 数据推送接口
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param collateral 抵押数量
    /// @param debt 债务数量
    /// @dev 业务模块推送数据更新到View层缓存
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external onlyBusinessContract {
        // 检查是否是新用户
        bool isNewUser = _cacheTimestamps[user] == 0;
        
        // 更新View层缓存
        _userCollateral[user][asset] = collateral;
        _userDebt[user][asset] = debt;
        _cacheTimestamps[user] = block.timestamp;
        
        // 更新缓存统计
        if (isNewUser) {
            _totalCachedUsers++;
        }
        _updateValidCacheCount();
        
        // 发出事件（事件驱动架构）
        emit UserPositionUpdated(user, asset, collateral, debt, block.timestamp);
        
        // 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            keccak256("USER_POSITION_UPDATED"),
            abi.encode(user, asset, collateral, debt, block.timestamp)
        );
    }
    
    /// @notice 推送系统状态更新 - 数据推送接口
    /// @param asset 资产地址
    /// @param totalCollateral 总抵押数量
    /// @param totalDebt 总债务数量
    /// @dev 业务模块推送系统状态更新
    function pushSystemStateUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt
    ) external onlyBusinessContract {
        // 发出事件（事件驱动架构）
        emit SystemStateUpdated(asset, totalCollateral, totalDebt, block.timestamp);
        
        // 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            keccak256("SYSTEM_STATE_UPDATED"),
            abi.encode(asset, totalCollateral, totalDebt, block.timestamp)
        );
    }
    
    /*━━━━━━━━━━━━━━━ 查询接口（免费查询）━━━━━━━━━━━━━━━*/
    
    /// @notice 获取用户位置 - 免费查询接口
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    /// @dev 0 gas，快速查询
    function getUserPosition(address user, address asset) external view 
        returns (uint256 collateral, uint256 debt) {
        return (_userCollateral[user][asset], _userDebt[user][asset]);
    }
    
    /// @notice 获取用户抵押数量 - 免费查询接口
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @dev 0 gas，快速查询
    function getUserCollateral(address user, address asset) external view 
        returns (uint256 collateral) {
        return _userCollateral[user][asset];
    }
    
    /// @notice 获取用户债务数量 - 免费查询接口
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return debt 债务数量
    /// @dev 0 gas，快速查询
    function getUserDebt(address user, address asset) external view 
        returns (uint256 debt) {
        return _userDebt[user][asset];
    }
    
    /// @notice 检查用户缓存是否有效 - 免费查询接口
    /// @param user 用户地址
    /// @return isValid 缓存是否有效
    /// @dev 0 gas，快速查询
    function isUserCacheValid(address user) external view returns (bool isValid) {
        return (block.timestamp - _cacheTimestamps[user]) < CACHE_DURATION;
    }
    
    // 移除直接计算器读取；健康因子建议从 HealthView 读取
    
    /// @notice 获取资产价格 - 免费查询接口
    /// @param asset 资产地址
    /// @return price 资产价格
    /// @dev 0 gas，快速查询
    function getAssetPrice(address asset) external view returns (uint256 price) {
        address oracle = _getCachedPriceOracle();
        if (oracle == address(0)) {
            return 0; // 如果预言机未设置，返回0
        }
        (price,,) = IPriceOracle(oracle).getPrice(asset);
    }
    
    /// @notice 批量获取用户位置 - 免费查询接口
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return positions 用户位置数组
    /// @dev 0 gas，批量快速查询
    function batchGetUserPositions(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (UserPosition[] memory positions) {
        require(users.length == assets.length, "Arrays length mismatch");
        
        uint256 length = users.length;
        positions = new UserPosition[](length);
        
        for (uint256 i = 0; i < length; i++) {
            positions[i] = UserPosition({
                user: users[i],
                asset: assets[i],
                collateral: _userCollateral[users[i]][assets[i]],
                debt: _userDebt[users[i]][assets[i]]
            });
        }
    }
    
    /// @notice 批量获取用户健康因子 - 免费查询接口
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    /// @dev 0 gas，批量快速查询
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external pure returns (uint256[] memory healthFactors) {
        uint256 length = users.length;
        healthFactors = new uint256[](length);
        // 与架构指南一致：健康因子由 HealthView 维护；这里返回占位 0，仅保持接口兼容
        for (uint256 i = 0; i < length; i++) {
            healthFactors[i] = 0;
        }
    }
    
    /// @notice 批量获取资产价格 - 免费查询接口
    /// @param assets 资产地址数组
    /// @return prices 价格数组
    /// @dev 0 gas，批量快速查询
    function batchGetAssetPrices(
        address[] calldata assets
    ) external view returns (uint256[] memory prices) {
        uint256 length = assets.length;
        prices = new uint256[](length);
        
        address oracle = _getCachedPriceOracle();
        
        for (uint256 i = 0; i < length; i++) {
            if (oracle == address(0)) {
                prices[i] = 0;
            } else {
                (uint256 p,,) = IPriceOracle(oracle).getPrice(assets[i]);
                prices[i] = p;
            }
        }
    }
    
    /*━━━━━━━━━━━━━━━ 缓存管理功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 清除过期缓存 - 缓存管理功能
    /// @param user 用户地址
    /// @dev 清除指定用户的过期缓存数据
    function clearExpiredCache(address user) external onlyAdmin {
        if (_cacheTimestamps[user] > 0 && 
            (block.timestamp - _cacheTimestamps[user]) > CACHE_DURATION) {
            
            // 清除用户缓存数据
            // 注意：不能直接删除整个 mapping，只能删除时间戳
            // 实际的抵押和债务数据会在下次操作时被覆盖
            delete _cacheTimestamps[user];
            
            // 更新统计
            if (_totalCachedUsers > 0) {
                _totalCachedUsers--;
            }
            _updateValidCacheCount();
            
            emit CacheCleared(user, block.timestamp);

            // 统一数据推送：缓存清理
            DataPushLibrary._emitData(
                keccak256("CACHE_CLEARED"),
                abi.encode(user, block.timestamp)
            );
        }
    }
    
    /// @notice 获取缓存统计信息 - 缓存管理功能
    /// @return totalUsers 总缓存用户数
    /// @return validCaches 有效缓存数
    /// @return cacheDuration 缓存有效期
    /// @return moduleCacheTimestamp 模块缓存时间戳
    /// @dev 0 gas，快速查询
    function getCacheStats() external view returns (
        uint256 totalUsers,
        uint256 validCaches,
        uint256 cacheDuration,
        uint256 moduleCacheTimestamp
    ) {
        // 返回当前统计信息（部分为只读常量）
        return (_totalCachedUsers, _validCachedUsers, CACHE_DURATION, _moduleCacheTimestamp);
    }
    
    /// @notice 检查模块缓存是否有效
    /// @return isValid 模块缓存是否有效
    /// @dev 0 gas，快速查询
    function isModuleCacheValid() external view returns (bool isValid) {
        return (block.timestamp - _moduleCacheTimestamp) < MODULE_CACHE_DURATION;
    }
    
    /*━━━━━━━━━━━━━━━ 系统状态查询 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取总抵押数量 - 免费查询接口
    /// @param asset 资产地址
    /// @return totalCollateral 总抵押数量
    /// @dev 0 gas，快速查询
    function getTotalCollateral(address asset) external view returns (uint256 totalCollateral) {
        address collateralManager = _getCachedCollateralManager();
        return ICollateralManager(collateralManager).getTotalCollateralByAsset(asset);
    }
    
    /// @notice 获取总债务数量 - 免费查询接口
    /// @param asset 资产地址
    /// @return totalDebt 总债务数量
    /// @dev 0 gas，快速查询
    function getTotalDebt(address asset) external view returns (uint256 totalDebt) {
        address lendingEngine = _getCachedLendingEngine();
        return ILendingEngineBasic(lendingEngine).getTotalDebtByAsset(asset);
    }
    
    /*━━━━━━━━━━━━━━━ 事件定义（事件驱动架构）━━━━━━━━━━━━━━━*/
    
    /// @notice 用户操作事件
    /// @param user 用户地址
    /// @param operationType 操作类型
    /// @param asset 资产地址
    /// @param amount 操作金额
    /// @param timestamp 时间戳
    event UserOperation(
        address indexed user,
        bytes32 indexed operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 用户位置更新事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param collateral 抵押数量
    /// @param debt 债务数量
    /// @param timestamp 时间戳
    event UserPositionUpdated(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint256 timestamp
    );
    
    /// @notice 系统状态更新事件
    /// @param asset 资产地址
    /// @param totalCollateral 总抵押数量
    /// @param totalDebt 总债务数量
    /// @param timestamp 时间戳
    event SystemStateUpdated(
        address indexed asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 timestamp
    );
    
    /// @notice 模块缓存刷新事件
    /// @param timestamp 时间戳
    event ModuleCacheRefreshed(uint256 timestamp);
    
    /// @notice 缓存清除事件
    /// @param user 用户地址
    /// @param timestamp 时间戳
    event CacheCleared(address indexed user, uint256 timestamp);
    
    /*━━━━━━━━━━━━━━━ 结构体定义 ━━━━━━━━━━━━━━━*/
    
    /// @notice 用户位置结构体
    struct UserPosition {
        address user;
        address asset;
        uint256 collateral;
        uint256 debt;
    }
    
    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级授权函数
    /// @param newImplementation 新实现地址
    function _authorizeUpgrade(address newImplementation) internal view override {
        address acmAddr = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender), "Not authorized");
        
        // 确保新实现地址不为零
        if (newImplementation == address(0)) revert VaultView__ZeroAddress();
    }
}
