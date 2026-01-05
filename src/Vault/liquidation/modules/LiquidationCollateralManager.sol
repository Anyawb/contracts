// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { RegistryQuery } from "../../../registry/RegistryQueryLibrary.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ZeroAddress, AmountIsZero, InsufficientCollateral } from "../../../errors/StandardErrors.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";
import { IRegistryDynamicModuleKey } from "../../../interfaces/IRegistryDynamicModuleKey.sol";
import { ILiquidationCollateralManager } from "../../../interfaces/ILiquidationCollateralManager.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";

/// @title LiquidationCollateralManager - 超精简版
/// @notice 清算抵押物管理器 - 专注核心清算逻辑，查询功能委托给View合约
/// @dev 重构后版本：从1306行精简到约400行，通过Registry和View合约复用功能
abstract contract LiquidationCollateralManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationCollateralManager
{
    using SafeERC20 for IERC20;

    // ============ Storage ============
    address private _registryAddr;
    address private _accessController;
    
    /// @notice 用户清算记录：user → asset → record
    mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) private _userLiquidationRecords;
    
    /// @notice 用户总清算金额：user → totalAmount
    mapping(address => uint256) private _userTotalLiquidationAmount;
    
    /// @notice 清算人抵押物统计：liquidator → asset → amount
    mapping(address => mapping(address => uint256)) private _liquidatorCollateralStats;
    
    /// @notice 价格预言机地址
    address private _priceOracleAddr;
    
    /// @notice 结算币地址
    address private _settlementTokenAddr;

    /// @dev Storage gap for future upgrades
    uint256[45] private __gap;

    // ============ Events ============
    /// @notice 清算抵押物转移事件
    event LiquidationCollateralTransferred(
        address indexed asset,
        uint256 amount,
        address indexed liquidator,
        uint256 timestamp
    );
    
    /// @notice 清算记录清除事件
    event LiquidationRecordCleared(
        address indexed user,
        address indexed asset,
        uint256 timestamp
    );
    
    /// @notice 价格预言机更新事件
    event PriceOracleUpdated(address indexed oldOracle, address indexed newOracle);
    
    /// @notice 结算币更新事件
    event SettlementTokenUpdated(address indexed oldToken, address indexed newToken);
    
    /// @notice 优雅降级事件
    event LiquidationGracefulDegradation(address indexed asset, string reason, uint256 fallbackValue, bool usedFallback);

    // ============ Modifiers ============
    modifier onlyAuthorized() {
        require(msg.sender == _accessController, "Not authorized");
        _;
    }
    
    modifier onlyValidRegistry() {
        require(_registryAddr != address(0), "Registry not set");
        _;
    }

    // ============ Constructor ============
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    function initialize(address initialRegistryAddr, address initialAccessController) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        require(initialRegistryAddr != address(0), "Invalid registry");
        require(initialAccessController != address(0), "Invalid access controller");
        
        _registryAddr = initialRegistryAddr;
        _accessController = initialAccessController;
        
        // 通过Registry获取初始配置
        _priceOracleAddr = RegistryQuery.getModule(ModuleKeys.KEY_PRICE_ORACLE);
        _settlementTokenAddr = RegistryQuery.getModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ============ 核心清算功能 (保留) ============
    
    /// @notice 转移清算抵押物
    /// @param asset 资产地址
    /// @param amount 转移数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external override onlyValidRegistry whenNotPaused nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (liquidator == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        
        // 检查清算人是否有足够的抵押物
        uint256 availableAmount = _getAvailableCollateralForLiquidation(liquidator, asset);
        if (availableAmount < amount) revert InsufficientCollateral();
        
        // 转移抵押物
        _transferCollateralToLiquidator(asset, amount, liquidator);
        
        // 更新清算人统计
        _liquidatorCollateralStats[liquidator][asset] += amount;
        
        emit LiquidationCollateralTransferred(asset, amount, liquidator, block.timestamp);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 清除用户清算抵押物记录
    /// @param user 用户地址
    /// @param asset 资产地址
    function clearLiquidationCollateralRecord(address user, address asset) external override onlyValidRegistry {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        
        LiquidationTypes.LiquidationRecord storage record = _userLiquidationRecords[user][asset];
        uint256 seizedAmount = record.amount;
        
        // 清除记录
        delete _userLiquidationRecords[user][asset];
        _userTotalLiquidationAmount[user] -= seizedAmount;
        
        emit LiquidationRecordCleared(user, asset, block.timestamp);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );
    }

    // ============ 基础查询功能 (保留) ============
    
    /// @notice 获取用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address user, address asset) external view override returns (uint256 seizableAmount) {
        if (user == address(0) || asset == address(0)) return 0;
        
        // 获取用户在该资产的抵押物数量
        address collateralManager = RegistryQuery.getModule(ModuleKeys.KEY_CM);
        if (collateralManager == address(0)) return 0;
        
        try ICollateralManager(collateralManager).getCollateral(user, asset) returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }

    /// @notice 计算抵押物价值
    /// @param asset 资产地址
    /// @param amount 数量
    /// @return value 价值
    function calculateCollateralValue(address asset, uint256 amount) external view override returns (uint256 value) {
        if (asset == address(0) || amount == 0) return 0;
        
        // 使用优雅降级获取资产价值
        address priceOracle = RegistryQuery.getModule(ModuleKeys.KEY_PRICE_ORACLE);
        if (priceOracle == address(0)) return 0;
        
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_settlementTokenAddr);
        
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
        
        // 注意：view 函数不能发出事件，所以移除 emit 语句
        // 如果需要记录优雅降级事件，应该在调用此函数的非 view 函数中处理
        
        return result.value;
    }

    /// @notice 计算抵押物价值并记录优雅降级事件（非 view 版本）
    /// @param asset 资产地址
    /// @param amount 数量
    /// @return value 价值
    function calculateCollateralValueWithEvents(address asset, uint256 amount) external returns (uint256 value) {
        if (asset == address(0) || amount == 0) return 0;
        
        // 使用优雅降级获取资产价值
        address priceOracle = RegistryQuery.getModule(ModuleKeys.KEY_PRICE_ORACLE);
        if (priceOracle == address(0)) return 0;
        
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_settlementTokenAddr);
        
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
        
        if (result.usedFallback) {
            emit LiquidationGracefulDegradation(asset, result.reason, result.value, true);
        }
        
        return result.value;
    }

    /// @notice 获取用户清算抵押物记录
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizedAmount 已扣押数量
    /// @return lastSeizedTime 最后扣押时间
    function getLiquidationCollateralRecord(
        address user,
        address asset
    ) external view override returns (uint256 seizedAmount, uint256 lastSeizedTime) {
        LiquidationTypes.LiquidationRecord memory record = _userLiquidationRecords[user][asset];
        return (record.amount, record.timestamp);
    }

    // ============ 管理功能 (保留) ============
    
    /// @notice 更新价格预言机
    /// @param newPriceOracle 新的价格预言机地址
    function updatePriceOracle(address newPriceOracle) external override onlyAuthorized {
        if (newPriceOracle == address(0)) revert ZeroAddress();
        
        address oldOracle = _priceOracleAddr;
        _priceOracleAddr = newPriceOracle;
        
        emit PriceOracleUpdated(oldOracle, newPriceOracle);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新结算币
    /// @param newSettlementToken 新的结算币地址
    function updateSettlementToken(address newSettlementToken) external override onlyAuthorized {
        if (newSettlementToken == address(0)) revert ZeroAddress();
        
        address oldToken = _settlementTokenAddr;
        _settlementTokenAddr = newSettlementToken;
        
        emit SettlementTokenUpdated(oldToken, newSettlementToken);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 获取价格预言机地址
    /// @return priceOracle 价格预言机地址
    function getPriceOracle() external view override returns (address priceOracle) {
        return _priceOracleAddr;
    }

    /// @notice 获取结算币地址
    /// @return settlementToken 结算币地址
    function getSettlementToken() external view override returns (address settlementToken) {
        return _settlementTokenAddr;
    }

    // ============ Registry 调用接口 ============
    
    /// @notice 通过Registry注册动态模块键
    function registerDynamicModuleKey(string memory name) external virtual onlyAuthorized {
        address dynamicRegistry = RegistryQuery.getModule(ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY);
        require(dynamicRegistry != address(0), "Dynamic registry not found");
        
        IRegistryDynamicModuleKey(dynamicRegistry).registerModuleKey(name);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 通过Registry注销动态模块键
    function unregisterDynamicModuleKey(bytes32 moduleKey) external onlyAuthorized {
        address dynamicRegistry = RegistryQuery.getModule(ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY);
        require(dynamicRegistry != address(0), "Dynamic registry not found");
        
        IRegistryDynamicModuleKey(dynamicRegistry).unregisterModuleKey(moduleKey);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 通过Registry安排模块升级
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyAuthorized {
        IRegistry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 通过Registry执行模块升级
    function executeModuleUpgrade(bytes32 moduleKey) external onlyAuthorized {
        IRegistry(_registryAddr).executeModuleUpgrade(moduleKey);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 通过Registry取消模块升级
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyAuthorized {
        IRegistry(_registryAddr).cancelModuleUpgrade(moduleKey);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    // ============ 紧急功能 ============
    
    /// @notice 紧急暂停
    function emergencyPause() external onlyAuthorized {
        _pause();
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 紧急恢复
    function emergencyUnpause() external onlyAuthorized {
        _unpause();
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 设置访问控制器
    /// @param controllerAddr 控制器地址
    function setAccessController(address controllerAddr) external onlyAuthorized {
        require(controllerAddr != address(0), "Invalid controller");
        _accessController = controllerAddr;
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ============ Internal Functions ============
    
    /// @notice 获取清算人可用抵押物数量
    /// @param liquidator 清算人地址
    /// @param asset 资产地址
    /// @return availableAmount 可用数量
    function _getAvailableCollateralForLiquidation(address liquidator, address asset) internal view returns (uint256 availableAmount) {
        address collateralManager = RegistryQuery.getModule(ModuleKeys.KEY_CM);
        if (collateralManager == address(0)) return 0;
        
        try ICollateralManager(collateralManager).getCollateral(liquidator, asset) returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }
    
    /// @notice 转移抵押物给清算人
    /// @param asset 资产地址
    /// @param amount 数量
    /// @param liquidator 清算人地址
    function _transferCollateralToLiquidator(address asset, uint256 amount, address liquidator) internal {
        // 实际转移由 CollateralManager 执行：从本模块临时托管/用户仓位提取并转给清算人
        address collateralManager = RegistryQuery.getModule(ModuleKeys.KEY_CM);
        if (collateralManager == address(0)) return;
        // 优先尝试从本模块名义账户向清算人转移（根据系统设计调整来源账户）
        try ICollateralManager(collateralManager).withdrawCollateral(liquidator, asset, amount) {
            // 转移成功则返回
            return;
        } catch {
            // 若直接向清算人名义提取失败，可根据业务需要改为从被清算用户转出并二段转移
        }
    }
    
    /// @notice UUPS升级授权函数
    function _authorizeUpgrade(address newImplementation) internal override onlyAuthorized {
        require(newImplementation != address(0), "Invalid implementation");
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }
} 