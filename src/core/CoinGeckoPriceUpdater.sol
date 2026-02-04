// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ZeroAddress, EmptyArray, ArrayLengthMismatch } from "../errors/StandardErrors.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";

/// @dev Minimal monitor interface for onPriceUpdate notifications.
interface IPriceUpdateMonitor {
    function onPriceUpdate(address asset, string calldata eventType, bytes calldata eventData) external;
}

/// @title CoinGeckoPriceUpdater
/// @notice Updates on-chain oracle prices using CoinGecko IDs.
/// @dev Integrates with Registry + ACM (ActionKeys) and emits SystemEvents/DataPush.
/// @custom:security-contact security@example.com
contract CoinGeckoPriceUpdater is Initializable, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    
    /// @notice Max retry count for update attempts.
    uint256 private constant _MAX_RETRY_COUNT = 3;
    
    /// @notice Price refresh interval (blocks).
    /// @dev Chain-dependent. This is a best-effort local trigger hint (NOT a protocol gate).
    uint256 private constant _UPDATE_INTERVAL_BLOCKS = 300;
    
    /// @notice Max price deviation (bps).
    uint256 private constant _MAX_PRICE_DEVIATION = 1000; // 10%

    /// @notice Max reasonable price (8 decimals).
    uint256 private constant _MAX_REASONABLE_PRICE = 1e12;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry contract address.
    address private _registryAddr;
    
    /// @notice Asset -> CoinGecko ID mapping.
    mapping(address => string) private _assetToCoingeckoId;

    /// @notice Asset -> token decimals mapping (SSOT for valuation scaling).
    /// @dev Must match the ERC20 token's `decimals()` for correct value computation:
    ///      valueUSD8 = amount(token base units) * priceUSD8 / 10**assetDecimals
    mapping(address => uint8) private _assetDecimals;
    
    /// @notice Supported asset list (legacy; no longer maintained).
    address[] private _supportedAssets;
    
    /// @notice Last successful update block per asset.
    mapping(address => uint256) private _lastUpdateBlock;
    
    /// @notice Failure count per asset.
    mapping(address => uint256) private _updateFailureCount;
    
    /// @notice Last valid price per asset.
    mapping(address => uint256) private _lastValidPrice;
    
    /// @notice Auto update flag.
    bool private _autoUpdateEnabled;
    
    /// @notice Price validation flag.
    bool private _priceValidationEnabled;
    
    /// @notice Dynamic monitor registry.
    mapping(bytes32 => address) private _dynamicMonitors;
    
    /// @notice Registered monitor keys.
    bytes32[] private _registeredMonitorKeys;
    
    /// @notice Backup price sources.
    mapping(bytes32 => address) private _backupPriceSources;
    
    /// @notice Registered backup source keys.
    bytes32[] private _registeredBackupKeys;
    
    /// @notice Monitor active flag per address.
    mapping(address => bool) private _monitoringStatus;
    
    /// @dev Storage gap for future upgrades
    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when price is zero. Used by {updateAssetPrice}.
    error CoinGeckoPriceUpdater__InvalidPrice();
    /// @dev Reverts when blockNumber is in the future. Used by {updateAssetPrice}.
    error CoinGeckoPriceUpdater__InvalidBlockNumber();
    /// @dev Reverts when asset has no CoinGecko ID. Used by {updateAssetPrice,removeAsset}.
    error CoinGeckoPriceUpdater__AssetNotConfigured();
    /// @dev Reverts when CoinGecko ID is empty. Used by {configureAsset}.
    error CoinGeckoPriceUpdater__InvalidCoingeckoId();
    /// @dev Reverts on invalid monitor contract. Used by legacy external hooks.
    error CoinGeckoPriceUpdater__InvalidMonitorContract();
    /// @dev Reverts when monitor address has no code. Used by {registerMonitoring}.
    error CoinGeckoPriceUpdater__MonitorNotAContract(address monitorContract);
    /// @dev Reverts when token decimals cannot be determined for an asset.
    error CoinGeckoPriceUpdater__AssetDecimalsNotConfigured();
    /// @dev Reverts when configured decimals are invalid (0 or too large for safe scaling).
    error CoinGeckoPriceUpdater__InvalidAssetDecimals(uint256 decimals);

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    
    /// @notice Emitted when a price update succeeds.
    /// @dev Emitted by normal or emergency update flows.
    /// @param asset Asset address.
    /// @param coingeckoId CoinGecko ID.
    /// @param price Price (8 decimals).
    /// @param blockNumber Price blockNumber (blocks).
    event PriceUpdated(
        address indexed asset,
        string indexed coingeckoId,
        uint256 price,
        uint256 blockNumber
    );
    
    /// @notice Emitted when a price update fails.
    /// @dev Failure reason is encoded in reasonCode.
    /// @param asset Asset address.
    /// @param coingeckoId CoinGecko ID.
    /// @param reasonCode Failure reason code.
    event PriceUpdateFailed(
        address indexed asset,
        string indexed coingeckoId,
        bytes32 reasonCode
    );
    
    /// @notice Emitted when an asset configuration changes.
    /// @param asset Asset address.
    /// @param coingeckoId CoinGecko ID.
    /// @param isActive Whether the asset is active.
    event AssetConfigUpdated(address indexed asset, string indexed coingeckoId, bool isActive);

    /// @notice Emitted when an asset's token decimals are configured/updated.
    /// @param asset Asset address.
    /// @param decimals Token decimals (ERC20 `decimals()`).
    event AssetDecimalsUpdated(address indexed asset, uint8 decimals);
    
    /// @notice Emitted when auto-update is toggled.
    /// @param enabled Whether auto-update is enabled.
    event AutoUpdateToggled(bool enabled);

    /// @notice Emitted when price validation fails.
    /// @dev Emitted without reverting; update is skipped.
    /// @param asset Asset address.
    /// @param price Price (8 decimals).
    /// @param reasonCode Failure reason code.
    event PriceValidationFailed(address indexed asset, uint256 price, bytes32 reasonCode);

    /// @notice Emitted when price validation is toggled.
    /// @param enabled Whether validation is enabled.
    event PriceValidationToggled(bool enabled);

    /// @notice Emitted when the Registry address is updated.
    /// @param oldRegistry Previous Registry address.
    /// @param newRegistry New Registry address.
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice Emitted when a monitor is registered.
    /// @param monitorKey Monitor module key.
    /// @param monitorContract Monitor contract address.
    /// @param monitorName Monitor name.
    event MonitoringRegistered(bytes32 indexed monitorKey, address indexed monitorContract, string monitorName);
    
    /// @notice Emitted when a backup price source is registered.
    /// @param backupKey Backup source key.
    /// @param backupSource Backup source address.
    /// @param sourceName Source name.
    event BackupSourceRegistered(bytes32 indexed backupKey, address indexed backupSource, string sourceName);

    /// @notice Emitted when a health check fails.
    /// @param asset Asset address.
    /// @param reasonCode Failure reason code.
    event HealthCheckFailed(
        address indexed asset,
        bytes32 reasonCode
    );

    /*━━━━━━━━━━━━━━━ Reason Codes ━━━━━━━━━━━━━━━*/
    bytes32 private constant _REASON_VALIDATION_FAILED = bytes32("VALIDATION_FAILED");
    bytes32 private constant _REASON_EXCEEDS_MAX_VALUE = bytes32("EXCEEDS_MAX_VALUE");
    bytes32 private constant _REASON_MONITOR_CALL_FAILED = bytes32("MONITOR_CALL_FAILED");
    bytes32 private constant _REASON_ORACLE_UNAVAILABLE = bytes32("ORACLE_UNAVAILABLE");
    bytes32 private constant _REASON_ORACLE_UPDATE_FAILED = bytes32("ORACLE_UPDATE_FAILED");
    bytes32 private constant _REASON_DECIMALS_NOT_CONFIGURED = bytes32("DECIMALS_NOT_CONFIGURED");
    
    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    
    /// @notice Ensures Registry address is set.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice Ensures a monitor contract is valid.
    modifier validMonitorContract(address monitorContract) {
        if (monitorContract == address(0)) revert ZeroAddress();
        if (monitorContract.code.length == 0) revert CoinGeckoPriceUpdater__MonitorNotAContract(monitorContract);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Initializes the updater and binds the Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (see {ZeroAddress})
     *
     * Security:
     * - UUPS initializer
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(
        address initialRegistryAddr
    ) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        _autoUpdateEnabled = true;
        _priceValidationEnabled = true;
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ External Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Updates a single asset price and forwards to PriceOracle.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_UPDATE_PRICE (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - asset == address(0) (see {ZeroAddress})
     *      - price == 0 (see {CoinGeckoPriceUpdater__InvalidPrice})
     *      - asset has no CoinGecko ID (see {CoinGeckoPriceUpdater__AssetNotConfigured})
     *
     * Security:
     * - Role-gated: ACTION_UPDATE_PRICE via ACM
     * - Best-effort update: Registry/Oracle failures are caught; falls back to local update
     *
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @param blockNumber Price blockNumber (blocks)
     */
    function updateAssetPrice(
        address asset,
        uint256 price,
        uint256 blockNumber
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        if (price == 0) revert CoinGeckoPriceUpdater__InvalidPrice();
        // `blockNumber` is an informational/source marker only (legacy/compat).
        // Do NOT compare it to any onchain wall-clock time or use it as an onchain gate.
        
        string memory coingeckoId = _assetToCoingeckoId[asset];
        if (bytes(coingeckoId).length == 0) revert CoinGeckoPriceUpdater__AssetNotConfigured();
        
        // Price validation.
        if (_priceValidationEnabled && !_validatePrice(asset, price)) {
            emit PriceValidationFailed(asset, price, _REASON_VALIDATION_FAILED);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_VALIDATION_FAILED,
                abi.encode(asset, price, block.number)
            );
            return;
        }
        
        _updatePriceWithFallback(asset, price, blockNumber, coingeckoId);
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Updates multiple asset prices and forwards to PriceOracle.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_UPDATE_PRICE (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - assets is empty (see {EmptyArray})
     *      - array lengths mismatch (see {ArrayLengthMismatch})
     *
     * Security:
     * - Role-gated: ACTION_UPDATE_PRICE via ACM
     * - Best-effort update: Registry/Oracle failures are caught; falls back to local update
     *
     * @param assets Asset address list
     * @param prices Price list (8 decimals)
     * @param blockNumbers BlockNumber list (blocks)
     */
    function updateAssetPrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length != prices.length) revert ArrayLengthMismatch(length, prices.length);
        if (length != blockNumbers.length) revert ArrayLengthMismatch(length, blockNumbers.length);
        
        _batchUpdatePriceWithFallback(assets, prices, blockNumbers);
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Configures an asset's CoinGecko ID and token decimals (SSOT).
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - asset == address(0) (see {ZeroAddress})
     *      - coingeckoId is empty (see {CoinGeckoPriceUpdater__InvalidCoingeckoId})
     *      - token decimals cannot be read or are invalid (see {CoinGeckoPriceUpdater__InvalidAssetDecimals})
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER via ACM
     *
     * @param asset Asset address
     * @param coingeckoId CoinGecko ID
     */
    function configureAsset(address asset, string calldata coingeckoId) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        if (bytes(coingeckoId).length == 0) revert CoinGeckoPriceUpdater__InvalidCoingeckoId();

        // Determine and store token decimals (SSOT). This avoids mispricing due to hardcoded scaling.
        uint8 decimals = _readErc20Decimals(asset);
        if (decimals == 0 || decimals > 77) revert CoinGeckoPriceUpdater__InvalidAssetDecimals(decimals);
        _assetDecimals[asset] = decimals;
        
        _assetToCoingeckoId[asset] = coingeckoId;
        // _supportedAssets is deprecated; use mapping-based config instead.
        
        emit AssetConfigUpdated(asset, coingeckoId, true);
        emit AssetDecimalsUpdated(asset, decimals);
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Configures an asset's CoinGecko ID and token decimals explicitly.
     * @dev Use this for:
     *      - non-standard tokens (no ERC20Metadata `decimals()`),
     *      - assets whose decimals must be pinned by governance.
     *
     * Reverts if:
     * - Registry is not set (see {ZeroAddress})
     * - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     * - asset == address(0) (see {ZeroAddress})
     * - coingeckoId is empty (see {CoinGeckoPriceUpdater__InvalidCoingeckoId})
     * - decimals is 0 or too large for safe scaling (see {CoinGeckoPriceUpdater__InvalidAssetDecimals})
     */
    function configureAssetWithDecimals(
        address asset,
        string calldata coingeckoId,
        uint8 decimals
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (bytes(coingeckoId).length == 0) revert CoinGeckoPriceUpdater__InvalidCoingeckoId();
        if (decimals == 0 || decimals > 77) revert CoinGeckoPriceUpdater__InvalidAssetDecimals(decimals);

        _assetToCoingeckoId[asset] = coingeckoId;
        _assetDecimals[asset] = decimals;

        emit AssetConfigUpdated(asset, coingeckoId, true);
        emit AssetDecimalsUpdated(asset, decimals);

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Removes an asset's CoinGecko ID configuration.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - asset == address(0) (see {ZeroAddress})
     *      - asset has no CoinGecko ID (see {CoinGeckoPriceUpdater__AssetNotConfigured})
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER via ACM
     *
     * @param asset Asset address
     */
    function removeAsset(address asset) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        
        string memory coingeckoId = _assetToCoingeckoId[asset];
        if (bytes(coingeckoId).length == 0) revert CoinGeckoPriceUpdater__AssetNotConfigured();
        
        delete _assetToCoingeckoId[asset];
        delete _assetDecimals[asset];
        
        // Do not maintain list; only clear mapping config.
        
        emit AssetConfigUpdated(asset, coingeckoId, false);
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Toggles auto-update.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER via ACM
     *
     * @param enabled Whether auto-update is enabled
     */
    function toggleAutoUpdate(bool enabled) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        _autoUpdateEnabled = enabled;
        emit AutoUpdateToggled(enabled);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_AUTO_UPDATE_TOGGLED,
            abi.encode(enabled, msg.sender, block.number)
        );
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Toggles price validation.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER via ACM
     *
     * @param enabled Whether validation is enabled
     */
    function togglePriceValidation(bool enabled) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        _priceValidationEnabled = enabled;
        emit PriceValidationToggled(enabled);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_VALIDATION_TOGGLED,
            abi.encode(enabled, msg.sender, block.number)
        );
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Updates the Registry address.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - newRegistryAddr == address(0) (see {ZeroAddress})
     *
     * Security:
     * - Role-gated: ACTION_UPGRADE_MODULE via ACM
     *
     * @param newRegistryAddr New Registry address
     */
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        
        // Update Registry address.
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, block.number)
        );
        
        // Notify monitors about registry upgrade.
        _notifyMonitors(address(0), "REGISTRY_UPGRADE", abi.encode(oldRegistry, newRegistryAddr, block.number));
    }

    /*━━━━━━━━━━━━━━━ Dynamic Registry Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Registers a monitoring contract.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - monitorContract == address(0) (see {ZeroAddress})
     *      - monitorContract has no code (see {CoinGeckoPriceUpdater__MonitorNotAContract})
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER via ACM
     *
     * @param monitorContract Monitor contract address
     * @param monitorName Monitor name
     */
    function registerMonitoring(address monitorContract, string calldata monitorName) 
        external onlyValidRegistry validMonitorContract(monitorContract) {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // Deterministic module key generation; no on-chain cache to avoid stale semantics.
        bytes32 monitorKey = _makeModuleKey("MONITOR", monitorName);
        _dynamicMonitors[monitorKey] = monitorContract;
        _registeredMonitorKeys.push(monitorKey);
        _monitoringStatus[monitorContract] = true;
        
        emit MonitoringRegistered(monitorKey, monitorContract, monitorName);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MONITORING_REGISTERED,
            abi.encode(monitorKey, monitorContract, monitorName, msg.sender, block.number)
        );
    }
    
    /**
     * @notice Registers a backup price source.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - backupSource == address(0) (see {ZeroAddress})
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER via ACM
     *
     * @param backupSource Backup source address
     * @param sourceName Backup source name
     */
    function registerBackupPriceSource(address backupSource, string calldata sourceName) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (backupSource == address(0)) revert ZeroAddress();
        
        bytes32 backupKey = _makeModuleKey("BACKUP_SOURCE", sourceName);
        _backupPriceSources[backupKey] = backupSource;
        _registeredBackupKeys.push(backupKey);
        
        emit BackupSourceRegistered(backupKey, backupSource, sourceName);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BACKUP_SOURCE_REGISTERED,
            abi.encode(backupKey, backupSource, sourceName, msg.sender, block.number)
        );
    }
    
    /**
     * @notice Notifies all monitor contracts.
     * @dev Best-effort; failures are swallowed and do not revert.
     *
     * @param asset Asset address
     * @param eventType Event type (string)
     * @param eventData Event data (ABI-encoded)
     */
    function _notifyMonitors(
        address asset, 
        string memory eventType, 
        bytes memory eventData
    ) private {
        for (uint256 i = 0; i < _registeredMonitorKeys.length; i++) {
            bytes32 monitorKey = _registeredMonitorKeys[i];
            address monitorContract = _dynamicMonitors[monitorKey];
            if (monitorContract != address(0)) {
                try IPriceUpdateMonitor(monitorContract).onPriceUpdate(asset, eventType, eventData) {
                    uint256 noop = 0;
                    noop;
                } catch {
                    emit HealthCheckFailed(asset, _REASON_MONITOR_CALL_FAILED);
                }
            }
        }
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Returns whether an asset needs a refresh.
     * @dev Reverts if:
     *      - None
     *
     * Security:
     * - View-only; best-effort local check
     *
     * @param asset Asset address
     * @return needsUpdate True if last update is older than UPDATE_INTERVAL
     */
    function needsUpdate(address asset) external view returns (bool) {
        if (asset == address(0)) return false;
        if (!_autoUpdateEnabled) return false;
        
        uint256 lastUpdate = _lastUpdateBlock[asset];
        if (lastUpdate == 0 || lastUpdate > block.number) return true;
        return (block.number - lastUpdate) > _UPDATE_INTERVAL_BLOCKS;
    }

    /*━━━━━━━━━━━━━━━ Internal Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Validates whether a price is within bounds.
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @return isValid True if the price is valid
     */
    function _validatePrice(address asset, uint256 price) internal view returns (bool isValid) {
        if (price == 0) return false;
        
        if (price > _MAX_REASONABLE_PRICE) return false;
        
        uint256 lastPrice = _lastValidPrice[asset];
        if (lastPrice == 0) return true; // First update
        
        // Solidity 0.8+ has built-in overflow/underflow checks.
        uint256 diff = price > lastPrice ? (price - lastPrice) : (lastPrice - price);
        uint256 deviation = diff * 10000 / lastPrice;
        
        return deviation <= _MAX_PRICE_DEVIATION;
    }
    
    /**
     * @notice Checks caller authorization.
     * @dev Reverts if:
     *      - Registry is not set (see {ZeroAddress})
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *      - ACM.requireRole fails
     *
     * @param actionKey Action key
     * @param user User address
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert ZeroAddress();
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /**
     * @notice Normal price update flow (internal).
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @param blockNumber Price blockNumber (blocks)
     * @param coingeckoId CoinGecko ID
     */
    function _normalPriceUpdate(
        address asset,
        uint256 price,
        uint256 blockNumber,
        string memory coingeckoId
    ) internal {
        // Resolve PriceOracle via Registry.
        address priceOracleAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        // Ensure asset is configured in PriceOracle.
        uint8 decimals = _assetDecimals[asset];
        if (decimals == 0) {
            emit PriceUpdateFailed(asset, coingeckoId, _REASON_DECIMALS_NOT_CONFIGURED);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_UPDATE_FAILED,
                abi.encode(asset, coingeckoId, _REASON_DECIMALS_NOT_CONFIGURED, block.number)
            );
            return;
        }
        try IPriceOracle(priceOracleAddr).configureAsset(asset, coingeckoId, decimals, 3600) {
            assert(true);
        } catch {
            assert(true);
        }
        
        IPriceOracle(priceOracleAddr).updatePrice(asset, price, blockNumber);
        _lastUpdateBlock[asset] = block.number;
        _updateFailureCount[asset] = 0;
        _lastValidPrice[asset] = price;
        
        emit PriceUpdated(asset, coingeckoId, price, blockNumber);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_UPDATED,
            abi.encode(asset, price, blockNumber, coingeckoId, msg.sender, block.number)
        );
        
        // Notify monitors.
        _notifyMonitors(
            asset, 
            "PRICE_UPDATE_SUCCESS", 
            abi.encode(price, blockNumber, coingeckoId)
        );
    }
    
    /**
     * @notice Emergency price update flow (when Registry/Oracle is unavailable).
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @param blockNumber Price blockNumber (blocks)
     * @param coingeckoId CoinGecko ID
     */
    function _emergencyPriceUpdate(
        address asset,
        uint256 price,
        uint256 blockNumber,
        string memory coingeckoId
    ) internal {
        // Emergency mode: local-only update.
        _lastUpdateBlock[asset] = block.number;
        _updateFailureCount[asset] = 0;
        _lastValidPrice[asset] = price;
        
        emit PriceUpdated(asset, coingeckoId, price, blockNumber);
        emit HealthCheckFailed(asset, _REASON_ORACLE_UNAVAILABLE);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_UPDATED,
            abi.encode(asset, price, blockNumber, coingeckoId, msg.sender, block.number)
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_COMPONENT_HEALTH,
            abi.encode(address(this), "PriceOracle", false, "Emergency mode: Oracle unavailable", block.number)
        );
        
        // Skip monitor notifications in emergency mode.
    }
    
    /**
     * @notice Price update flow with fallback to emergency update.
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @param blockNumber Price blockNumber (blocks)
     * @param coingeckoId CoinGecko ID
     */
    function _updatePriceWithFallback(
        address asset,
        uint256 price,
        uint256 blockNumber,
        string memory coingeckoId
    ) internal {
        if (price > _MAX_REASONABLE_PRICE) {
            emit PriceValidationFailed(asset, price, _REASON_EXCEEDS_MAX_VALUE);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_VALIDATION_FAILED,
                abi.encode(asset, price, block.number)
            );
            return;
        }
        
        // Try normal update.
        if (_registryAddr != address(0)) {
            try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE)
                returns (address priceOracleAddr)
            {
                if (_executeSingleNormalPriceUpdate(priceOracleAddr, asset, price, blockNumber, coingeckoId)) {
                    // Notify monitors.
                    _notifyMonitors(
                        asset, 
                        "PRICE_UPDATE_SUCCESS", 
                        abi.encode(price, blockNumber, coingeckoId)
                    );
                    return; // Success
                }
            } catch {
                assert(true);
            }
        }
        
        // Emergency local update.
        _executeSingleEmergencyPriceUpdate(asset, price, blockNumber, coingeckoId);
    }
    
    /**
     * @notice Batch price update flow with fallback to emergency update.
     * @param assets Asset address list
     * @param prices Price list (8 decimals)
     * @param blockNumbers BlockNumber list (blocks)
     */
    function _batchUpdatePriceWithFallback(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) internal {
        uint256 length = assets.length;
        address priceOracleAddr;
        bool oracleAvailable = false;
        
        // Resolve oracle once to reduce gas.
        if (_registryAddr != address(0)) {
            try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE) returns (address oracle) {
                priceOracleAddr = oracle;
                oracleAvailable = true;
            } catch {
                assert(true);
            }
        }
        
        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            uint256 price = prices[i];
            uint256 blockNumber = blockNumbers[i];
            
            // Basic validation.
            if (asset == address(0) || price == 0) continue;
            
            string memory coingeckoId = _assetToCoingeckoId[asset];
            if (bytes(coingeckoId).length == 0) continue;
            
            if (price > _MAX_REASONABLE_PRICE) {
                emit PriceValidationFailed(asset, price, _REASON_EXCEEDS_MAX_VALUE);
                DataPushLibrary._emitData(
                    DataPushTypes.DATA_TYPE_PRICE_VALIDATION_FAILED,
                    abi.encode(asset, price, block.number)
                );
                continue;
            }
            
            // Try normal update.
            if (oracleAvailable) {
                if (_executeSingleNormalPriceUpdate(priceOracleAddr, asset, price, blockNumber, coingeckoId)) {
                    continue; // Success
                }
            }
            
            // Emergency update.
            _executeSingleEmergencyPriceUpdate(asset, price, blockNumber, coingeckoId);
        }
    }
    
    /**
     * @notice Normal update for a single asset.
     * @param priceOracleAddr PriceOracle address
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @param blockNumber Price blockNumber (blocks)
     * @param coingeckoId CoinGecko ID
     * @return success True if update succeeded
     */
    function _executeSingleNormalPriceUpdate(
        address priceOracleAddr,
        address asset,
        uint256 price,
        uint256 blockNumber,
        string memory coingeckoId
    ) internal returns (bool success) {
        uint8 decimals = _assetDecimals[asset];
        if (decimals == 0) return false;

        try IPriceOracle(priceOracleAddr).configureAsset(asset, coingeckoId, decimals, 3600) {
            assert(true);
        } catch {
            assert(true);
        }
        
        try IPriceOracle(priceOracleAddr).updatePrice(asset, price, blockNumber) {
            _lastUpdateBlock[asset] = block.number;
            _updateFailureCount[asset] = 0;
            _lastValidPrice[asset] = price;
            
            emit PriceUpdated(asset, coingeckoId, price, blockNumber);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_UPDATED,
                abi.encode(asset, price, blockNumber, coingeckoId, msg.sender, block.number)
            );
            return true;
        } catch (bytes memory error) {
            emit SystemEvents.ExternalModuleReverted("PriceOracle", error, block.number);
            _updateFailureCount[asset]++;
            emit PriceUpdateFailed(asset, coingeckoId, _REASON_ORACLE_UPDATE_FAILED);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_UPDATE_FAILED,
                abi.encode(asset, coingeckoId, error, block.number)
            );
            return false;
        }
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev Best-effort read ERC20 decimals. Returns 0 if not readable.
    function _readErc20Decimals(address asset) internal view returns (uint8 decimals) {
        if (asset == address(0) || asset.code.length == 0) return 0;
        try IERC20Metadata(asset).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 0;
        }
    }
    
    /**
     * @notice Emergency update for a single asset.
     * @param asset Asset address
     * @param price Price (8 decimals)
     * @param blockNumber Price blockNumber (blocks)
     * @param coingeckoId CoinGecko ID
     */
    function _executeSingleEmergencyPriceUpdate(
        address asset,
        uint256 price,
        uint256 blockNumber,
        string memory coingeckoId
    ) internal {
        _lastUpdateBlock[asset] = block.number;
        _updateFailureCount[asset] = 0;
        _lastValidPrice[asset] = price;
        
        emit PriceUpdated(asset, coingeckoId, price, blockNumber);
        emit HealthCheckFailed(asset, _REASON_ORACLE_UNAVAILABLE);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_UPDATED,
            abi.encode(asset, price, blockNumber, coingeckoId, msg.sender, block.number)
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_COMPONENT_HEALTH,
            abi.encode(address(this), "PriceOracle", false, "Emergency mode: Oracle unavailable", block.number)
        );
    }

    /// @notice Viewer/admin check was removed; use View modules instead.
    /// @param user User address
    /// @dev Kept as a comment for historical context.
    // Removed _requireViewerOrAdmin to reduce size; viewers should use View modules

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Generates a deterministic module key.
     * @dev Uses keccak256(abi.encodePacked(prefix, name)) for backward compatibility.
     * @param prefix Prefix string
     * @param name Name string
     * @return Module key
     */
    function _makeModuleKey(string memory prefix, string memory name) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(prefix, name));
    }
     
    /**
     * @notice Returns a module address via Registry.
     * @param moduleKey Module key
     * @return Module address (address(0) on failure)
     */
    function _getModule(bytes32 moduleKey) internal view returns (address) {
        if (_registryAddr == address(0)) return address(0);
        
        try IRegistry(_registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddr) {
            return moduleAddr;
        } catch {
            return address(0);
        }
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgradeable ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorizes UUPS upgrades.
     * @dev Reverts if:
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - Registry missing KEY_ACCESS_CONTROL (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated: ACTION_UPGRADE_MODULE via ACM
     */
    function _authorizeUpgrade(address /* newImplementation */) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        // Emit standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }
} 