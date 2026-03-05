// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";
import { SystemEvents } from "../../SystemEvents.sol";
import { BatchTooLarge, EmptyArray, MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

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
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_PRICE_DATA, msg.sender)) {
            revert MissingRole();
        }
        _;
    }

    /// @dev Scheme U: self-read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
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
     * @notice Returns the latest price and blockNumber for a single asset, with metadata.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_PRICE_DATA role (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_PRICE_DATA)
     * - Best-effort oracle call: returns (0,0) if the oracle call fails
     *
     * @param asset Asset address
     * @return price Asset price (SSOT: USD-8, i.e. $1.00 = 100000000)
     * @return blockNumber Oracle update block (block.number)
     * @return isValid Whether the oracle call succeeded
     */
    function getAssetPrice(
        address asset
    ) external view onlyValidRegistry onlyPriceViewer returns (uint256 price, uint256 blockNumber, bool isValid) {
        address priceOracle = _priceOracle();

        try IPriceOracle(priceOracle).getPrice(asset) returns (
            uint256 p,
            uint256 oracleBlockNumber,
            uint256 /* assetDecimals */
        ) {
            return (p, oracleBlockNumber, true);
        } catch {
            return (0, 0, false);
        }
    }

    /**
     * @notice Returns the latest price, blockNumber, and token decimals for a single asset, with metadata.
     * @dev This is the canonical "ERC-20 aware" read: `assetDecimals` is required to convert
     *      `amount(token base units)` into `valueUSD8`.
     *
     * @return price Asset price (USD-8)
     * @return blockNumber Oracle update block (block.number)
     * @return assetDecimals ERC-20 token decimals (SSOT: same semantics as IPriceOracle.getPrice's third return value)
     * @return isValid Whether the oracle call succeeded
     */
    function getAssetPriceWithDecimals(address asset)
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (uint256 price, uint256 blockNumber, uint256 assetDecimals, bool isValid)
    {
        address priceOracle = _priceOracle();
        try IPriceOracle(priceOracle).getPrice(asset) returns (uint256 p, uint256 oracleBlockNumber, uint256 dAsset) {
            return (p, oracleBlockNumber, dAsset, true);
        } catch {
            return (0, 0, 0, false);
        }
    }

    /**
     * @notice Convert an ERC-20 `amount` into USD-8 value using the PriceOracle SSOT.
     * @dev Best-effort: returns (0,0,false) if the oracle call fails.
     *
     * Value Unit SSOT:
     * - price is USD-8 per 1 token
     * - assetDecimals is ERC-20 decimals
     * - valueUSD8 = amount(token base units) * price(USD-8) / 10**assetDecimals
     *
     * @param asset ERC-20 asset address
     * @param amount Amount in token base units (ERC-20 decimals)
     * @return valueUsd8 USD-8 value
     * @return priceUpdateBlock Oracle update block (block.number)
     * @return isValid Whether the oracle call succeeded
     */
    function getAssetValueUsd8(address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (uint256 valueUsd8, uint256 priceUpdateBlock, bool isValid)
    {
        if (asset == address(0) || amount == 0) return (0, 0, true);
        address priceOracle = _priceOracle();
        try IPriceOracle(priceOracle).getPrice(asset) returns (uint256 p, uint256 blockNumber, uint256 dAsset) {
            if (p == 0) return (0, blockNumber, true);
            if (dAsset > 77) return (0, blockNumber, false);
            uint256 scale = 10 ** dAsset;
            if (scale == 0) return (0, blockNumber, false);
            // Use mulDiv to avoid overflow on amount * price.
            return (Math.mulDiv(amount, p, scale), blockNumber, true);
        } catch {
            return (0, 0, false);
        }
    }

    /**
     * @notice Returns latest prices and blockNumbers for a batch of assets, with metadata.
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
     * @return blockNumbers Oracle update blocks (block.number)
     * @return validFlags Per-asset validity flags (best-effort)
     */
    function getAssetPrices(
        address[] calldata assets
    )
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (uint256[] memory prices, uint256[] memory blockNumbers, bool[] memory validFlags)
    {
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length > _MAX_BATCH_SIZE) revert BatchTooLarge(length, _MAX_BATCH_SIZE);

        prices = new uint256[](length);
        blockNumbers = new uint256[](length);
        validFlags = new bool[](length);

        address priceOracle = _priceOracle();
        try IPriceOracle(priceOracle).getPrices(assets) returns (
            uint256[] memory p,
            uint256[] memory blockNumber,
            uint256[] memory
        ) {
            if (p.length == length && blockNumber.length == length) {
                prices = p;
                blockNumbers = blockNumber;
                for (uint256 i; i < length; ++i) {
                    validFlags[i] = blockNumber[i] != 0;
                }
                return (prices, blockNumbers, validFlags);
            }
        } catch {
            // Fall through to per-asset best-effort reads.
        }

        // Best-effort per-asset fallback to avoid "all zero" on mixed lists.
        for (uint256 i; i < length; ++i) {
            (uint256 pOne, uint256 tsOne) = _readAssetPrice(priceOracle, assets[i]);
            prices[i] = pOne;
            blockNumbers[i] = tsOne;
            validFlags[i] = tsOne != 0;
        }
        return (prices, blockNumbers, validFlags);
    }

    /**
     * @notice Returns whether the oracle considers the price for an asset valid, with metadata.
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
     * @return blockNumber Oracle update block (block.number; best-effort)
     */
    function isPriceValid(address asset)
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (bool isValid, uint256 blockNumber)
    {
        address priceOracle = _priceOracle();

        try IPriceOracle(priceOracle).isPriceValid(asset) returns (bool ok) {
            (, uint256 oracleBlockNumber) = _readAssetPrice(priceOracle, asset);
            return (ok, oracleBlockNumber);
        } catch {
            return (false, 0);
        }
    }

    /*━━━━━━━━━━━━━━━ View (Oracle Health) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Checks the health status of the price oracle for a given asset, with metadata.
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
     * @return blockNumber Read blockNumber (block.number; best-effort)
     */
    function checkPriceOracleHealth(
        address asset
    )
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (bool isHealthy, string memory details, uint256 blockNumber)
    {
        if (asset == address(0)) return (false, "Zero address", 0);

        address priceOracle = _priceOracle();

        // Best-effort: if the oracle can expose asset config, use it to provide stable, user-friendly reasons.
        // This avoids leaking low-level revert payloads into UI-facing outputs.
        try IPriceOracle(priceOracle).getAssetConfig(asset) returns (IPriceOracle.AssetConfig memory cfg) {
            if (!cfg.isActive) return (false, "Asset not supported", _now());
        } catch {
            return (false, "oracle call failed", 0);
        }

        // Architecture-Guide SSOT: oracle health checks are performed via GracefulDegradation (no bespoke oracle method).
        (bool healthy, string memory info) = GracefulDegradation.checkPriceOracleHealth(priceOracle, asset);
        if (!healthy && _shouldMaskOracleFailure(info)) {
            return (false, "oracle call failed", 0);
        }
        return (healthy, info, _now());
    }

    /*━━━━━━━━━━━━━━━ View (Oracle Health - Batch) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Checks the health status of the price oracle for a batch of assets, with metadata.
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
     * @return blockNumbers Per-asset read blockNumbers (block.number; best-effort)
     */
    function batchCheckPriceOracleHealth(
        address[] calldata assets
    )
        external
        view
        onlyValidRegistry
        onlyPriceViewer
        returns (bool[] memory healthStatuses, string[] memory details, uint256[] memory blockNumbers)
    {
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length > _MAX_BATCH_SIZE) revert BatchTooLarge(length, _MAX_BATCH_SIZE);

        healthStatuses = new bool[](length);
        details = new string[](length);
        blockNumbers = new uint256[](length);

        address priceOracle = _priceOracle();

        for (uint256 i = 0; i < length; ++i) {
            address asset = assets[i];
            if (asset == address(0)) {
                healthStatuses[i] = false;
                details[i] = "Zero address";
                blockNumbers[i] = 0;
                continue;
            }

            // Stable, user-friendly reasons if the oracle exposes asset config.
            try IPriceOracle(priceOracle).getAssetConfig(asset) returns (IPriceOracle.AssetConfig memory cfg) {
                if (!cfg.isActive) {
                    healthStatuses[i] = false;
                    details[i] = "Asset not supported";
                    blockNumbers[i] = _now();
                    continue;
                }
            } catch {
                healthStatuses[i] = false;
                details[i] = "oracle call failed";
                blockNumbers[i] = 0;
                continue;
            }

            (bool healthy, string memory info) = GracefulDegradation.checkPriceOracleHealth(priceOracle, asset);
            healthStatuses[i] = healthy;
            if (!healthy && _shouldMaskOracleFailure(info)) {
                details[i] = "oracle call failed";
                blockNumbers[i] = 0;
            } else {
                details[i] = info;
                blockNumbers[i] = _now();
            }
        }
    }

    /// @dev For UI-facing read APIs, keep oracle failures stable (do not leak low-level revert decoding).
    function _shouldMaskOracleFailure(string memory info) internal pure returns (bool) {
        bytes memory b = bytes(info);
        // "Price oracle ..." errors come from GracefulDegradation's catch paths.
        if (b.length < 11) return false;
        // Compare prefix "Price oracle"
        return (
            b[0] == "P" &&
            b[1] == "r" &&
            b[2] == "i" &&
            b[3] == "c" &&
            b[4] == "e" &&
            b[5] == " " &&
            b[6] == "o" &&
            b[7] == "r" &&
            b[8] == "a" &&
            b[9] == "c" &&
            b[10] == "l"
        );
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

    function _readAssetPrice(address oracle, address asset) internal view returns (uint256 price, uint256 blockNumber) {
        try IPriceOracle(oracle).getPrice(asset) returns (
            uint256 p,
            uint256 oracleBlockNumber,
            uint256 /* assetDecimals */
        ) {
            return (p, oracleBlockNumber);
        } catch {
            return (0, 0);
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
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
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
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0) revert NotAContract(newRegistryAddr);

        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;

        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            _now()
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
     * @notice Returns whether a user has permission to upgrade this module, with metadata.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - Registry does not have KEY_ACCESS_CONTROL configured (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Read-only; consults the Registry ACM (ACTION_UPGRADE_MODULE)
     *
     * @param user User address to check
     * @return hasPermission True if user has ACTION_UPGRADE_MODULE role
     * @return isValid Whether the read succeeded
     * @return blockNumber Read blockNumber (block.number)
     */
    function hasUpgradePermission(address user)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (bool hasPermission, bool isValid, uint256 blockNumber)
    {
        // Check upgrade permission via the Registry ACM.
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        hasPermission = IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, user);
        return (hasPermission, true, _now());
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
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender)) {
            revert MissingRole();
        }

        if (newImplementation == address(0)) revert ValuationOracleView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap for future upgrades.
    uint256[50] private __gap;
}
