// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { DegradationStorage } from "../../../monitor/DegradationStorage.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { BatchTooLarge, EmptyArray, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

interface IHealthViewBatch {
    // solhint-disable-next-line gas-struct-packing
    struct ModuleHealth {
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    function getUserHealthFactor(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 timestamp);
    function getModuleHealth(address module) external view returns (ModuleHealth memory);
}

interface IRiskViewBatch {
    // solhint-disable-next-line gas-struct-packing
    struct RiskAssessment {
        bool liquidatable;
        uint256 healthFactor;
        uint8 warningLevel;
    }

    function getUserRiskAssessment(address user) external view returns (RiskAssessment memory);
}

interface IDegradationMonitorView {
    function getSystemDegradationHistory(uint256 limit)
        external
        view
        returns (DegradationStorage.DegradationEvent[] memory);
}

/**
 * @title BatchView
 * @notice Lightweight batch read-only aggregator that reduces RPC calls by batching view-module reads.
 * @dev Reverts if:
 *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
 *      - caller lacks required view permissions for the requested scope (role-gated via ACM/ActionKeys)
 *      - batch inputs are invalid (see {EmptyArray}, {BatchTooLarge}, {BatchView__InvalidLimit})
 *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
 *
 * Security:
 * - Role-gated reads via AccessControlManager roles (ActionKeys)
 * - Upgrade authorization is role-gated (ACTION_ADMIN)
 */
contract BatchView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    error BatchView__InvalidLimit();
    error BatchView__ZeroImplementation();

    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/
    // Packed to reduce memory footprint:
    // - slot0: address (20) + bool (1)
    // - slot1: uint256
    struct HealthFactorItem { address user; bool isValid; uint256 healthFactor; }

    // Packed to reduce memory footprint:
    // - slot0: address (20) + bool (1) + uint8 (1)
    // - slot1: uint256
    struct RiskItem { address user; bool liquidatable; uint8 warningLevel; uint256 healthFactor; }
    struct AssetPriceItem { address asset; uint256 price; }
    struct ModuleHealthItem {
        address module;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
        bool    isHealthy;
        bytes32 detailsHash;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyViewRole(bytes32 actionKey) {
        address acm = _getACM();
        IAccessControlManager(acm).requireRole(actionKey, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Batch helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Batch-reads cached health factors for users from HealthView.
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via ACM)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @param users Target user addresses
     * @return arr Per-user health factor items (healthFactor/timestamp validity from HealthView)
     */
    function batchGetHealthFactors(address[] calldata users)
        public
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (HealthFactorItem[] memory arr)
    {
        arr = _collectHealthFactors(users);
    }

    /**
     * @notice Batch-reads cached health factors for users (legacy function name).
     * @dev Reverts if:
     *      - same as {batchGetHealthFactors}
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @param users Target user addresses
     * @return arr Per-user health factor items
     */
    function batchGetUserHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (HealthFactorItem[] memory arr)
    {
        arr = _collectHealthFactors(users);
    }

    /**
     * @notice Batch-reads risk assessments for users from RiskView.
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via ACM)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @param users Target user addresses
     * @return arr Per-user risk items
     */
    function batchGetRiskAssessments(address[] calldata users)
        public
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (RiskItem[] memory arr)
    {
        arr = _collectRiskAssessments(users);
    }

    /**
     * @notice Batch-reads risk assessments for users (legacy function name).
     * @dev Reverts if:
     *      - same as {batchGetRiskAssessments}
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @param users Target user addresses
     * @return arr Per-user risk items
     */
    function batchGetUserRiskAssessments(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyViewRole(ActionKeys.ACTION_VIEW_RISK_DATA)
        returns (RiskItem[] memory arr)
    {
        arr = _collectRiskAssessments(users);
    }

    /**
     * @notice Batch-reads asset prices from the PriceOracle.
     * @dev Reverts if:
     *      - assets is empty (see {EmptyArray})
     *      - assets.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA (via ACM)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle reads: returns price=0 if an oracle call fails for an asset
     *
     * @param assets Asset addresses
     * @return arr Per-asset price items (oracle-defined precision)
     */
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

    /**
     * @notice Batch-reads module health cache entries from HealthView.
     * @dev Reverts if:
     *      - modules is empty (see {EmptyArray})
     *      - modules.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_SYSTEM_STATUS (via ACM)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_SYSTEM_STATUS)
     *
     * @param modules Module addresses to query
     * @return arr Per-module health items
     */
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
            arr[i] = ModuleHealthItem(
                modules[i],
                mh.lastCheckTime,
                mh.consecutiveFailures,
                mh.isHealthy,
                mh.detailsHash
            );
        }
    }

