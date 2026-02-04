// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { NotAContract, ZeroAddress, AmountMismatch } from "../errors/StandardErrors.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

/// @dev Reverts when attempting to add an already-supported asset. Reserved for future use.
error PriceOracle__AssetAlreadySupported();

/// @dev Reverts when an asset is not supported/active.
/// Used by {getPrice,getPriceData,getPrices,getAssetCoingeckoId,updatePrice,updatePrices}.
error PriceOracle__AssetNotSupported();

/// @dev Reverts when a stored price is considered stale per `maxPriceAgeBlocks`. Used by {getPrice,getPrices}.
error PriceOracle__StalePrice();

/// @dev Reverts when a stored price is missing/invalid (e.g., not yet set).
/// Used by {getPrice,getPriceData,getPrices,updatePrice,updatePrices}.
error PriceOracle__InvalidPrice();

/// @dev Reverts when a blockNumber is invalid (e.g., future blockNumber).
/// Used by {getPrice,getPrices,updatePrice,updatePrices}.
error PriceOracle__InvalidBlockNumber();

/// @dev Reverts when a caller is unauthorized.
/// Reserved for future use (authorization is currently enforced via ACM roles).
error PriceOracle__Unauthorized();

/// @dev Reverts when token decimals cannot be determined or configured.
error PriceOracle__AssetDecimalsNotConfigured();

/// @dev Reverts when configured token decimals are invalid for safe scaling.
error PriceOracle__InvalidAssetDecimals(uint256 decimals);

/**
 * @title PriceOracle
 * @notice Stores and serves per-asset USD-8 prices, with governance-controlled configuration and role-gated updates.
 * @dev Reverts if:
 *      - Registry is not configured (see {ZeroAddress}) (via {onlyValidRegistry} on admin paths)
 *
 * Security:
 * - Role-gated via Registry ACM:
 *   - `ActionKeys.ACTION_SET_PARAMETER` for configuration changes
 *   - `ActionKeys.ACTION_UPDATE_PRICE` for price writes
 *   - `ActionKeys.ACTION_UPGRADE_MODULE` for upgrades (UUPS)
 * - This module is a *price store* only:
 *   - It does NOT implement valuation, graceful degradation, or oracle-health policy.
 *   - Valuation and health checks live in `libraries/GracefulDegradation.sol` and are consumed by
 *     `VaultLendingEngine` and view facades (e.g. `ValuationOracleView`).
 *
 * Units / semantics (SSOT):
 * - `price` is USD-8 (e.g. $1.00 == 100000000).
 * - `assetDecimals` is token decimals used for valuation scaling:
 *   `valueUSD8 = amount(token base units) * price(USD-8) / 10**assetDecimals`.
 *   It is NOT the price precision (price precision is fixed to USD-8).
 *
 * Integration:
 * - Intended Registry key: `ModuleKeys.KEY_PRICE_ORACLE`.
 * - Typical writer: `CoinGeckoPriceUpdater` (or governance/keeper equivalents).
 *
 * @custom:security-contact security@example.com
 */
