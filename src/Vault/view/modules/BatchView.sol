// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { DegradationStorage } from "../../../monitor/DegradationStorage.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

interface IHealthViewBatch {
    struct ModuleHealth {
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
    function getModuleHealth(address module) external view returns (ModuleHealth memory);
}

interface IRiskViewBatch {
    struct RiskAssessment {
        bool liquidatable;
        uint256 healthFactor;
        uint8 warningLevel;
    }

    function getUserRiskAssessment(address user) external view returns (RiskAssessment memory);
}

interface IDegradationMonitorView {
    function getSystemDegradationHistory(uint256 limit) external view returns (DegradationStorage.DegradationEvent[] memory);
}

/// @title BatchView
/// @notice 轻量级批量只读聚合器：聚合调用各 View 模块以减少 RPC 次数
contract BatchView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    address private _registryAddr;

    error BatchView__EmptyArray();
    error BatchView__BatchTooLarge(uint256 length, uint256 max);
    error BatchView__InvalidLimit();
    error BatchView__ZeroImplementation();

    // ======== Structs ========
    struct HealthFactorItem { address user; uint256 healthFactor; bool isValid; }
    struct RiskItem { address user; bool liquidatable; uint256 healthFactor; uint8 warningLevel; }
    struct AssetPriceItem { address asset; uint256 price; }
    struct ModuleHealthItem {
        address module;
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    // ======== Modifiers ========
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    modifier onlyViewRole(bytes32 actionKey) {
        address acm = _getACM();
        IAccessControlManager(acm).requireRole(actionKey, msg.sender);
        _;
    }

    // ======== Init ========
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ======== Batch helpers ========
    /// @notice 批量获取用户健康因子
    function batchGetHealthFactors(address[] calldata users)
        public
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (HealthFactorItem[] memory arr)
    {
        arr = _collectHealthFactors(users);
    }

    /// @notice 兼容旧版命名：批量获取用户健康因子
    function batchGetUserHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (HealthFactorItem[] memory arr)
    {
        arr = _collectHealthFactors(users);
    }

    /// @notice 批量获取风险评估（含可清算标记、健康因子、预警级别）
    function batchGetRiskAssessments(address[] calldata users)
        public
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (RiskItem[] memory arr)
    {
        arr = _collectRiskAssessments(users);
    }

    /// @notice 兼容旧版命名：批量获取风险评估
    function batchGetUserRiskAssessments(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (RiskItem[] memory arr)
    {
        arr = _collectRiskAssessments(users);
    }

    /// @notice 批量获取资产价格
    function batchGetAssetPrices(address[] calldata assets)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_PRICE_DATA)
        returns (AssetPriceItem[] memory arr)
    {
        uint256 len = assets.length;
        _validateLength(len, "BatchView: empty assets");

        IPriceOracle oracle = IPriceOracle(_getModule(ModuleKeys.KEY_PRICE_ORACLE));
        arr = new AssetPriceItem[](len);
        for (uint256 i; i < len; ++i) {
            uint256 price = _readAssetPrice(oracle, assets[i]);
            arr[i] = AssetPriceItem(assets[i], price);
        }
    }

    /// @notice 批量获取模块健康缓存
    function batchGetModuleHealth(address[] calldata modules)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS)
        returns (ModuleHealthItem[] memory arr)
    {
        uint256 len = modules.length;
        _validateLength(len, "BatchView: empty modules");

        IHealthViewBatch hv = _healthView();
        arr = new ModuleHealthItem[](len);
        for (uint256 i; i < len; ++i) {
            IHealthViewBatch.ModuleHealth memory mh = hv.getModuleHealth(modules[i]);
            arr[i] = ModuleHealthItem(modules[i], mh.isHealthy, mh.detailsHash, mh.lastCheckTime, mh.consecutiveFailures);
        }
    }

    /// @notice 批量获取系统降级历史（按时间倒序）
    function getDegradationHistory(uint256 limit)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS)
        returns (DegradationStorage.DegradationEvent[] memory history)
    {
        _validateLimit(limit);
        address monitorAddr = _getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (monitorAddr == address(0)) {
            return new DegradationStorage.DegradationEvent[](0);
        }

        history = IDegradationMonitorView(monitorAddr).getSystemDegradationHistory(limit);
    }

    // ======== Internal ========
    function _healthView() internal view returns (IHealthViewBatch) {
        return IHealthViewBatch(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
    }

    function _riskView() internal view returns (IRiskViewBatch) {
        return IRiskViewBatch(_getModule(ModuleKeys.KEY_RISK_VIEW));
    }

    function _collectHealthFactors(address[] calldata users) internal view returns (HealthFactorItem[] memory arr) {
        uint256 len = users.length;
        _validateLength(len, "BatchView: empty users");
        IHealthViewBatch hv = _healthView();
        arr = new HealthFactorItem[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 hf, bool ok) = hv.getUserHealthFactor(users[i]);
            arr[i] = HealthFactorItem(users[i], hf, ok);
        }
    }

    function _collectRiskAssessments(address[] calldata users) internal view returns (RiskItem[] memory arr) {
        uint256 len = users.length;
        _validateLength(len, "BatchView: empty users");
        IRiskViewBatch rv = _riskView();
        arr = new RiskItem[](len);
        for (uint256 i; i < len; ++i) {
            IRiskViewBatch.RiskAssessment memory a = rv.getUserRiskAssessment(users[i]);
            arr[i] = RiskItem(users[i], a.liquidatable, a.healthFactor, a.warningLevel);
        }
    }

    function _getModule(bytes32 key) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    function _getACM() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    function _readAssetPrice(IPriceOracle oracle, address asset) internal view returns (uint256 price) {
        try oracle.getPrice(asset) returns (uint256 p, uint256, uint256) {
            return p;
        } catch {
            return 0;
        }
    }

    function _validateLength(uint256 len, string memory /* emptyError */) internal pure {
        // keep `emptyError` for backwards compatible revert strings in callers if any,
        // but prefer standardized custom errors for new paths
        if (len == 0) revert BatchView__EmptyArray();
        if (len > MAX_BATCH_SIZE) revert BatchView__BatchTooLarge(len, MAX_BATCH_SIZE);
    }

    function _validateLimit(uint256 limit) internal pure {
        if (limit == 0) revert BatchView__InvalidLimit();
        if (limit > MAX_BATCH_SIZE) revert BatchView__BatchTooLarge(limit, MAX_BATCH_SIZE);
    }

    // ======== UUPS ========
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert BatchView__ZeroImplementation();
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}
    /// @notice 统一风格 getter（推荐）
    function registryAddrVar() external view returns(address){return _registryAddr;}

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
}