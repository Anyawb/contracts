// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ILiquidationRiskManager} from "../../../interfaces/ILiquidationRiskManager.sol";
import {LiquidationAccessControl} from "../libraries/LiquidationAccessControl.sol";
import {LiquidationTypes} from "../types/LiquidationTypes.sol";
import {LiquidationBase} from "../types/LiquidationBase.sol";
import {LiquidationRiskLib} from "../libraries/LiquidationRiskLib.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ZeroAddress} from "../../../errors/StandardErrors.sol";
 

import {ModuleCache} from "../libraries/ModuleCache.sol";
import {LiquidationViewLibrary} from "../libraries/LiquidationViewLibrary.sol";
import {LiquidationRiskQueryLib} from "../libraries/LiquidationRiskQueryLib.sol";
import { Registry } from "../../../registry/Registry.sol";

/// @dev Minimal HealthView interface (read-only cache).
interface IHealthViewLite {
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
}

/// @title LiquidationRiskManager - 清算风险管理器
/// @author RWA Lending Platform Team
/// @notice 只读清算风险管理器 - 提供用户清算风险评估、健康因子计算和缓存管理
/// @dev 遵循架构指南：风控只读/聚合，不参与写入操作
/// @dev 通过 Registry 系统动态解析模块地址（CM、LE、PriceOracle、SettlementToken）
/// @dev 使用模块缓存机制优化查询性能；健康因子读路径统一走 HealthView 缓存（SSOT）
/// @dev 使用 UUPS 可升级模式，通过 AccessControlManager 验证升级权限
contract LiquidationRiskManager is
    Initializable,
    UUPSUpgradeable,
    ILiquidationRiskManager
{
    using LiquidationBase for *;
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    // ============ 自定义错误 ============
    /// @notice 未授权访问错误
    error LiquidationRiskManager__UnauthorizedAccess();
    /// @notice 批量操作长度无效错误
    error LiquidationRiskManager__InvalidBatchLength();
    /// @notice 模块地址无效错误
    error LiquidationRiskManager__InvalidModuleAddress();
    /// @notice 阈值参数无效错误
    error LiquidationRiskManager__InvalidThreshold();
    /// @notice 健康因子计算失败错误
    error LiquidationRiskManager__HealthFactorCalculationFailed();
    /// @notice 模块调用失败错误
    error LiquidationRiskManager__ModuleCallFailed();
    /// @notice 返回数据不足错误
    error LiquidationRiskManager__InsufficientReturnData();
    /// @notice 批量大小无效错误
    error LiquidationRiskManager__InvalidBatchSize();
    /// @notice Registry未初始化错误
    error LiquidationRiskManager__RegistryNotInitialized();
    /// @notice 缺失必需模块地址
    /// @param key 模块键值
    error LiquidationRiskManager__MissingModule(bytes32 key);

    // ============ 常量 ============
    /// @notice 健康因子清算阈值（100%）
    uint256 public constant HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18;

    // ============ 状态变量 ============
    /// @notice 清算阈值（基点）
    uint256 public liquidationThresholdVar;
    /// @notice 最小健康因子（基点）
    uint256 public minHealthFactorVar;
    /// @notice 最大缓存持续时间（秒）
    uint256 public maxCacheDurationVar;
    /// @notice 最大批量操作大小
    uint256 public maxBatchSizeVar;

    /// @notice Registry地址 - 用于模块管理和地址解析
    address private _registryAddr;

    /// @notice 基础存储 - 包含权限控制和缓存管理
    LiquidationBase.BaseStorage private _baseStorage;

    /// @notice 模块缓存 - 用于缓存模块地址，优化查询性能
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /// @notice 清算积分存储 - 包含清算积分相关配置
    LiquidationBase.LiquidationRewardStorage internal liquidationRewardStorage;

    // ============ 事件定义 ============
    /// @notice 参数更新事件
    /// @param param 参数名称
    /// @param oldValue 旧值
    /// @param newValue 新值
    event ParameterUpdated(bytes32 param, uint256 oldValue, uint256 newValue);

    /// @dev 参数键：清算阈值
    bytes32 private constant PARAM_LIQUIDATION_THRESHOLD = keccak256("liquidationThreshold");
    /// @dev 参数键：最小健康因子
    bytes32 private constant PARAM_MIN_HEALTH_FACTOR = keccak256("minHealthFactor");

    // ============ 修饰符 ============
    /// @notice 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    /// @notice 管理员权限验证修饰符
    modifier onlyAdmin() {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _;
    }

    

    // ============ 构造函数与初始化 ============
    /// @dev 构造函数，禁用初始化器以防止直接调用
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialAccessControl 权限控制接口地址
    /// @param initialMaxCacheDuration 最大缓存持续时间（秒）
    /// @param initialMaxBatchSize 最大批量操作大小
    /// @dev 设置初始参数并预加载核心模块地址（CM、LE、PriceOracle、SettlementToken）
    function initialize(
        address initialRegistryAddr, 
        address initialAccessControl, 
        uint256 initialMaxCacheDuration, 
        uint256 initialMaxBatchSize
    ) public initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialAccessControl == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();

        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(_baseStorage.accessControl, initialAccessControl, initialAccessControl);
        liquidationThresholdVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        minHealthFactorVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        maxCacheDurationVar = initialMaxCacheDuration;
        maxBatchSizeVar = initialMaxBatchSize;

        // 初始化模块缓存
        ModuleCache.initialize(_moduleCache, false, address(this));
        _primeCoreModules();
    }

    /// @notice UUPS 升级授权函数
    /// @param newImplementation 新实现地址
    /// @dev 验证调用者具有升级权限，并验证新实现地址有效性
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }

    // ============ 核心模块解析（Registry + 缓存） ============

    /// @notice 读取并缓存模块地址；若缓存缺失或过期则从 Registry 获取
    /// @param key 模块键值
    /// @return moduleAddr 模块地址
    /// @dev 优先使用缓存，缓存过期时从 Registry 获取并更新缓存
    function _resolveModule(bytes32 key) internal returns (address moduleAddr) {
        moduleAddr = _moduleCache.moduleAddresses[key];
        uint256 ts = _moduleCache.cacheTimestamps[key];
        if (moduleAddr != address(0) && ts != 0 && block.timestamp - ts <= maxCacheDurationVar) {
            return moduleAddr;
        }

        moduleAddr = Registry(_registryAddr).getModule(key);
        if (moduleAddr == address(0)) revert LiquidationRiskManager__MissingModule(key);

        _moduleCache.moduleAddresses[key] = moduleAddr;
        _moduleCache.cacheTimestamps[key] = block.timestamp;
        return moduleAddr;
    }

    /// @notice 获取模块地址（只读视图函数）
    /// @param key 模块键值
    /// @return 模块地址
    /// @dev 优先返回缓存地址，若缓存为空则从 Registry 读取（不更新缓存）
    function _getModuleView(bytes32 key) internal view returns (address) {
        address cached = _moduleCache.moduleAddresses[key];
        if (cached != address(0)) return cached;
        return Registry(_registryAddr).getModule(key);
    }

    /// @notice 预加载核心模块地址
    /// @dev 在初始化或批量操作前调用，确保核心模块（CM、LE、HealthView）已缓存
    function _primeCoreModules() internal {
        _resolveModule(ModuleKeys.KEY_CM);
        _resolveModule(ModuleKeys.KEY_LE);
        _resolveModule(ModuleKeys.KEY_HEALTH_VIEW);
    }

    // ============ Registry 辅助函数（只读） ============

    /// @notice 从 Registry 读取模块地址
    /// @param key 模块键值
    /// @return 模块地址
    /// @dev 直接查询 Registry，不使用缓存
    function getModuleFromRegistry(bytes32 key) external view returns (address) {
        return Registry(_registryAddr).getModule(key);
    }

    /// @notice 判断模块是否已注册（地址非零）
    /// @param key 模块键值
    /// @return 是否已注册
    function isModuleRegistered(bytes32 key) external view returns (bool) {
        return Registry(_registryAddr).getModule(key) != address(0);
    }

    /// @notice 获取 Registry 地址（命名遵循架构规范）
    /// @return Registry 地址
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    // ============ 兼容性访问器（向后兼容） ============

    /// @notice 获取清算阈值（兼容旧版命名）
    /// @return 清算阈值（基点）
    function liquidationThreshold() external view returns (uint256) {
        return liquidationThresholdVar;
    }

    /// @notice 获取最小健康因子（兼容旧版命名）
    /// @return 最小健康因子（基点）
    function minHealthFactor() external view returns (uint256) {
        return minHealthFactorVar;
    }

    /// @notice 获取最大缓存时长（兼容旧版命名）
    /// @return 最大缓存时长（秒）
    function maxCacheDuration() external view returns (uint256) {
        return maxCacheDurationVar;
    }

    /// @notice 获取最大批量大小（兼容旧版命名）
    /// @return 最大批量大小
    function maxBatchSize() external view returns (uint256) {
        return maxBatchSizeVar;
    }

    /// @notice 获取 Registry 地址（兼容旧版命名）
    /// @return Registry 地址
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 获取 Registry 地址（首选接口）
    /// @return Registry 地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // NOTE: priceOracle / settlementToken getters removed from RiskManager.
    // Oracle health + valuation concerns belong to ValuationOracleView / LendingEngine.

    // ============ 风险评估核心功能 ============
    
    /// @notice 检查用户是否可清算
    /// @param user 用户地址
    /// @return 是否可清算
    /// @dev 基于用户当前健康因子判断
    function isLiquidatable(address user) external view override returns (bool) {
        if (user == address(0)) revert ZeroAddress();
        (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(user);
        if (!valid) return false; // safe fallback if cache is not valid
        return hf < liquidationThresholdVar;
    }

    /// @notice 检查指定参数下用户是否可清算
    /// @param user 用户地址
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @param asset 资产地址
    /// @return 是否可清算
    /// @dev 基于提供的参数计算健康因子
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view override returns (bool) {
        if (user == address(0) || asset == address(0)) revert ZeroAddress();
        uint256 hf = LiquidationRiskLib.calculateHealthFactor(collateral, debt);
        return hf < liquidationThresholdVar;
    }

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return 风险评分（0-100）
    /// @dev 基于用户当前抵押物和债务计算风险评分
    function getLiquidationRiskScore(address user) external view override returns (uint256) {
        if (user == address(0)) revert ZeroAddress();
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValues(
            user,
            _moduleCache,
            maxCacheDurationVar
        );
        return LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
    }

    /// @notice 计算清算风险评分
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @return 风险评分（0-100）
    /// @dev 基于 LTV 比率计算风险评分
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) public pure override returns (uint256) {
        return LiquidationRiskLib.calculateLiquidationRiskScore(collateral, debt);
    }

    // NOTE: Health factor read path is centralized in HealthView.
    // RiskManager no longer exposes getUserHealthFactor or health-factor cache APIs.

    /// @notice 批量检查用户是否可清算
    /// @param users 用户地址数组
    /// @return liquidatable 是否可清算数组
    /// @dev 批量查询用户清算状态，数组长度不能超过最大批量大小
    function batchIsLiquidatable(address[] calldata users) external view override returns (bool[] memory liquidatable) {
        uint256 length = users.length;
        if (length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchSize();
        liquidatable = new bool[](length);
        for (uint256 i = 0; i < length;) {
            address u = users[i];
            if (u != address(0)) {
                // reuse cached health factor via HealthView
                (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(u);
                liquidatable[i] = valid && hf < liquidationThresholdVar;
            }
            unchecked { ++i; }
        }
    }

    /// @notice 批量获取用户清算风险评分
    /// @param users 用户地址数组
    /// @return riskScores 风险评分数组（0-100）
    /// @dev 批量计算用户风险评分，使用模块缓存优化性能
    function batchGetLiquidationRiskScores(address[] calldata users) external view override returns (uint256[] memory riskScores) {
        return LiquidationViewLibrary.batchGetLiquidationRiskScores(users, _moduleCache);
    }

    /// @notice 获取用户完整的风险评估
    /// @param user 用户地址
    /// @return liquidatable 是否可清算
    /// @return riskScore 风险评分
    /// @return healthFactor 健康因子
    /// @return riskLevel 风险等级
    /// @return safetyMargin 安全边际
    /// @dev 返回用户风险的完整评估结果
    function getUserRiskAssessment(
        address user
    ) external view override returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    ) {
        if (user == address(0)) revert ZeroAddress();
        
        (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(user);
        healthFactor = valid ? hf : 0;
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValues(
            user,
            _moduleCache,
            maxCacheDurationVar
        );
        riskScore = LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
        riskLevel = LiquidationTypes.calculateRiskLevel(healthFactor);
        liquidatable = valid && healthFactor < liquidationThresholdVar;
        safetyMargin = LiquidationTypes.calculateSafetyMargin(healthFactor, liquidationThresholdVar);
    }

    // ============ 阈值管理功能 ============
    
    /// @notice 获取清算阈值
    /// @return 清算阈值（基点）
    function getLiquidationThreshold() external view override returns (uint256) {
        return liquidationThresholdVar;
    }

    /// @notice 更新清算阈值
    /// @param newThreshold 新的清算阈值（基点）
    /// @dev 仅管理员可调用，需验证阈值有效性，更新后发出参数更新事件
    function updateLiquidationThreshold(uint256 newThreshold) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!LiquidationTypes.isValidLiquidationThreshold(newThreshold)) revert LiquidationRiskManager__InvalidThreshold();
        
        uint256 oldThreshold = liquidationThresholdVar;
        liquidationThresholdVar = newThreshold;
        emit ParameterUpdated(PARAM_LIQUIDATION_THRESHOLD, oldThreshold, newThreshold);
    }

    /// @notice 获取最小健康因子
    /// @return 最小健康因子（基点）
    function getMinHealthFactor() external view override returns (uint256) {
        return minHealthFactorVar;
    }

    /// @notice 更新最小健康因子
    /// @param newMinHealthFactor 新的最小健康因子（基点）
    /// @dev 仅管理员可调用，需大于清算阈值，更新后发出参数更新事件
    function updateMinHealthFactor(uint256 newMinHealthFactor) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (newMinHealthFactor < liquidationThresholdVar) revert LiquidationRiskManager__InvalidThreshold();
        
        uint256 oldFactor = minHealthFactorVar;
        minHealthFactorVar = newMinHealthFactor;
        emit ParameterUpdated(PARAM_MIN_HEALTH_FACTOR, oldFactor, newMinHealthFactor);
    }

    // ============ Internal helpers ============
    function _getUserHealthFactorFromHealthView(address user) internal view returns (uint256 hf, bool valid) {
        address hv = _getModuleView(ModuleKeys.KEY_HEALTH_VIEW);
        if (hv == address(0)) revert LiquidationRiskManager__MissingModule(ModuleKeys.KEY_HEALTH_VIEW);
        return IHealthViewLite(hv).getUserHealthFactor(user);
    }
} 