// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { SystemEvents } from "../../SystemEvents.sol";
import { BatchTooLarge, EmptyArray, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @dev Local minimal interface used for health checks only.
 *      This avoids hard-coupling the view to a potentially larger oracle interface.
 */
interface IPriceOracleHealth {
    function checkPriceOracleHealth(address asset) external view returns (bool isHealthy, string memory details);
}

/**
 * @title ValuationOracleView
 * @notice Exposes read-only price-oracle queries for the Vault system.
 * @dev Reverts if:
 *      - registry address is zero (see {ZeroAddress})
 *      - registry address is not a contract (see {NotAContract})
 *      - caller lacks required read permissions (role-gated via {ViewAccessLib})
 *
 * Security:
 * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
 * - Upgrade authorization is role-gated (ACTION_UPGRADE_MODULE)
 */
contract ValuationOracleView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    string private constant _ORACLE_CALL_FAILED = "oracle call failed";

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @dev Registry contract address (private; exposed via getters for compatibility).
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when an upgrade implementation address is the zero address.
    error ValuationOracleView__ZeroImplementation();
    
    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /// @dev Ensures the Registry address is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }
    
    /// @dev Ensures the caller has the ACTION_VIEW_PRICE_DATA role in the Registry ACM.
    modifier onlyPriceViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_PRICE_DATA, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor ━━━━━━━━━━━━━━━*/
    /**
     * @dev Reverts if:
     *      - (never; constructor only disables initializers)
     *
     * Security:
     * - Prevents the implementation contract from being initialized directly
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /**
     * @notice Initializes the view module with the Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Initializer is single-use (OpenZeppelin Initializable)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ View (Registry) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the Registry address (preferred getter name).
     * @dev Reverts if:
     *      - (never; returns stored address even if unset)
     *
     * Security:
     * - Read-only
     *
     * @return Registry contract address
     */
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Returns the Registry address (legacy getter name).
     * @dev Reverts if:
     *      - (never; returns stored address even if unset)
     *
     * Security:
     * - Read-only
     *
     * @return Registry contract address
     */
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ View (Pricing) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the latest price and timestamp for a single asset.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle call: returns (0,0) if the oracle call fails
     *
     * @param asset Asset address
     * @return price Asset price (oracle-defined precision)
     * @return timestamp Oracle timestamp (seconds)
     */
    function getAssetPrice(
        address asset
    ) external view onlyValidRegistry onlyPriceViewer returns (uint256 price, uint256 timestamp) {
        address priceOracle = _priceOracle();

        try IPriceOracle(priceOracle).getPrice(asset) returns (uint256 p, uint256 ts, uint256) {
            return (p, ts);
        } catch {
            return (0, 0);
        }
    }

    /**
     * @notice Returns latest prices and timestamps for a batch of assets.
     * @dev Reverts if:
     *      - assets is empty (see {EmptyArray})
     *      - assets.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle call: returns zero-filled arrays if the oracle call fails
     *
     * @param assets Asset addresses
     * @return prices Asset prices (oracle-defined precision)
     * @return timestamps Oracle timestamps (seconds)
     */
    function getAssetPrices(
        address[] calldata assets
    )
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (uint256[] memory prices, uint256[] memory timestamps)
    {
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length > _MAX_BATCH_SIZE) revert BatchTooLarge(length, _MAX_BATCH_SIZE);

        prices = new uint256[](length);
        timestamps = new uint256[](length);

        address priceOracle = _priceOracle();
        try IPriceOracle(priceOracle).getPrices(assets) returns (
            uint256[] memory p,
            uint256[] memory ts,
            uint256[] memory
        ) {
            prices = p;
            timestamps = ts;
        } catch {
            // Best-effort fallback: keep default zero values.
            return (prices, timestamps);
        }
    }

    /**
     * @notice Returns whether the oracle considers the price for an asset valid.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle call: returns false if the oracle call fails
     *
     * @param asset Asset address
     * @return isValid True if oracle reports the price is valid
     */
    function isPriceValid(address asset) external view onlyValidRegistry onlyPriceViewer returns (bool isValid) {
        address priceOracle = _priceOracle();

        try IPriceOracle(priceOracle).isPriceValid(asset) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /*━━━━━━━━━━━━━━━ View (Oracle Health) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Checks the health status of the price oracle for a given asset.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle call: returns (false, "oracle call failed") if the oracle call fails
     *
     * @param asset Asset address
     * @return isHealthy True if the oracle reports healthy status for the asset
     * @return details Human-readable diagnostic details
     */
    function checkPriceOracleHealth(
        address asset
    ) external view onlyValidRegistry onlyPriceViewer returns (bool isHealthy, string memory details) {
        address priceOracle = _priceOracle();

        try IPriceOracleHealth(priceOracle).checkPriceOracleHealth(asset) returns (bool healthy, string memory info) {
            return (healthy, info);
        } catch {
            return (false, _ORACLE_CALL_FAILED);
        }
    }

    /*━━━━━━━━━━━━━━━ View (Oracle Health - Batch) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Checks the health status of the price oracle for a batch of assets.
     * @dev Reverts if:
     *      - assets is empty (see {EmptyArray})
     *      - assets.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle call: per-asset fallback to (false, "oracle call failed")
     *
     * @param assets Asset addresses
     * @return healthStatuses Per-asset health status
     * @return details Per-asset diagnostic details
     */
    function batchCheckPriceOracleHealth(
        address[] calldata assets
    ) external view onlyValidRegistry onlyPriceViewer returns (bool[] memory healthStatuses, string[] memory details) {
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length > _MAX_BATCH_SIZE) revert BatchTooLarge(length, _MAX_BATCH_SIZE);

        healthStatuses = new bool[](length);
        details = new string[](length);

        address priceOracle = _priceOracle();

        for (uint256 i = 0; i < length; ++i) {
            try IPriceOracleHealth(priceOracle).checkPriceOracleHealth(assets[i]) returns (
                bool healthy,
                string memory info
            ) {
                healthStatuses[i] = healthy;
                details[i] = info;
            } catch {
                healthStatuses[i] = false;
                details[i] = _ORACLE_CALL_FAILED;
            }
        }
    }

    /*━━━━━━━━━━━━━━━ Admin ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the Registry address (admin-gated).
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_ADMIN role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     *
     * @return Registry contract address
     */
    function getRegistry() external view onlyValidRegistry returns (address) {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        return _registryAddr;
    }

    /**
     * @notice Updates the Registry address used by this view module.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_ADMIN role (via {ViewAccessLib})
     *      - newRegistryAddr is zero (see {ZeroAddress})
     *      - newRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     *
     * @param newRegistryAddr New Registry contract address
     */
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0) revert NotAContract(newRegistryAddr);

        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;

        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
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
     * @return API version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version of this module's outputs.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Pure function
     *
     * @return Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns whether a user has permission to upgrade this module.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - Registry does not have KEY_ACCESS_CONTROL configured (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Read-only; consults the Registry ACM (ACTION_UPGRADE_MODULE)
     *
     * @param user User address to check
     * @return hasUpgradePermission True if user has ACTION_UPGRADE_MODULE role
     */
    function hasUpgradePermission(address user) external view onlyValidRegistry returns (bool) {
        // Check upgrade permission via the Registry ACM.
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, user);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    function _priceOracle() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgradeable ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorizes upgrades for the UUPS proxy.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_UPGRADE_MODULE role (via {ViewAccessLib})
     *      - newImplementation is zero (see {ValuationOracleView__ZeroImplementation})
     *      - newImplementation is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrades (ACTION_UPGRADE_MODULE)
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);

        if (newImplementation == address(0)) revert ValuationOracleView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap for future upgrades.
    uint256[50] private __gap;
}
