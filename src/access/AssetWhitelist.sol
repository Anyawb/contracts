// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { NotAContract, ZeroAddress } from "../errors/StandardErrors.sol";
import { Registry } from "../registry/Registry.sol";

/**
 * @title AssetWhitelist
 * @notice Governance-managed allowlist of supported assets (collateral / settlement).
 * @dev This module is consumed by core flows (e.g. VaultRouter / matching libraries) to validate
 *      whether an ERC20 asset is allowed. View functions are intentionally non-reverting in normal
 *      operation and do not depend on Registry being set.
 *
 * Security:
 * - Writes are role-gated via ACM (resolved from Registry).
 * - Upgrade is role-gated (ACTION_UPGRADE_MODULE).
 */
contract AssetWhitelist is Initializable, UUPSUpgradeable, IAssetWhitelist {
    /* ============ Errors ============ */
    /// @notice Reverted when attempting to add an already-allowed asset.
    error AssetWhitelist__AssetAlreadyAllowed(address asset);
    /// @notice Reverted when attempting to remove/update an asset that is not allowed.
    error AssetWhitelist__AssetNotAllowed(address asset);
    /// @notice Reverted when a batch operation receives an empty array.
    error AssetWhitelist__EmptyAssetsArray();
    /// @notice Reverted when an index is out of bounds for the internal asset list.
    error AssetWhitelist__IndexOutOfBounds(uint256 index, uint256 length);

    /* ============ Storage ============ */
    /// @notice Registry contract address (SSOT for module address resolution).
    address private _registryAddr;

    /* ============ Modifiers ============ */
    /// @notice Ensures the stored Registry address is set (non-zero).
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }
    
    /// @notice Allowlist mapping: asset => allowed.
    mapping(address => bool) private _allowedAssets;
    
    /// @notice List of currently allowed assets.
    address[] private _assetList;
    
    /// @notice Index mapping for O(1) removal: asset => index in `_assetList`.
    mapping(address => uint256) private _assetIndex;
    
    /// @notice Number of allowed assets (mirrors `_assetList.length`).
    uint256 private _assetCount;
    
    /// @notice Bookkeeping info per asset.
    mapping(address => AssetInfo) private _assetInfo;

    /* ============ Structs ============ */
    /// @notice Bookkeeping info for an asset (not used for allowlist validation).
    /// @param isActive Whether the asset is currently allowed.
    /// @param addedAt Block number when the asset was first added.
    /// @param addedBy Address that added the asset.
    /// @param lastUpdated Block number of the last bookkeeping update.
    /// @param updateCount Number of bookkeeping updates (including add/remove/info updates).
    // NOTE: Keep field order stable for upgrade-safe storage layout. Do not reorder for packing.
    struct AssetInfo {
        bool isActive;
        uint256 addedAt;
        address addedBy;
        uint256 lastUpdated;
        uint256 updateCount;
    }

    /* ============ Events ============ */
    /// @notice Emitted when an asset is added to the allowlist.
    /// @param actionKey Action key used for authorization (ActionKeys.ACTION_ADD_WHITELIST).
    /// @param asset Asset address.
    /// @param addedBy Caller who performed the action.
    /// @param blockNumber Block number when the event was emitted.
    event AssetAdded(
        bytes32 indexed actionKey,
        address indexed asset, 
        address indexed addedBy,
        uint256 blockNumber
    );

    /// @notice Emitted when an asset is removed from the allowlist.
    /// @param actionKey Action key used for authorization (ActionKeys.ACTION_REMOVE_WHITELIST).
    /// @param asset Asset address.
    /// @param removedBy Caller who performed the action.
    /// @param blockNumber Block number when the event was emitted.
    event AssetRemoved(
        bytes32 indexed actionKey,
        address indexed asset, 
        address indexed removedBy,
        uint256 blockNumber
    );

    /// @notice Emitted after a batch add operation.
    /// @param actionKey Action key used for authorization (ActionKeys.ACTION_ADD_WHITELIST).
    /// @param assets Input assets array (may include already-allowed assets).
    /// @param addedBy Caller who performed the action.
    /// @param addedCount Number of newly-added assets.
    /// @param totalCount Total number of assets provided in the input array.
    event AssetsBatchAdded(
        bytes32 indexed actionKey,
        address[] assets, 
        address indexed addedBy,
        uint256 addedCount,
        uint256 totalCount
    );

    /// @notice Emitted after a batch remove operation.
    /// @param actionKey Action key used for authorization (ActionKeys.ACTION_REMOVE_WHITELIST).
    /// @param assets Input assets array (may include already-removed assets).
    /// @param removedBy Caller who performed the action.
    /// @param removedCount Number of assets removed during this call.
    /// @param totalCount Total number of assets provided in the input array.
    event AssetsBatchRemoved(
        bytes32 indexed actionKey,
        address[] assets, 
        address indexed removedBy,
        uint256 removedCount,
        uint256 totalCount
    );

    /// @notice Emitted when bookkeeping info is updated for an allowed asset.
    /// @param actionKey Action key used for authorization (ActionKeys.ACTION_SET_PARAMETER).
    /// @param asset Asset address.
    /// @param updatedBy Caller who performed the action.
    /// @param blockNumber Block number when the event was emitted.
    event AssetInfoUpdated(
        bytes32 indexed actionKey,
        address indexed asset, 
        address indexed updatedBy,
        uint256 blockNumber
    );

    /* ============ Constructor ============ */
    /// @dev Disable initializers on the implementation contract.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /* ============ Initializer ============ */
    /**
     * @notice Initialize the AssetWhitelist module.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0)
     *
     * Security:
     * - Initializer (callable once via proxy).
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        
        _registryAddr = initialRegistryAddr;
        
        uint256 ts = block.number;
        // Record initialization (governance/audit trail).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            ts
        );
    }

    /* ============ External View Functions ============ */
    
    /// @inheritdoc IAssetWhitelist
    function isAssetAllowed(address asset) external view override returns (bool) {
        return _allowedAssets[asset];
    }

    /// @inheritdoc IAssetWhitelist
    function getAllowedAssets() external view override returns (address[] memory) {
        return _assetList;
    }

    /**
     * @notice Get the number of allowed assets.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return count Number of allowed assets.
     */
    function getAssetCount() external view returns (uint256 count) {
        return _assetCount;
    }

    /**
     * @notice Get bookkeeping info for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param asset Asset address.
     * @return info Asset bookkeeping info (may be zeroed if never added).
     */
    function getAssetInfo(address asset) external view returns (AssetInfo memory info) {
        return _assetInfo[asset];
    }

    /**
     * @notice Get an allowed asset address by its index in the internal list.
     * @dev Reverts if:
     *      - index >= _assetList.length
     *
     * Security:
     * - View-only.
     *
     * @param index Index into the internal asset list.
     * @return asset Asset address at the given index.
     */
    function getAssetAtIndex(uint256 index) external view returns (address asset) {
        uint256 length = _assetList.length;
        if (index >= length) revert AssetWhitelist__IndexOutOfBounds(index, length);
        return _assetList[index];
    }

    /* ============ External Admin Functions ============ */
    
    /**
     * @notice Add an asset to the allowlist.
     * @dev Reverts if:
     *      - Registry address is not set
     *      - caller lacks ActionKeys.ACTION_ADD_WHITELIST
     *      - asset == address(0)
     *      - asset is already allowed
     *
     * Security:
     * - Role-gated via ACM.
     *
     * @param asset Asset address to add.
     */
    function addAllowedAsset(address asset) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (_allowedAssets[asset]) revert AssetWhitelist__AssetAlreadyAllowed(asset);

        uint256 ts = block.number;
        
        _allowedAssets[asset] = true;
        _assetList.push(asset);
        _assetIndex[asset] = _assetList.length - 1;
        _assetCount++;
        
        _assetInfo[asset] = AssetInfo({
            isActive: true,
            addedAt: ts,
            addedBy: msg.sender,
            lastUpdated: ts,
            updateCount: 1
        });
        
        emit AssetAdded(ActionKeys.ACTION_ADD_WHITELIST, asset, msg.sender, ts);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_ASSET_WHITELIST_ADDED,
            abi.encode(asset, msg.sender, ts)
        );
        
        // Record standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            ts
        );
    }

    /**
     * @notice Remove an asset from the allowlist.
     * @dev Reverts if:
     *      - Registry address is not set
     *      - caller lacks ActionKeys.ACTION_REMOVE_WHITELIST
     *      - asset == address(0)
     *      - asset is not allowed
     *
     * Security:
     * - Role-gated via ACM.
     *
     * @param asset Asset address to remove.
     */
    function removeAllowedAsset(address asset) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_allowedAssets[asset]) revert AssetWhitelist__AssetNotAllowed(asset);

        uint256 ts = block.number;
        
        _allowedAssets[asset] = false;
        _assetCount--;
        
        // Update bookkeeping info.
        _assetInfo[asset].isActive = false;
        _assetInfo[asset].lastUpdated = ts;
        _assetInfo[asset].updateCount++;
        
        // Remove from list in O(1) by swapping with the last element.
        uint256 index = _assetIndex[asset];
        if (index < _assetList.length - 1) {
            address lastAsset = _assetList[_assetList.length - 1];
            _assetList[index] = lastAsset;
            _assetIndex[lastAsset] = index;
        }
        _assetList.pop();
        delete _assetIndex[asset];
        
        emit AssetRemoved(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            asset, 
            msg.sender,
            ts
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_ASSET_WHITELIST_REMOVED,
            abi.encode(asset, msg.sender, ts)
        );
        
        // Record standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            ts
        );
    }

    /**
     * @notice Batch add assets to the allowlist (idempotent for already-allowed assets).
     * @dev Reverts if:
     *      - Registry address is not set
     *      - caller lacks ActionKeys.ACTION_ADD_WHITELIST
     *      - assets.length == 0
     *      - any asset == address(0)
     *
     * Security:
     * - Role-gated via ACM.
     *
     * @param assets Asset addresses to add.
     */
    function batchAddAllowedAssets(address[] calldata assets) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (assets.length == 0) revert AssetWhitelist__EmptyAssetsArray();

        uint256 ts = block.number;
        
        uint256 addedCount = 0;
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            if (!_allowedAssets[asset]) {
                _allowedAssets[asset] = true;
                _assetList.push(asset);
                _assetIndex[asset] = _assetList.length - 1;
                _assetCount++;
                
                _assetInfo[asset] = AssetInfo({
                    isActive: true,
                    addedAt: ts,
                    addedBy: msg.sender,
                    lastUpdated: ts,
                    updateCount: 1
                });
                
                addedCount++;
            }
        }
        
        emit AssetsBatchAdded(
            ActionKeys.ACTION_ADD_WHITELIST,
            assets, 
            msg.sender,
            addedCount,
            assets.length
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_ASSET_WHITELIST_BATCH_ADDED,
            abi.encode(assets, msg.sender, addedCount, assets.length, ts)
        );
        
        // Record standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            ts
        );
    }

    /**
     * @notice Batch remove assets from the allowlist (idempotent for already-removed assets).
     * @dev Reverts if:
     *      - Registry address is not set
     *      - caller lacks ActionKeys.ACTION_REMOVE_WHITELIST
     *      - assets.length == 0
     *      - any asset == address(0)
     *
     * Security:
     * - Role-gated via ACM.
     *
     * @param assets Asset addresses to remove.
     */
    function batchRemoveAllowedAssets(address[] calldata assets) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (assets.length == 0) revert AssetWhitelist__EmptyAssetsArray();

        uint256 ts = block.number;
        
        uint256 removedCount = 0;
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            if (_allowedAssets[asset]) {
                _allowedAssets[asset] = false;
                _assetCount--;
                
                // Update bookkeeping info.
                _assetInfo[asset].isActive = false;
                _assetInfo[asset].lastUpdated = ts;
                _assetInfo[asset].updateCount++;
                
                // Remove from list in O(1) by swapping with the last element.
                uint256 index = _assetIndex[asset];
                if (index < _assetList.length - 1) {
                    address lastAsset = _assetList[_assetList.length - 1];
                    _assetList[index] = lastAsset;
                    _assetIndex[lastAsset] = index;
                }
                _assetList.pop();
                delete _assetIndex[asset];
                
                removedCount++;
            }
        }
        
        emit AssetsBatchRemoved(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            assets, 
            msg.sender,
            removedCount,
            assets.length
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_ASSET_WHITELIST_BATCH_REMOVED,
            abi.encode(assets, msg.sender, removedCount, assets.length, ts)
        );
        
        // Record standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            ts
        );
    }

    /**
     * @notice Update bookkeeping fields for an allowed asset (does not change allowlist status).
     * @dev Reverts if:
     *      - Registry address is not set
     *      - caller lacks ActionKeys.ACTION_SET_PARAMETER
     *      - asset == address(0)
     *      - asset is not allowed
     *
     * Security:
     * - Role-gated via ACM.
     *
     * @param asset Asset address.
     */
    function updateAssetInfo(address asset) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_allowedAssets[asset]) revert AssetWhitelist__AssetNotAllowed(asset);

        uint256 ts = block.number;
        
        _assetInfo[asset].lastUpdated = ts;
        _assetInfo[asset].updateCount++;
        
        emit AssetInfoUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            asset, 
            msg.sender,
            ts
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_ASSET_WHITELIST_INFO_UPDATED,
            abi.encode(asset, msg.sender, ts)
        );
        
        // Record standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            ts
        );
    }

    /**
     * @notice Update the stored Registry address.
     * @dev Reverts if:
     *      - Registry address is not set
     *      - caller lacks ActionKeys.ACTION_SET_PARAMETER
     *      - newRegistryAddr == address(0)
     *
     * Security:
     * - Role-gated via ACM.
     *
     * @param newRegistryAddr New Registry address.
     */
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0) revert NotAContract(newRegistryAddr);

        uint256 ts = block.number;
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_ASSET_WHITELIST_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, ts)
        );
        
        // Record standardized action event.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            ts
        );
        
        // Emit module address update event for observers.
        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            ts
        );
    }

    /* ============ Internal Functions ============ */
    
    /**
     * @notice Get the stored Registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return registryAddr Registry address.
     */
    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }
    
    /// @notice Require that `user` has `actionKey` permission in the system AccessControlManager.
    /// @param actionKey Action key to validate.
    /// @param user Address to validate.
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /* ============ Upgrade Functions ============ */
    
    /**
     * @notice UUPS upgrade authorization hook.
     * @dev Reverts if:
     *      - caller lacks ActionKeys.ACTION_UPGRADE_MODULE
     *      - newImplementation == address(0)
     *
     * Security:
     * - Role-gated via ACM (resolved from Registry).
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();

        uint256 ts = block.number;
        // Record upgrade authorization (governance/audit trail).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            ts
        );
    }

    /* ============ Storage Gap ============ */
    
    /// @dev Reserved storage space to allow layout changes in the future.
    uint256[50] private __gap;
} 