    /**
     * @notice Returns the system degradation history (reverse chronological order) from the DegradationMonitor module.
     * @dev Reverts if:
     *      - limit is zero or exceeds the maximum batch size (see {BatchView__InvalidLimit}, {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_SYSTEM_STATUS (via ACM)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_SYSTEM_STATUS)
     * - Best-effort behavior: returns empty array if the degradation monitor module is not registered
     *
     * @param limit Max number of events to return
     * @return history Degradation events
     */
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

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    /**
     * @dev Resolves the HealthView module from Registry.
     *      Assumes callers have already validated the Registry via {onlyValidRegistry}.
     *      Reverts if Registry resolution fails (reverts in {Registry.getModuleOrRevert}).
     */
    function _healthView() internal view returns (IHealthViewBatch) {
        return IHealthViewBatch(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
    }

    /**
     * @dev Resolves the RiskView module from Registry.
     *      Assumes callers have already validated the Registry via {onlyValidRegistry}.
     *      Reverts if Registry resolution fails (reverts in {Registry.getModuleOrRevert}).
     */
    function _riskView() internal view returns (IRiskViewBatch) {
        return IRiskViewBatch(_getModule(ModuleKeys.KEY_RISK_VIEW));
    }

    /**
     * @dev Collects cached health factors for users from HealthView.
     *      Assumes callers have already enforced batch size and permissions.
     *      Reverts if:
     *      - users is empty or too large (see {_validateLength})
     *      - underlying HealthView call reverts
     */
    function _collectHealthFactors(address[] calldata users) internal view returns (HealthFactorItem[] memory arr) {
        uint256 len = users.length;
        _validateLength(len, "BatchView: empty users");
        IHealthViewBatch hv = _healthView();
        arr = new HealthFactorItem[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 hf, bool ok, ) = hv.getUserHealthFactor(users[i]);
            arr[i] = HealthFactorItem(users[i], ok, hf);
        }
    }

    /**
     * @dev Collects risk assessments for users from RiskView.
     *      Assumes callers have already enforced batch size and permissions.
     *      Reverts if:
     *      - users is empty or too large (see {_validateLength})
     *      - underlying RiskView call reverts
     */
    function _collectRiskAssessments(address[] calldata users) internal view returns (RiskItem[] memory arr) {
        uint256 len = users.length;
        _validateLength(len, "BatchView: empty users");
        IRiskViewBatch rv = _riskView();
        arr = new RiskItem[](len);
        for (uint256 i; i < len; ++i) {
            IRiskViewBatch.RiskAssessment memory a = rv.getUserRiskAssessment(users[i]);
            arr[i] = RiskItem(users[i], a.liquidatable, a.warningLevel, a.healthFactor);
        }
    }

    /**
     * @dev Resolves a module address from Registry.
     *      Assumes callers have already validated the Registry via {onlyValidRegistry}.
     *      Reverts if the module is not registered (reverts in {Registry.getModuleOrRevert}).
     */
    function _getModule(bytes32 key) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    /**
     * @dev Resolves the AccessControlManager address from Registry.
     *      Reverts if Registry resolution fails.
     */
    function _getACM() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    /**
     * @dev Best-effort price read from the PriceOracle.
     *      Returns 0 if the oracle call reverts.
     */
    function _readAssetPrice(IPriceOracle oracle, address asset) internal view returns (uint256 price) {
        try oracle.getPrice(asset) returns (uint256 p, uint256, uint256) {
            return p;
        } catch {
            return 0;
        }
    }

    /**
     * @dev Validates a batch length for this module.
     *      Reverts if:
     *      - len == 0 (see {EmptyArray})
     *      - len > _MAX_BATCH_SIZE (see {BatchTooLarge})
     */
    function _validateLength(uint256 len, string memory /* emptyError */) internal pure {
        // keep `emptyError` for backwards compatible revert strings in callers if any,
        // but prefer standardized custom errors for new paths
        if (len == 0) revert EmptyArray();
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
    }

    /**
     * @dev Validates a caller-provided limit parameter.
     *      Reverts if:
     *      - limit == 0 (see {BatchView__InvalidLimit})
     *      - limit > _MAX_BATCH_SIZE (see {BatchTooLarge})
     */
    function _validateLimit(uint256 limit) internal pure {
        if (limit == 0) revert BatchView__InvalidLimit();
        if (limit > _MAX_BATCH_SIZE) revert BatchTooLarge(limit, _MAX_BATCH_SIZE);
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgradeable ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorizes upgrades for the UUPS proxy.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_ADMIN (via {ViewAccessLib})
     *      - newImplementation is zero (see {BatchView__ZeroImplementation})
     *      - newImplementation is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrades (ACTION_ADMIN)
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert BatchView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ View (Registry) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the Registry address (legacy getter name).
     * @dev Reverts if:
     *      - (never; may return address(0) if not initialized)
     *
     * Security:
     * - Read-only
     *
     * @return registry Registry address
     */
    function registryAddr() external view returns (address registry) {
        return _registryAddr;
    }

    /**
     * @notice Returns the Registry address (preferred getter name).
     * @dev Reverts if:
     *      - (never; may return address(0) if not initialized)
     *
     * Security:
     * - Read-only
     *
     * @return registry Registry address
     */
    function registryAddrVar() external view returns (address registry) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the API version of this module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Pure function
     *
     * @return version API version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version of this module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Pure function
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap for future upgrades.
    uint256[50] private __gap;
}