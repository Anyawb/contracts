// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {AccessControlLibrary} from "../../../libraries/AccessControlLibrary.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {DataPushLibrary} from "../../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../../constants/DataPushTypes.sol";
import {ViewVersioned} from "../ViewVersioned.sol";
import {
    BatchTooLarge,
    EmptyArray,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";

/**
 * @title ViewCache
 * @notice System-level view cache for per-asset snapshots.
 * @dev Reverts if:
 *      - registry is not set or is not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
 *
 * Security:
 * - UUPS upgradeable contract; upgrades are admin-gated via Registry roles.
 * - Write APIs are role-gated via Registry.
 * - User-scoped caches live in `UserView`; this module only caches system-level snapshots.
 * - `SystemStatusCache.utilizationRate` is expressed in WAD (1e18).
 */
contract ViewCache is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a system snapshot is written or cleared for an asset.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Event only.
     *
     * @param asset Asset address the snapshot corresponds to.
     * @param updater Caller that performed the write/clear.
     * @param blockNumber Legacy field: emit time axis marker (treated as updateBlock in this repo).
     */
    event CacheUpdated(
        address indexed asset,
        address indexed updater,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for CacheUpdated.
    event CacheUpdatedAtBlock(
        address indexed asset,
        address indexed updater,
        uint256 updateBlock
    );

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Thrown when the provided cache payload is invalid.
    error ViewCache__InvalidCacheData();
    /// @notice Thrown when attempting to upgrade to the zero address.
    error ViewCache__ZeroImplementation();

    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/

    struct SystemStatusCache {
        uint256 totalCollateral; // Aggregated collateral amount (domain-specific unit)
        uint256 totalDebt; // Aggregated debt amount (domain-specific unit)
        uint256 utilizationRate; // Utilization rate (WAD, 1e18)
        uint256 updateBlock; // Legacy field: snapshot time axis marker (treated as updateBlock)
        bool isValid; // Explicit validity flag (in addition to time-based freshness)
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry address used for SSOT module resolution and access control.
    address private _registryAddr;

    /// @notice asset => cached system snapshot.
    mapping(address => SystemStatusCache) private _systemStatusCache;

    /// @notice asset => last write marker (redundant to the struct but convenient for offchain tooling).
    /// NOTE: Time-Dependency-Refactor: stored value is `updateBlock` (block.number), not seconds.
    mapping(address => uint256) private _systemCacheUpdateBlocks;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initialization ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the ViewCache proxy.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - Initializer: callable once.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /**
     * @notice Return the configured Registry address (preferred naming).
     * @dev Reverts if: (never)
     *
     * Security:
     * - View-only.
     *
     * @return registryAddr_ Registry contract address.
     */
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Write Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Write or overwrite a system snapshot for a given asset.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA (AccessControlLibrary.requireRole)
     *      - asset == address(0) (ViewCache__InvalidCacheData)
     *
     * Security:
     * - Role-gated: ACTION_VIEW_SYSTEM_DATA.
     *
     * @param asset Asset address.
     * @param totalCollateral Total collateral (domain-specific unit).
     * @param totalDebt Total debt (domain-specific unit).
     * @param utilizationRate Utilization rate (WAD, 1e18).
     */
    function setSystemStatus(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 utilizationRate
    ) external onlyValidRegistry {
        AccessControlLibrary.requireRole(
            _registryAddr,
            ActionKeys.ACTION_VIEW_SYSTEM_DATA,
            msg.sender,
            msg.sender
        );

        if (asset == address(0)) revert ViewCache__InvalidCacheData();

        uint256 updateBlock = block.number;
        _systemStatusCache[asset] = SystemStatusCache({
            totalCollateral: totalCollateral,
            totalDebt: totalDebt,
            utilizationRate: utilizationRate,
            updateBlock: updateBlock,
            isValid: true
        });
        _systemCacheUpdateBlocks[asset] = updateBlock;

        emit CacheUpdated(asset, msg.sender, updateBlock);
        emit CacheUpdatedAtBlock(asset, msg.sender, updateBlock);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_SYSTEM_STATUS,
            abi.encode(
                asset,
                totalCollateral,
                totalDebt,
                utilizationRate,
                updateBlock
            )
        );
    }

    /**
     * @notice Clear the cached system snapshot for an asset.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (AccessControlLibrary.requireRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN.
     *
     * @param asset Asset address.
     */
    function clearSystemCache(address asset) external onlyValidRegistry {
        AccessControlLibrary.requireRole(
            _registryAddr,
            ActionKeys.ACTION_ADMIN,
            msg.sender,
            msg.sender
        );

        delete _systemStatusCache[asset];
        delete _systemCacheUpdateBlocks[asset];

        uint256 updateBlock = block.number;
        emit CacheUpdated(asset, msg.sender, updateBlock);
        emit CacheUpdatedAtBlock(asset, msg.sender, updateBlock);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_SYSTEM_STATUS,
            abi.encode(asset, uint256(0), uint256(0), uint256(0), updateBlock)
        );
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return the cached system snapshot for an asset along with validity.
     * @dev Reverts if: (never)
     *
     * Security:
     * - View-only.
     *
     * @param asset Asset address.
     * @return status Cached snapshot struct.
     * @return isValid True if both:
     *         - updateBlock is fresh within `ViewConstants.CACHE_DURATION_BLOCKS`, and
     *         - the explicit `status.isValid` flag is true.
     */
    function getSystemStatus(
        address asset
    ) external view returns (SystemStatusCache memory status, bool isValid) {
        status = _systemStatusCache[asset];
        isValid = _isCacheValid(status.updateBlock) && status.isValid;
    }

    /**
     * @notice Return cached system snapshot with explicit block-based metadata.
     * @dev Reverts if: (never)
     *
     * @param asset Asset address.
     * @return status Cached snapshot struct (legacy `updateBlock` field holds updateBlock).
     * @return isValid Whether the cache is valid (block-based TTL + explicit flag).
     * @return updateBlock The block number when the snapshot was last written (0 if never written).
     * @return ageBlocks The number of blocks since update (0 if updateBlock==0 or in the future).
     */
    function getSystemStatusWithBlockMeta(
        address asset
    )
        external
        view
        returns (
            SystemStatusCache memory status,
            bool isValid,
            uint256 updateBlock,
            uint256 ageBlocks
        )
    {
        status = _systemStatusCache[asset];
        updateBlock = status.updateBlock;
        isValid = _isCacheValid(updateBlock) && status.isValid;
        if (updateBlock == 0 || updateBlock > block.number) {
            ageBlocks = 0;
        } else {
            ageBlocks = block.number - updateBlock;
        }
    }

    /**
     * @notice Batch fetch system snapshots for multiple assets.
     * @dev Reverts if:
     *      - assets.length == 0 (EmptyArray)
     *      - assets.length > ViewConstants.MAX_BATCH_SIZE (BatchTooLarge)
     *
     * Security:
     * - View-only.
     *
     * @param assets Asset address list.
     * @return statuses Cached snapshot structs (1:1 with `assets`).
     * @return validFlags Freshness/validity flags (1:1 with `assets`).
     */
    function batchGetSystemStatus(
        address[] calldata assets
    )
        external
        view
        returns (SystemStatusCache[] memory statuses, bool[] memory validFlags)
    {
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length > ViewConstants.MAX_BATCH_SIZE)
            revert BatchTooLarge(length, ViewConstants.MAX_BATCH_SIZE);

        statuses = new SystemStatusCache[](length);
        validFlags = new bool[](length);

        for (uint256 i; i < length; ++i) {
            SystemStatusCache memory cache = _systemStatusCache[assets[i]];
            statuses[i] = cache;
            validFlags[i] = _isCacheValid(cache.updateBlock) && cache.isValid;
        }
    }

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/

    function _isCacheValid(uint256 updateBlock) internal view returns (bool) {
        uint256 nowBlock = block.number;
        if (updateBlock == 0) return false;
        if (updateBlock > nowBlock) return false;
        return nowBlock - updateBlock <= ViewConstants.CACHE_DURATION_BLOCKS;
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgrade ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (AccessControlLibrary.requireRole)
     *      - newImplementation == address(0) (ViewCache__ZeroImplementation)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Admin-gated via Registry.
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyValidRegistry {
        AccessControlLibrary.requireRole(
            _registryAddr,
            ActionKeys.ACTION_ADMIN,
            msg.sender,
            msg.sender
        );
        if (newImplementation == address(0))
            revert ViewCache__ZeroImplementation();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap for upgrade safety (UUPS).
    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the external API semantic version for this view module.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Return the schema version for cached outputs and DataPushed payloads.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }
}
