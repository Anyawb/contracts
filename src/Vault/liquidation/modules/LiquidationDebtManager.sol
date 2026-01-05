// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationAccessControl.sol";
import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/LiquidationViewLibrary.sol";
import "../libraries/ModuleCache.sol";
import "../libraries/LiquidationTokenLibrary.sol";
import "../libraries/LiquidationInterfaceLibrary.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPositionView } from "../../../interfaces/IPositionView.sol";

import "../../../interfaces/ILiquidationDebtManager.sol";
// 移除保证金管理器接口导入，专注于债务管理
// import "../../../interfaces/ILiquidationGuaranteeManager.sol";
// 移除奖励管理器接口导入，积分奖励功能已移至 LiquidationRewardManager
// import "../../../interfaces/IRewardManager.sol";
import "../../../interfaces/IPriceOracle.sol";
import "../../../interfaces/IAccessControlManager.sol";
import "../../../constants/ActionKeys.sol";
import "../../../constants/ModuleKeys.sol";
import "../../../errors/StandardErrors.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";

import "../types/LiquidationTypes.sol";
import "../types/LiquidationBase.sol";
import "../../VaultTypes.sol";

// 顶层最小接口：仅用于解析 VaultRouter 地址
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
}

/**
 * @title LiquidationDebtManager
 * @notice 清算债务管理器 - 专门负责清算债务的管理
 * @dev 该合约负责管理清算过程中的债务记录、债务减少等功能
 * @dev 保证金管理功能已移至 LiquidationGuaranteeManager
 * @dev 积分奖励功能已移至 LiquidationRewardManager
 * @dev 债务计算功能由借贷引擎处理，本合约专注于债务记录和统计
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 */
abstract contract LiquidationDebtManager is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable, 
    PausableUpgradeable,
    ILiquidationDebtManager,
    IRegistryUpgradeEvents 
{
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using LiquidationValidationLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationViewLibrary for *;
    using ModuleCache for ModuleCache.ModuleCacheStorage;
    using LiquidationTokenLibrary for *;
    using LiquidationInterfaceLibrary for *;

    /* ============ Constants ============ */
    uint256 public constant CACHE_MAX_AGE = 1 days;
    
    // 统一 DataPush 类型常量
    bytes32 internal constant DATA_TYPE_LIQUIDATION_DEBT_REDUCED = keccak256("LIQUIDATION_DEBT_REDUCED");
    bytes32 internal constant DATA_TYPE_LIQUIDATION_DEBT_BATCH_REDUCED = keccak256("LIQUIDATION_DEBT_BATCH_REDUCED");
    bytes32 internal constant DATA_TYPE_LIQUIDATION_DEBT_RECORD_UPDATED = keccak256("LIQUIDATION_DEBT_RECORD_UPDATED");

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理（私有存储）
    address private _registryAddr;

    /// @notice 基础存储 - 所有模块共享
    LiquidationBase.BaseStorage private _baseStorage;
    
    /// @notice 模块缓存 - 用于缓存模块地址
    ModuleCache.ModuleCacheStorage private _moduleCache;
    
    /// @notice 清算债务记录映射
    mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) private _userLiquidationDebtRecords;
    
    /// @notice 用户总清算债务数量
    mapping(address => uint256) private _userTotalLiquidationDebtAmount;
    
    /// @notice 清算人临时债务映射
    mapping(address => mapping(address => uint256)) private _liquidatorDebtTemp;

    /// @notice 缓存推送失败事件（用于链下重试与告警）
    /// @param user 目标用户
    /// @param asset 资产
    /// @param viewAddr 视图合约地址（可能为 0）
    /// @param collateral 本次尝试推送的抵押数值
    /// @param debt 本次尝试推送的债务数值
    /// @param reason 失败原因（原始 revert data，如有）
    event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason);

    /* ============ Events ============ */
    
    // 事件已在 ILiquidationDebtManager 接口中定义
    // Events are already defined in ILiquidationDebtManager interface

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器，防止直接调用
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

    /* ============ Custom Errors ============ */
    /// @dev 数组长度不匹配
    error LiquidationDebtManager__ArrayLengthMismatch(uint256 a, uint256 b);
    /// @dev 借贷引擎不可用
    error LiquidationDebtManager__LendingEngineUnavailable();
    /// @dev 可清算债务不足
    error LiquidationDebtManager__InsufficientDebt();
    /// @dev View 地址不可用
    error LiquidationDebtManager__ViewAddressUnavailable();

    /* ============ Internal helpers ============ */
    // 解析 VaultRouter 地址：通过 Registry 的 KEY_VAULT_CORE 再取 viewContractAddrVar()

    /// @dev Safe wrapper around module cache that returns zero on cache miss/expired; avoids bubbling ModuleCache errors.
    function _getModuleOrZero(bytes32 moduleKey) internal view returns (address) {
        // Direct internal call; swallow revert by catching any error.
        // try/catch works only on external calls, so use a low-level staticcall to self with the selector of getModule().
        (bool ok, bytes memory data) = address(this).staticcall(
            abi.encodeWithSelector(this.getModule.selector, moduleKey)
        );
        if (!ok || data.length < 32) {
            return address(0);
        }
        return abi.decode(data, (address));
    }

    function _resolveVaultCoreAddr() internal view returns (address forwarder) {
        forwarder = _getModuleOrZero(ModuleKeys.KEY_VAULT_CORE);
    }

    function _toInt(uint256 value) internal pure returns (int256) {
        require(value <= uint256(type(int256).max), "amount overflow");
        return int256(value);
    }

    function _pushUserPositionToView(
        address user,
        address asset,
        address /* lendingEngine */,
        address /* collateralManager */,
        int256 debtDelta
    ) internal {
        address forwarder = _resolveVaultCoreAddr();
        if (forwarder == address(0) || forwarder.code.length == 0) {
            emit CacheUpdateFailed(user, asset, forwarder, 0, 0, bytes("view unavailable"));
            return;
        }

        int256 collateralDelta = 0;

        uint64 nextVersion = _getNextVersion(user, asset);
        // 推送失败不再整体回滚，转为事件供链下重试
        try IVaultCoreMinimal(forwarder).pushUserPositionUpdateDelta(
            user,
            asset,
            collateralDelta,
            debtDelta,
            bytes32(0),
            0,
            nextVersion
        ) {
            // success
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, asset, forwarder, 0, 0, reason);
        }
    }

    /* ============ Modifiers ============ */
    
    /// @notice 仅限管理员权限
    modifier onlyAdmin() {
        // Admin semantics in liquidation modules are standardized as ACTION_SET_PARAMETER
        // (see `LiquidationBase.isAdmin`).
        require(LiquidationBase.isAdmin(_baseStorage.accessControl, msg.sender), "Insufficient permission");
        _;
    }
    
    /// @notice 仅限清算权限
    modifier onlyLiquidator() {
        require(LiquidationBase.hasRole(_baseStorage.accessControl, ActionKeys.ACTION_LIQUIDATE, msg.sender), "Insufficient permission");
        _;
    }

    /// @notice 仅限指定角色权限
    modifier onlyRole(bytes32 role) {
        require(LiquidationBase.hasRole(_baseStorage.accessControl, role, msg.sender), "Insufficient permission");
        _;
    }

    /* ============ Core Debt Management Functions ============ */
    
    /// @notice 减少用户债务（清算时）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 减少数量
    /// @param liquidator 清算人地址
    function reduceUserDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external whenNotPaused nonReentrant onlyLiquidator {
        LiquidationBase.validateAddress(user, "User");
        LiquidationBase.validateAddress(asset, "Asset");
        LiquidationBase.validateAddress(liquidator, "Liquidator");
        LiquidationBase.validateAmount(amount, "Amount");
        
        // 更新清算债务记录
        _updateLiquidationDebtRecord(user, asset, amount, liquidator);
        
        // 发出事件
        emit LiquidationDebtRecordUpdated(user, asset, 0, amount, block.timestamp);

        // DataPush
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_DEBT_RECORD_UPDATED,
            abi.encode(user, asset, uint256(0), amount, liquidator, block.timestamp)
        );
    }

    /// @notice 批量减少用户债务
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @param amounts 减少数量数组
    /// @param liquidator 清算人地址
    function batchReduceUserDebt(
        address[] calldata users,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external whenNotPaused nonReentrant onlyLiquidator {
        LiquidationBase.validateAddress(liquidator, "Liquidator");
        if (users.length != assets.length || users.length != amounts.length) {
            revert LiquidationDebtManager__ArrayLengthMismatch(users.length, assets.length);
        }
        
        uint256 length = users.length;
        for (uint256 i = 0; i < length;) {
            LiquidationBase.validateAddress(users[i], "User");
            LiquidationBase.validateAddress(assets[i], "Asset");
            LiquidationBase.validateAmount(amounts[i], "Amount");
            
            // 更新清算债务记录
            _updateLiquidationDebtRecord(users[i], assets[i], amounts[i], liquidator);
            
            // 发出事件
            emit LiquidationDebtRecordUpdated(users[i], assets[i], 0, amounts[i], block.timestamp);

            // DataPush（逐条）
            DataPushLibrary._emitData(
                DATA_TYPE_LIQUIDATION_DEBT_RECORD_UPDATED,
                abi.encode(users[i], assets[i], uint256(0), amounts[i], liquidator, block.timestamp)
            );
            
            unchecked { ++i; }
        }
    }

    /// @notice 减少用户债务（清算时）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 减少数量
    /// @param liquidator 清算人地址
    /// @return reducedAmount 实际减少数量
    function reduceDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external whenNotPaused nonReentrant onlyLiquidator returns (uint256 reducedAmount) {
        LiquidationBase.validateAddress(user, "User");
        LiquidationBase.validateAddress(asset, "Asset");
        LiquidationBase.validateAddress(liquidator, "Liquidator");
        LiquidationBase.validateAmount(amount, "Amount");
        
        // 获取模块地址
        address lendingEngine = _getModuleOrZero(ModuleKeys.KEY_LE);
        if (lendingEngine == address(0)) revert LiquidationDebtManager__LendingEngineUnavailable();
        address collateralManager = _getModuleOrZero(ModuleKeys.KEY_CM);

        // 计算可清算数量并执行强制减少
        uint256 reducible = 0;
        try ILendingEngineBasic(lendingEngine).getReducibleDebtAmount(user, asset) returns (uint256 r) { reducible = r; } catch { reducible = 0; }
        if (reducible == 0) revert LiquidationDebtManager__InsufficientDebt();
        reducedAmount = amount > reducible ? reducible : amount;
        ILendingEngineBasic(lendingEngine).forceReduceDebt(user, asset, reducedAmount);

        // 更新清算债务记录
        _updateLiquidationDebtRecord(user, asset, reducedAmount, liquidator);

        // 发出事件
        emit LiquidationDebtRecordUpdated(user, asset, 0, reducedAmount, block.timestamp);

        // DataPush 迁移至 View 层单点推送（此处仅保留领域事件，避免多点推送）

        // 推送至 View 缓存
        _pushUserPositionToView(user, asset, lendingEngine, collateralManager, -_toInt(reducedAmount));

        return reducedAmount;
    }

    /// @notice 批量减少债务
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 减少数量数组
    /// @param liquidator 清算人地址
    /// @return reducedAmounts 实际减少数量数组
    function batchReduceDebt(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external whenNotPaused nonReentrant onlyLiquidator returns (uint256[] memory reducedAmounts) {
        LiquidationBase.validateAddress(user, "User");
        LiquidationBase.validateAddress(liquidator, "Liquidator");
        if (assets.length != amounts.length) {
            revert LiquidationDebtManager__ArrayLengthMismatch(assets.length, amounts.length);
        }
        
        address lendingEngine = _getModuleOrZero(ModuleKeys.KEY_LE);
        if (lendingEngine == address(0)) revert LiquidationDebtManager__LendingEngineUnavailable();
        address collateralManager = _getModuleOrZero(ModuleKeys.KEY_CM);

        uint256 length = assets.length;
        reducedAmounts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            LiquidationBase.validateAddress(assets[i], "Asset");
            LiquidationBase.validateAmount(amounts[i], "Amount");

            uint256 reducible = 0;
            try ILendingEngineBasic(lendingEngine).getReducibleDebtAmount(user, assets[i]) returns (uint256 r) { reducible = r; } catch { reducible = 0; }
            if (reducible > 0) {
                uint256 actual = amounts[i] > reducible ? reducible : amounts[i];
                ILendingEngineBasic(lendingEngine).forceReduceDebt(user, assets[i], actual);

                _updateLiquidationDebtRecord(user, assets[i], actual, liquidator);
                emit LiquidationDebtRecordUpdated(user, assets[i], 0, actual, block.timestamp);

                // 单点 DataPush 由 View 层负责

                // 推送至 View 缓存
                _pushUserPositionToView(user, assets[i], lendingEngine, collateralManager, -_toInt(actual));

                reducedAmounts[i] = actual;
            }
            unchecked { ++i; }
        }

        // 批量 DataPush 由 View 层负责

        return reducedAmounts;
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
    ) external view returns (uint256 reducedAmount, uint256 lastReducedTime) {
        LiquidationBase.validateAddress(user, "User");
        LiquidationBase.validateAddress(asset, "Asset");

        LiquidationTypes.LiquidationRecord memory record = _userLiquidationDebtRecords[user][asset];
        return (record.amount, record.timestamp);
    }

    /// @notice 获取用户总清算债务数量
    /// @param user 用户地址
    /// @return totalAmount 总清算债务数量
    function getUserTotalLiquidationDebtAmount(address user) external view returns (uint256 totalAmount) {
        LiquidationBase.validateAddress(user, "User");
        return _userTotalLiquidationDebtAmount[user];
    }

    /// @notice 获取清算人临时债务数量
    /// @param liquidator 清算人地址
    /// @param asset 资产地址
    /// @return tempDebtAmount 临时债务数量
    function getLiquidatorTempDebt(address liquidator, address asset) external view returns (uint256 tempDebtAmount) {
        LiquidationBase.validateAddress(liquidator, "Liquidator");
        LiquidationBase.validateAddress(asset, "Asset");

        return _liquidatorDebtTemp[liquidator][asset];
    }

    /* ============ Admin Functions ============ */
    
    /// @notice 更新价格预言机地址
    /// @param newPriceOracle 新的价格预言机地址
    function updatePriceOracle(address newPriceOracle) external onlyAdmin {
        LiquidationBase.validateAddress(newPriceOracle, "PriceOracle");
        _baseStorage.priceOracleAddr = newPriceOracle;
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新结算币地址
    /// @param newSettlementToken 新的结算币地址
    function updateSettlementToken(address newSettlementToken) external onlyAdmin {
        LiquidationBase.validateAddress(newSettlementToken, "SettlementToken");
        _baseStorage.settlementTokenAddr = newSettlementToken;
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
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

    /// @notice 获取模块地址
    /// @param moduleKey 模块键值
    /// @return moduleAddress 模块地址
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
    }

    /// @notice 更新模块地址
    /// @param key 模块键值
    /// @param addr 模块地址
    function updateModule(bytes32 key, address addr) external onlyAdmin {
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /// @notice 移除模块地址
    /// @param key 模块键值
    function removeModule(bytes32 key) external onlyAdmin {
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /// @notice 批量更新模块地址
    /// @param keys 模块键值数组
    /// @param addresses 模块地址数组
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external onlyAdmin {
        if (keys.length != addresses.length) {
            revert("Array length mismatch");
        }
        
        uint256 length = keys.length;
        for (uint256 i = 0; i < length;) {
            ModuleCache.set(_moduleCache, keys[i], addresses[i], msg.sender);
            unchecked { ++i; }
        }
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 更新清算债务记录
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 清算数量
    /// @param liquidator 清算人地址
    function _updateLiquidationDebtRecord(address user, address asset, uint256 amount, address liquidator) internal {
        LiquidationTypes.LiquidationRecord storage record = _userLiquidationDebtRecords[user][asset];
        uint256 oldAmount = record.amount;
        uint256 newAmount = oldAmount + amount;
        
        // 批量更新记录以减少存储访问
        record.user = user;
        record.asset = asset;
        record.amount = newAmount;
        record.timestamp = block.timestamp;
        record.liquidator = liquidator;

        // 更新总清算数量
        _userTotalLiquidationDebtAmount[user] += amount;
    }

    /* ============ UUPS Functions ============ */
    
    /// @notice 授权升级
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newImplementation, "Implementation");
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

    /// @notice 计算 PositionView 的下一个 nextVersion（失败返回 0）
    function _getNextVersion(address user, address asset) internal view returns (uint64) {
        address positionView = _getModuleOrZero(ModuleKeys.KEY_POSITION_VIEW);
        if (positionView == address(0)) {
            return 0;
        }
        try IPositionView(positionView).getPositionVersion(user, asset) returns (uint64 version) {
            unchecked {
                return version + 1;
            }
        } catch {
            return 0;
        }
    }
} 