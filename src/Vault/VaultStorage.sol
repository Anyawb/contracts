// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ZeroAddress, ExternalModuleRevertedRaw } from "../errors/StandardErrors.sol";
import { VaultTypes } from "./VaultTypes.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { GracefulDegradation } from "../libraries/GracefulDegradation.sol";

/* ----------------------------------------------------------
*  Minimal external interface
* ---------------------------------------------------------*/
/// @dev Minimal interface to query the current minimum health factor from the risk module.
import { ILiquidationRiskManager } from "../interfaces/ILiquidationRiskManager.sol";

/* ----------------------------------------------------------
*  Constants
* ---------------------------------------------------------*/
/// @dev Default minimum health factor (110%) expressed in basis points. Used as a safe fallback.
uint256 constant DEFAULT_MIN_HF_BPS = 11_000;

/// @dev Minimum valid health factor (100%) in basis points
uint256 constant MIN_VALID_HF_BPS = 10_000;

/// @dev Maximum valid LTV (100%) in basis points
uint256 constant MAX_VALID_LTV_BPS = 10_000;

/// @title VaultStorage
/// @notice 纯Registry系统存储合约，提供统一的模块管理和状态存储
/// @dev 完全使用Registry系统，不再保留任何兼容层代码
/// @dev 提供统一的模块访问接口和状态管理
/// @dev 使用ACM进行权限控制，确保系统安全性
/// @dev 支持升级功能，可升级实现合约
/// @dev 使用ActionKeys和ModuleKeys进行标准化管理
/// @dev 集成优雅降级机制，处理模块调用失败
/// @dev 作为Registry系统的核心存储组件，提供统一的模块管理
/// @custom:security-contact security@example.com
contract VaultStorage is 
    Initializable,
    UUPSUpgradeable
{
    using GracefulDegradation for *;

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器，防止直接调用
    constructor() {
        _disableInitializers();
    }

    /* ============ Storage ============ */
    /// @notice Registry合约地址
    address private _registryAddr;

    /// @notice 底层RWA Token地址
    IERC20 private _rwaTokenAddr;
    
    /// @notice 结算Token地址
    IERC20 private _settlementTokenAddr;

    /// @notice 清算奖励比例（基点），例如 1000 = 10%
    uint256 private _liquidationBonus;
    
    /// @notice 是否为 RWA（Real World Asset）金库，影响资产分类和风险控制
    bool private _isRWA;

    /// @notice Vault最大抵押物容量
    uint256 private _vaultCap;

    /// @notice 允许的最大贷款价值比（基点），例如 8500 = 85%
    uint256 private _allowedLTV;

    /* ============ Events ============ */
    /// @notice Registry地址更新事件
    /// @param oldRegistry 旧Registry地址
    /// @param newRegistry 新Registry地址
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    /// @notice 清算奖励更新事件
    /// @param oldBonus 旧清算奖励
    /// @param newBonus 新清算奖励
    event LiquidationBonusUpdated(uint256 oldBonus, uint256 newBonus);
    
    /// @notice RWA 状态更新事件
    /// @param oldIsRWA 旧 RWA 状态
    /// @param newIsRWA 新 RWA 状态
    event RWAStatusUpdated(bool oldIsRWA, bool newIsRWA);

    /// @notice 优雅降级事件 - 模块调用失败时使用备用策略
    /// @param module 模块地址
    /// @param reason 降级原因
    /// @param fallbackValue 备用值
    /// @param usedFallback 是否使用了降级策略
    event VaultStorageGracefulDegradation(address indexed module, string reason, uint256 fallbackValue, bool usedFallback);
    
    /// @notice 模块健康状态事件
    /// @param module 模块地址
    /// @param isHealthy 是否健康
    /// @param details 详细信息
    event VaultStorageModuleHealthCheck(address indexed module, bool isHealthy, string details);

    /* ============ Modifiers ============ */
    /// @notice 仅限有效Registry调用
    /// @dev 确保registryAddr不为零地址
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 权限验证内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        if (acmAddr == address(0)) revert ZeroAddress();
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /// @notice 优雅降级：当模块调用失败时使用备用策略
    /// @param module 模块地址
    /// @param reason 失败原因
    /// @param config 降级配置
    /// @return fallbackValue 备用值
    function _gracefulDegradation(
        address module, 
        string memory reason,
        GracefulDegradation.DegradationConfig memory config
    ) internal returns (uint256 fallbackValue) {
        // 使用GracefulDegradation库的默认策略
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(module, module, 0, config);
        
        fallbackValue = result.value;
        
        // 记录降级事件
        emit VaultStorageGracefulDegradation(module, reason, fallbackValue, true);
        
        return fallbackValue;
    }
    
    /// @notice 检查模块健康状态
    /// @param module 模块地址
    /// @param moduleName 模块名称
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function _checkModuleHealth(address module, string memory moduleName) internal view returns (bool isHealthy, string memory details) {
        if (module == address(0)) {
            return (false, string(abi.encodePacked("Module not configured: ", moduleName)));
        }
        
        // 检查模块是否有代码
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(module)
        }
        
        if (codeSize == 0) {
            return (false, string(abi.encodePacked("Module has no code: ", moduleName)));
        }
        
        return (true, string(abi.encodePacked("Module is healthy: ", moduleName)));
    }

    /* ============ Initializer ============ */
    /// @notice 初始化VaultStorage合约（纯Registry系统）
    /// @dev 设置Registry地址和基础配置
    /// @param initialRegistry Registry合约地址
    /// @param initialRwaToken RWA Token地址
    /// @param initialSettlementToken 结算Token地址
    /// @custom:security 确保所有地址参数不为零地址
    function initialize(
        address initialRegistry,
        address initialRwaToken,
        address initialSettlementToken
    ) external initializer {
        if (initialRegistry == address(0)) revert ZeroAddress();
        if (initialRwaToken == address(0)) revert ZeroAddress();
        if (initialSettlementToken == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();
        
        _registryAddr = initialRegistry;
        _rwaTokenAddr = IERC20(initialRwaToken);
        _settlementTokenAddr = IERC20(initialSettlementToken);
    }

    /* ============ Getters ============ */
    /// @notice 获取当前最小健康因子阈值
    /// @dev 改为从清算风险管理器读取，移除对 HealthFactorCalculator 的依赖
    /// @dev 使用优雅降级机制处理模块调用失败
    /// @return hf 最小健康因子（基点）
    function getMinHealthFactor() external view onlyValidRegistry returns (uint256 hf) {
        address lrm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (lrm == address(0)) {
            return DEFAULT_MIN_HF_BPS;
        }

        try ILiquidationRiskManager(lrm).getMinHealthFactor() returns (uint256 result) {
            if (result < MIN_VALID_HF_BPS) {
                revert("InvalidHealthFactor");
            }
            return result;
        } catch {
            return DEFAULT_MIN_HF_BPS;
        }
    }

    /// @notice 获取模块地址（Registry系统标准化）
    /// @param moduleKey 模块Key（使用 ModuleKeys 常量）
    /// @return 模块地址
    function getModule(bytes32 moduleKey) external view onlyValidRegistry returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 获取Registry地址（仅管理员）
    /// @return Registry地址
    function getRegistry() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _registryAddr;
    }

    /// @notice 获取RWA Token地址（仅管理员）
    /// @return RWA Token地址
    function getRwaToken() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return address(_rwaTokenAddr);
    }

    /// @notice 获取结算Token地址（仅管理员）
    /// @return 结算Token地址
    function getSettlementTokenAddr() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return address(_settlementTokenAddr);
    }

    /// @notice 获取结算Token地址（别名，仅管理员）
    /// @return 结算Token地址
    function settlementToken() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return address(_settlementTokenAddr);
    }

    /// @notice 获取RWA Token地址（仅管理员）
    /// @return RWA Token地址
    function rwaToken() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return address(_rwaTokenAddr);
    }

    /// @notice 获取保证金管理模块地址
    /// @return 保证金管理模块地址
    function getGuaranteeFundManager() external view onlyValidRegistry returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
    }

    /// @notice 获取清算奖励比例（仅管理员）
    /// @return 清算奖励比例（基点）
    function getLiquidationBonus() external view onlyValidRegistry returns (uint256) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _liquidationBonus;
    }

    /// @notice 获取是否为RWA状态（仅管理员）
    /// @return 是否为RWA状态
    function getIsRWA() external view onlyValidRegistry returns (bool) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _isRWA;
    }

    /// @notice 获取Vault最大抵押物容量（仅管理员）
    /// @return Vault最大抵押物容量
    function getVaultCap() external view onlyValidRegistry returns (uint256) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _vaultCap;
    }

    /// @notice 获取允许的最大贷款价值比（仅管理员）
    /// @return 允许的最大贷款价值比（基点）
    function getAllowedLTV() external view onlyValidRegistry returns (uint256) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _allowedLTV;
    }

    /* ============ Admin Functions ============ */
    /// @notice 设置Registry地址
    /// @param newRegistry 新的Registry地址
    /// @dev 使用 ActionKeys.ACTION_SET_PARAMETER 进行事件记录
    function setRegistry(address newRegistry) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistry == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistry;
        emit RegistryUpdated(oldRegistry, newRegistry);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置清算奖励
    /// @param newBonus 新的清算奖励（基点）
    /// @dev 使用 ActionKeys.SET_PARAMETER 进行事件记录
    function setLiquidationBonus(uint256 newBonus) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        uint256 oldBonus = _liquidationBonus;
        _liquidationBonus = newBonus;
        emit LiquidationBonusUpdated(oldBonus, newBonus);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置RWA状态
    /// @param newIsRWA 新的RWA状态
    /// @dev 使用 ActionKeys.SET_PARAMETER 进行事件记录
    function setRWAStatus(bool newIsRWA) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        bool oldIsRWA = _isRWA;
        _isRWA = newIsRWA;
        emit RWAStatusUpdated(oldIsRWA, newIsRWA);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置Vault容量
    /// @param newCap 新的容量
    /// @dev 使用 ActionKeys.SET_PARAMETER 进行事件记录
    function setVaultCap(uint256 newCap) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        uint256 oldCap = _vaultCap;
        _vaultCap = newCap;
        emit VaultTypes.VaultCapUpdated(oldCap, newCap, block.timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置允许的LTV
    /// @param newLTV 新的LTV值（基点）
    /// @dev 使用 ActionKeys.SET_PARAMETER 进行事件记录
    function setAllowedLTV(uint256 newLTV) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        require(newLTV <= VaultTypes.MAX_LTV, "LTV too high");
        uint256 oldLTV = _allowedLTV;
        _allowedLTV = newLTV;
        emit VaultTypes.AllowedLTVUpdated(oldLTV, newLTV, block.timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Registry 升级函数 ============ */
    /// @notice 安排模块升级
    /// @param moduleKey 模块键
    /// @param newAddress 新模块地址
    /// @dev 使用 Registry 的延时升级机制
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newAddress == address(0)) revert ZeroAddress();
        
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 执行模块升级
    /// @param moduleKey 模块键
    /// @dev 使用 Registry 的延时升级机制
    function executeModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 取消模块升级
    /// @param moduleKey 模块键
    /// @dev 使用 Registry 的延时升级机制
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ 查询函数 ============ */
    /// @notice 检查模块是否已注册
    /// @param moduleKey 模块键
    /// @return 是否已注册
    function isModuleRegistered(bytes32 moduleKey) external view onlyValidRegistry returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /// @notice 获取待升级模块信息
    /// @param moduleKey 模块键
    /// @return newAddr 新地址
    /// @return executeAfter 执行时间
    /// @return hasPendingUpgrade 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view onlyValidRegistry returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    ) {
        return Registry(_registryAddr).getPendingUpgrade(moduleKey);
    }

    /// @notice 检查升级是否准备就绪
    /// @param moduleKey 模块键
    /// @return 是否准备就绪
    function isUpgradeReady(bytes32 moduleKey) external view onlyValidRegistry returns (bool) {
        return Registry(_registryAddr).isUpgradeReady(moduleKey);
    }

    /* ============ Upgrade Auth ============ */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        // 升级逻辑由 UUPSUpgradeable 处理
    }

    /* ---------- Storage Gap for Upgradeable Contracts ---------- */
    /// @dev 为可升级合约预留存储空间，防止存储布局冲突
    /// @notice 每次添加新状态变量时，需要减少相应的间隙大小
    /// @dev 设置为 50 以应对复杂的模块升级需求
    uint256[50] private __gap;
} 