contract PriceOracle is Initializable, UUPSUpgradeable, IPriceOracle {

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/

    /// @dev Fixed price precision for this module: USD-8 (e.g. $1.00 == 100000000).
    uint256 internal constant _PRICE_DECIMALS_VALUE = 8;

    /// @dev Default maximum allowed staleness for stored prices in blocks.
    /// NOTE: This is chain-dependent; governance SHOULD configure per-asset values explicitly.
    uint256 internal constant _DEFAULT_MAX_PRICE_AGE_BLOCKS_VALUE = 300;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @dev Registry address used to resolve ACM (access control) and other system modules.
    address private _registryAddr;

    /// @dev Per-asset stored price data.
    mapping(address => PriceData) private _prices;

    /// @dev Per-asset update block for the latest stored price (0 means unset).
    mapping(address => uint256) private _lastUpdateBlock;

    /// @dev Per-asset configuration (activation, token decimals, max price age, CoinGecko id).
    mapping(address => AssetConfig) private _assetConfigs;

    /// @dev List of all assets ever configured (may include inactive assets).
    address[] private _supportedAssets;

    /// @dev Asset index mapping (index + 1; 0 means absent). Used for O(1) membership checks.
    mapping(address => uint256) private _assetIndexPlus1;

    /// @dev Storage gap for future upgrades
    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @dev Ensures the Registry address is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initializes the PriceOracle with an initial Registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero (see {ZeroAddress})
     *
     * Security:
     * - Initialization is single-use via {initializer}.
     * - This function does NOT validate that `initialRegistryAddr` is a contract; the deployer MUST provide a correct
     *   Registry address. Subsequent admin paths additionally enforce {onlyValidRegistry}.
     *
     * @param initialRegistryAddr Registry address used to resolve the Access Control Manager (ACM) and other modules.
     */
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ External view functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the latest stored price data for `asset` if it is active and not stale.
     * @dev Reverts if:
     *      - `asset` is zero (see {ZeroAddress})
     *      - `asset` is not active (see {PriceOracle__AssetNotSupported})
     *      - the stored price is missing/invalid (see {PriceOracle__InvalidPrice})
     *      - the stored blockNumber is in the future (see {PriceOracle__InvalidBlockNumber})
     *      - the stored price is stale per `AssetConfig.maxPriceAge` (see {PriceOracle__StalePrice})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     * - The returned `price` is a stored value written by authorized updaters; consumers MUST apply their own oracle
     *   health policy (this contract is a price store).
     *
     * @param asset ERC-20 asset address.
     * @return price Price in USD-8 (e.g. $1.00 == 100000000).
     * @return blockNumber Informational blockNumber associated with the quoted price.
     * @return assetDecimals Token decimals used for valuation scaling (see `AssetConfig.assetDecimals`).
     */
    function getPrice(address asset)
        external
        view
        override
        returns (uint256 price, uint256 blockNumber, uint256 assetDecimals)
    {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        
        PriceData memory priceData = _prices[asset];
        if (!priceData.isValid) revert PriceOracle__InvalidPrice();

        uint256 updatedAtBlock = _lastUpdateBlock[asset];
        // Defensive: treat missing/invalid update block as invalid.
        if (updatedAtBlock == 0 || updatedAtBlock > block.number) revert PriceOracle__InvalidBlockNumber();
        if (block.number - updatedAtBlock > _assetConfigs[asset].maxPriceAgeBlocks) {
            revert PriceOracle__StalePrice();
        }
        
        return (priceData.price, priceData.blockNumber, priceData.assetDecimals);
    }

    /**
     * @notice Returns the raw stored {PriceData} for `asset`.
     * @dev Reverts if:
     *      - `asset` is zero (see {ZeroAddress})
     *      - `asset` is not active (see {PriceOracle__AssetNotSupported})
     *      - the stored price is missing/invalid (see {PriceOracle__InvalidPrice})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     * - This function does NOT enforce staleness; callers that require freshness MUST use {getPrice} or implement
     *   their own staleness policy using `AssetConfig.maxPriceAgeBlocks` and {block.number}.
     *
     * @param asset ERC-20 asset address.
     * @return priceData Stored price struct (includes USD-8 price, blockNumber, and token decimals used for scaling).
     */
    function getPriceData(address asset) external view override returns (PriceData memory priceData) {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        
        priceData = _prices[asset];
        if (!priceData.isValid) revert PriceOracle__InvalidPrice();
    }

    /**
     * @notice Returns the block number when the latest stored price for `asset` was updated.
     * @dev Reverts if:
     *      - `asset` is zero (see {ZeroAddress})
     *      - `asset` is not active (see {PriceOracle__AssetNotSupported})
     *      - the stored price is missing/invalid (see {PriceOracle__InvalidPrice})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     * - The update block is the onchain reference used for staleness checks (based on {block.number}).
     *
     * @param asset ERC-20 asset address.
     * @return updateBlock Block number at which the latest price was stored.
     */
    function getPriceUpdateBlock(address asset) external view override returns (uint256 updateBlock) {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        if (!_prices[asset].isValid) revert PriceOracle__InvalidPrice();
        return _lastUpdateBlock[asset];
    }

    /**
     * @notice Batch-returns update blocks aligned to `assets`.
     * @dev Reverts if:
     *      - any `assets[i]` is zero (see {ZeroAddress})
     *      - any `assets[i]` is not active (see {PriceOracle__AssetNotSupported})
     *      - any stored price is missing/invalid (see {PriceOracle__InvalidPrice})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     * - This function fails atomically: one invalid asset causes the entire call to revert.
     *
     * @param assets List of ERC-20 asset addresses.
     * @return updateBlocks Update block numbers aligned to `assets`.
     */
    function getPriceUpdateBlocks(address[] calldata assets)
        external
        view
        override
        returns (uint256[] memory updateBlocks)
    {
        uint256 length = assets.length;
        updateBlocks = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
            if (!_prices[asset].isValid) revert PriceOracle__InvalidPrice();
            updateBlocks[i] = _lastUpdateBlock[asset];
        }
    }

    /**
     * @notice Returns the {AssetConfig} for `asset` (may be inactive/unconfigured).
     * @dev Reverts if:
     *      - `asset` is zero (see {ZeroAddress})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     *
     * @param asset ERC-20 asset address.
     * @return config Asset configuration struct.
     */
    function getAssetConfig(address asset) external view override returns (AssetConfig memory config) {
        if (asset == address(0)) revert ZeroAddress();
        config = _assetConfigs[asset];
    }

    /**
     * @notice Returns the list of all assets ever configured in this oracle.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only; does not perform any external calls.
     *
     * @return List of asset addresses. Note: this list may include inactive assets.
     */
    function getSupportedAssets() external view returns (address[] memory) {
        return _supportedAssets;
    }

    /**
     * @notice Batch-returns latest stored price data for each asset in `assets` if all are active and not stale.
     * @dev Reverts if:
     *      - any `assets[i]` is zero (see {ZeroAddress})
     *      - any `assets[i]` is not active (see {PriceOracle__AssetNotSupported})
     *      - any stored price is missing/invalid (see {PriceOracle__InvalidPrice})
     *      - any stored blockNumber is in the future (see {PriceOracle__InvalidBlockNumber})
     *      - any stored price is stale per `AssetConfig.maxPriceAge` (see {PriceOracle__StalePrice})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     * - This function fails atomically: one invalid asset causes the entire call to revert.
     *
     * @param assets List of ERC-20 asset addresses.
     * @return prices Prices in USD-8, aligned to `assets`.
     * @return blockNumbers Informational blockNumbers, aligned to `assets`.
     * @return assetDecimalsArray Token decimals used for valuation scaling, aligned to `assets`.
     */
    function getPrices(address[] calldata assets) external view override returns (
        uint256[] memory prices,
        uint256[] memory blockNumbers,
        uint256[] memory assetDecimalsArray
    ) {
        uint256 length = assets.length;
        prices = new uint256[](length);
        blockNumbers = new uint256[](length);
        assetDecimalsArray = new uint256[](length);
        
        for (uint256 i = 0; i < length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            if (!_assetConfigs[assets[i]].isActive) revert PriceOracle__AssetNotSupported();
            
            PriceData memory priceData = _prices[assets[i]];
            if (!priceData.isValid) revert PriceOracle__InvalidPrice();

            uint256 updatedAtBlock = _lastUpdateBlock[assets[i]];
            if (updatedAtBlock == 0 || updatedAtBlock > block.number) revert PriceOracle__InvalidBlockNumber();
            if (block.number - updatedAtBlock > _assetConfigs[assets[i]].maxPriceAgeBlocks) {
                revert PriceOracle__StalePrice();
            }
            
            prices[i] = priceData.price;
            blockNumbers[i] = priceData.blockNumber;
            assetDecimalsArray[i] = priceData.assetDecimals;
        }
    }

    /**
     * @notice Returns whether the stored price for `asset` is currently usable under this oracle's staleness rules.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only; does not perform any external calls.
     * - Best-effort return value: returns `false` for any invalid/unknown state (zero asset, inactive asset,
     *   missing/invalid price, future blockNumber, or stale price).
     *
     * @param asset ERC-20 asset address.
     * @return isValid True if `asset` is active and its stored price is present, not in the future, and not stale.
     */
    function isPriceValid(address asset) external view override returns (bool isValid) {
        if (asset == address(0)) return false;
        if (!_assetConfigs[asset].isActive) return false;
        
        PriceData memory priceData = _prices[asset];
        if (!priceData.isValid) return false;
        uint256 updatedAtBlock = _lastUpdateBlock[asset];
        if (updatedAtBlock == 0 || updatedAtBlock > block.number) return false;
        return (block.number - updatedAtBlock <= _assetConfigs[asset].maxPriceAgeBlocks);
    }

    /**
     * @notice Returns the configured CoinGecko asset id for `asset`.
     * @dev Reverts if:
     *      - `asset` is zero (see {ZeroAddress})
     *      - `asset` is not active (see {PriceOracle__AssetNotSupported})
     *
     * Security:
     * - Read-only; does not perform any external calls.
     *
     * @param asset ERC-20 asset address.
     * @return coingeckoId CoinGecko id string as configured via {configureAsset}.
     */
    function getAssetCoingeckoId(address asset) external view override returns (string memory coingeckoId) {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        return _assetConfigs[asset].coingeckoId;
    }

    /**
     * @notice Returns the number of assets ever configured in this oracle.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only; does not perform any external calls.
     *
     * @return count Number of entries in {getSupportedAssets}.
     */
    function getAssetCount() external view override returns (uint256 count) {
        return _supportedAssets.length;
    }

    /**
     * @notice Configures an asset (CoinGecko id, token decimals for scaling, activation, and max allowed price age).
     * @dev Reverts if:
     *      - Registry is not configured / not a contract (see {ZeroAddress}, {NotAContract}) (via {onlyValidRegistry})
     *      - caller lacks `ActionKeys.ACTION_SET_PARAMETER` (reverts in ACM via {_requireRole})
     *      - `asset` is zero (see {ZeroAddress})
     *      - `assetDecimals` is zero and ERC-20 decimals cannot be read (see {PriceOracle__AssetDecimalsNotConfigured})
     *      - `assetDecimals` is too large for safe scaling (see {PriceOracle__InvalidAssetDecimals})
     *
     * Security:
     * - Role-gated: requires `ActionKeys.ACTION_SET_PARAMETER` in the Registry ACM.
     * - This function may perform an external call to `IERC20Metadata(asset).decimals()` ONLY when
     *   `assetDecimals == 0`.
     *   That read is best-effort and reverts only if decimals remain unconfigured (returns 0 / unreadable).
     *
     * @param asset ERC-20 asset address to configure.
     * @param coingeckoId CoinGecko id used by offchain updaters (may be empty).
     * @param assetDecimals Token decimals used for valuation scaling (NOT price precision).
     * @param maxPriceAgeBlocks Maximum allowed staleness in blocks (0 uses default).
     */
    function configureAsset(
        address asset,
        string calldata coingeckoId,
        uint256 assetDecimals,
        uint256 maxPriceAgeBlocks
    ) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        // assetDecimals is token decimals used for valuation scaling. If caller passes 0, try to read ERC20.decimals().
        if (assetDecimals == 0) {
            uint8 d = _tryReadErc20Decimals(asset);
            if (d == 0) revert PriceOracle__AssetDecimalsNotConfigured();
            assetDecimals = uint256(d);
        }
        _configureAssetInternal(asset, coingeckoId, assetDecimals, maxPriceAgeBlocks, true, true);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Activates or deactivates an already-configured asset.
     * @dev Reverts if:
     *      - Registry is not configured / not a contract (see {ZeroAddress}, {NotAContract}) (via {onlyValidRegistry})
     *      - caller lacks `ActionKeys.ACTION_SET_PARAMETER` (reverts in ACM via {_requireRole})
     *      - `asset` is zero (see {ZeroAddress})
     *
     * Security:
     * - Role-gated: requires `ActionKeys.ACTION_SET_PARAMETER` in the Registry ACM.
     * - Does not validate that the asset has ever been configured; it toggles the stored `isActive` flag.
     *
     * @param asset ERC-20 asset address to update.
     * @param isActive New active flag.
     */
    function setAssetActive(address asset, bool isActive) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        
        _assetConfigs[asset].isActive = isActive;
        emit AssetConfigUpdated(
            asset,
            _assetConfigs[asset].coingeckoId,
            isActive
        );
        
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ External admin functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Configures an asset using ERC-20 token decimals auto-detected from the token contract.
     * @dev Reverts if:
     *      - Registry is not configured / not a contract (see {ZeroAddress}, {NotAContract}) (via {onlyValidRegistry})
     *      - caller lacks `ActionKeys.ACTION_SET_PARAMETER` (reverts in ACM via {_requireRole})
     *      - `asset` is zero (see {ZeroAddress})
     *      - token decimals cannot be read (see {PriceOracle__AssetDecimalsNotConfigured})
     *
     * Security:
     * - Role-gated: requires `ActionKeys.ACTION_SET_PARAMETER` in the Registry ACM.
     * - Performs an external call to `IERC20Metadata(asset).decimals()`; if unreadable, this call reverts.
     *
     * @param asset ERC-20 asset address to configure.
     * @param coingeckoId CoinGecko id used by offchain updaters (may be empty).
     */
    function configureAsset(address asset, string calldata coingeckoId) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        uint8 d = _tryReadErc20Decimals(asset);
        if (d == 0) revert PriceOracle__AssetDecimalsNotConfigured();
        _configureAssetInternal(asset, coingeckoId, uint256(d), _DEFAULT_MAX_PRICE_AGE_BLOCKS_VALUE, true, true);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Updates the stored price for `asset`.
     * @dev Reverts if:
     *      - Registry is not configured / not a contract (see {ZeroAddress}, {NotAContract}) (via {onlyValidRegistry})
     *      - caller lacks `ActionKeys.ACTION_UPDATE_PRICE` (reverts in ACM via {_requireRole})
     *      - `asset` is zero (see {ZeroAddress})
     *      - `asset` is not active (see {PriceOracle__AssetNotSupported})
     *      - `price` is zero (see {PriceOracle__InvalidPrice})
     *      - `blockNumber` is in the future (see {PriceOracle__InvalidBlockNumber})
     *      - token decimals for scaling are not configured (see {PriceOracle__AssetDecimalsNotConfigured})
     *      - configured token decimals are too large for safe scaling (see {PriceOracle__InvalidAssetDecimals})
     *
     * Security:
     * - Role-gated: requires `ActionKeys.ACTION_UPDATE_PRICE` in the Registry ACM.
     * - This is a write path; consumers should treat written values as untrusted input guarded by governance/keepers.
     *
     * @param asset ERC-20 asset address to update.
     * @param price New price in USD-8.
     * @param blockNumber Informational blockNumber corresponding to the quoted price.
     */
    function updatePrice(address asset, uint256 price, uint256 blockNumber) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        if (price == 0) revert PriceOracle__InvalidPrice();
        // Prevent blockNumbers from going backwards once initialized.
        if (_prices[asset].isValid && blockNumber < _prices[asset].blockNumber) {
            revert PriceOracle__InvalidBlockNumber();
        }

        // assetDecimals must be configured; do NOT silently fall back to 8.
        // Otherwise, valuation would be mis-scaled by 10^(tokenDecimals-8).
        uint256 assetDecimals = _assetConfigs[asset].assetDecimals;
        if (assetDecimals == 0) revert PriceOracle__AssetDecimalsNotConfigured();
        if (assetDecimals > 77) revert PriceOracle__InvalidAssetDecimals(assetDecimals);
        
        _prices[asset] = PriceData({
            price: price,
            blockNumber: blockNumber,
            assetDecimals: assetDecimals,
            isValid: true
        });
        _lastUpdateBlock[asset] = block.number;
        
        emit PriceUpdated(asset, price, blockNumber);
        
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Batch-updates stored prices for `assets`.
     * @dev Reverts if:
     *      - Registry is not configured / not a contract (see {ZeroAddress}, {NotAContract}) (via {onlyValidRegistry})
     *      - caller lacks `ActionKeys.ACTION_UPDATE_PRICE` (reverts in ACM via {_requireRole})
     *      - array lengths mismatch (see {AmountMismatch})
     *      - any `assets[i]` is zero (see {ZeroAddress})
     *      - any `assets[i]` is not active (see {PriceOracle__AssetNotSupported})
     *      - any `prices[i]` is zero (see {PriceOracle__InvalidPrice})
     *      - any `blockNumbers[i]` is in the future (see {PriceOracle__InvalidBlockNumber})
     *      - any asset has missing/invalid token decimals for scaling (see {PriceOracle__AssetDecimalsNotConfigured})
     *      - any asset has configured decimals too large for safe scaling (see {PriceOracle__InvalidAssetDecimals})
     *
     * Security:
     * - Role-gated: requires `ActionKeys.ACTION_UPDATE_PRICE` in the Registry ACM.
     * - This function emits one {PriceUpdated} per asset and a single {SystemEvents.ActionExecuted} for the batch.
     *
     * @param assets List of ERC-20 asset addresses to update.
     * @param prices List of USD-8 prices aligned to `assets`.
     * @param blockNumbers List of informational blockNumbers aligned to `assets`.
     */
    function updatePrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) external override onlyValidRegistry {
        // Same implementation as batchUpdatePrices
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        if (assets.length != prices.length || assets.length != blockNumbers.length) {
            revert AmountMismatch();
        }
        
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            if (!_assetConfigs[assets[i]].isActive) revert PriceOracle__AssetNotSupported();
            if (prices[i] == 0) revert PriceOracle__InvalidPrice();
            if (_prices[assets[i]].isValid && blockNumbers[i] < _prices[assets[i]].blockNumber) {
                revert PriceOracle__InvalidBlockNumber();
            }

            uint256 assetDecimals = _assetConfigs[assets[i]].assetDecimals;
            if (assetDecimals == 0) revert PriceOracle__AssetDecimalsNotConfigured();
            if (assetDecimals > 77) revert PriceOracle__InvalidAssetDecimals(assetDecimals);
            
            _prices[assets[i]] = PriceData({
                price: prices[i],
                blockNumber: blockNumbers[i],
                assetDecimals: assetDecimals,
                isValid: true
            });
            _lastUpdateBlock[assets[i]] = block.number;
            
            emit PriceUpdated(assets[i], prices[i], blockNumbers[i]);
        }
        
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Applies an {AssetConfig} update and optionally activates the asset.
     * @dev Reverts if:
     *      - `assetDecimals` is zero (see {PriceOracle__AssetDecimalsNotConfigured})
     *      - `assetDecimals` is too large for safe scaling (see {PriceOracle__InvalidAssetDecimals})
     *
     * Security:
     * - Internal-only; callers are responsible for access control.
     * - `maxPriceAgeBlocks == 0` is normalized to {_DEFAULT_MAX_PRICE_AGE_BLOCKS_VALUE}.
     *
     * @param asset ERC-20 asset address to configure.
     * @param coingeckoId CoinGecko id used by offchain updaters (may be empty).
     * @param assetDecimals Token decimals used for valuation scaling (NOT price precision).
     * @param maxPriceAgeBlocks Maximum allowed staleness in blocks (0 uses default).
     * @param setActive Whether to set `isActive` to true/false.
     * @param emitConfigEvent Whether to emit {AssetConfigUpdated}.
     */
    function _configureAssetInternal(
        address asset,
        string memory coingeckoId,
        uint256 assetDecimals,
        uint256 maxPriceAgeBlocks,
        bool setActive,
        bool emitConfigEvent
    ) internal {
        // assetDecimals is token decimals used for 10**assetDecimals scaling in valuation.
        if (assetDecimals == 0) revert PriceOracle__AssetDecimalsNotConfigured();
        if (assetDecimals > 77) revert PriceOracle__InvalidAssetDecimals(assetDecimals);
        _assetConfigs[asset] = AssetConfig({
            coingeckoId: coingeckoId,
            assetDecimals: assetDecimals,
            isActive: setActive,
            maxPriceAgeBlocks: maxPriceAgeBlocks > 0 ? maxPriceAgeBlocks : _DEFAULT_MAX_PRICE_AGE_BLOCKS_VALUE
        });
        // If this is a new asset, append it to the supported list.
        if (_assetIndexPlus1[asset] == 0) {
            _supportedAssets.push(asset);
            _assetIndexPlus1[asset] = _supportedAssets.length;
        }
        if (emitConfigEvent) {
            emit AssetConfigUpdated(asset, coingeckoId, setActive);
        }
    }

    /*━━━━━━━━━━━━━━━ Internal functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Enforces that `user` has `actionKey` in the Registry's Access Control Manager (ACM).
     * @dev Reverts if:
     *      - Registry is not configured (see {ZeroAddress})
     *      - Registry is missing `ModuleKeys.KEY_ACCESS_CONTROL` (reverts in {IRegistry.getModuleOrRevert})
     *      - ACM denies `actionKey` for `user` (reverts in {IAccessControlManager.requireRole})
     *
     * Security:
     * - Centralizes role checks for this module.
     *
     * @param actionKey Action key from {ActionKeys}.
     * @param user Caller address to check.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @dev Best-effort read ERC20 decimals. Returns 0 if not readable.
    function _tryReadErc20Decimals(address asset) internal view returns (uint8 decimals) {
        if (asset.code.length == 0) return 0;
        try IERC20Metadata(asset).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 0;
        }
    }
    
    /*━━━━━━━━━━━━━━━ Upgrade authorization ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorizes UUPS upgrades for this module.
     * @dev Reverts if:
     *      - caller lacks `ActionKeys.ACTION_UPGRADE_MODULE` (reverts in ACM via {_requireRole})
     *      - `newImplementation` is zero (see {ZeroAddress})
     *
     * Security:
     * - Role-gated via Registry ACM (`ActionKeys.ACTION_UPGRADE_MODULE`).
     * - This function does not check that `newImplementation` has contract code; upgrade safety checks should be
     *   handled by governance procedures and deployment tooling.
     *
     * @param newImplementation Address of the new implementation contract.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

} 