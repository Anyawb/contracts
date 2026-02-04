// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/**
 * @title AccessControlView
 * @notice Permission view cache module: caches user permission bits and permission levels for frontend 0-gas queries.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller is not the AccessControlManager module (AccessControlView__OnlyACM)
 *
 * Security:
 * - Permission data is pushed by on-chain AccessControlManager; this module only performs cache writes and
 *   read-only queries.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract AccessControlView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a single permission bit is cached for a user.
     * @param user Target user address
     * @param actionKey Permission action key (bytes32)
     * @param hasPermission Whether the permission bit is granted
     * @param blockNumber Cache update blockNumber (block.number)
     */
    event PermissionDataUpdated(
        address indexed user,
        bytes32 indexed actionKey,
        bool hasPermission,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a user's permission level is cached.
     * @param user Target user address
     * @param newLevel New permission level (IAccessControlManager.PermissionLevel)
     * @param blockNumber Cache update blockNumber (block.number)
     */
    event PermissionLevelUpdated(
        address indexed user,
        IAccessControlManager.PermissionLevel newLevel,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Caller must be the AccessControlManager module.
    error AccessControlView__OnlyACM();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /// @dev User permission bit cache: user => actionKey => bool.
    mapping(address => mapping(bytes32 => bool)) private _userPermissionsCache;

    /// @dev User permission level cache.
    mapping(address => IAccessControlManager.PermissionLevel) private _userPermissionLevelCache;

    /// @dev Last cache update block (block.number).
    mapping(address => uint256) private _cacheUpdateBlocks;

    uint256 private constant _CACHE_DURATION_BLOCKS = ViewConstants.CACHE_DURATION_BLOCKS;

    /*━━━━━━━━━━━━━━━ Access helpers ━━━━━━━━━━━━━━━*/
    /// @dev Scheme U: self read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyAuthorizedFor(address targetUser) {
        if (msg.sender != targetUser) {
            bool ok =
                ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                    || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
            if (!ok) revert MissingRole();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Only allows AccessControlManager module to call.
    modifier onlyACM() {
        if (msg.sender != _getACM()) revert AccessControlView__OnlyACM();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the AccessControlView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - initializer (UUPS)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Push APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push a single permission bit update (called by ACM after role changes).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not AccessControlManager (AccessControlView__OnlyACM)
     *
     * Security:
     * - onlyACM modifier (only AccessControlManager can push updates)
     *
     * @param user User address
     * @param actionKey Action key (bytes32)
     * @param hasPermission Whether the user has the permission
     */
    function pushPermissionUpdate(
        address user,
        bytes32 actionKey,
        bool hasPermission
    ) external onlyValidRegistry onlyACM {
        _userPermissionsCache[user][actionKey] = hasPermission;
        uint256 updateBlock = block.number;
        _cacheUpdateBlocks[user] = updateBlock;
        emit PermissionDataUpdated(user, actionKey, hasPermission, updateBlock);
        // Unified DataPush (for off-chain consumers)
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PERMISSION_BIT_UPDATE,
            abi.encode(user, actionKey, hasPermission)
        );
    }

    /**
     * @notice Push a permission level update (called by ACM after level changes).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not AccessControlManager (AccessControlView__OnlyACM)
     *
     * Security:
     * - onlyACM modifier (only AccessControlManager can push updates)
     *
     * @param user User address
     * @param newLevel New permission level (PermissionLevel enum)
     */
    function pushPermissionLevelUpdate(
        address user,
        IAccessControlManager.PermissionLevel newLevel
    ) external onlyValidRegistry onlyACM {
        _userPermissionLevelCache[user] = newLevel;
        uint256 updateBlock = block.number;
        _cacheUpdateBlocks[user] = updateBlock;
        emit PermissionLevelUpdated(user, newLevel, updateBlock);
        // Unified DataPush (for off-chain consumers)
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PERMISSION_LEVEL_UPDATE,
            abi.encode(user, newLevel)
        );
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the current AccessControlManager contract address.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     *
     * @return accessControlManagerAddr AccessControlManager contract address
     */
    function getACM() external view onlyValidRegistry returns (address accessControlManagerAddr) {
        return _getACM();
    }

    /**
     * @notice Query whether a user has a specific permission bit, with cache validity and blockNumber
     *         (B-class cache unified output format).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized to read `user` (Scheme U; see {onlyAuthorizedFor})
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     *
     * @param user User address
     * @param actionKey Action key (bytes32)
     * @return hasPermission Whether the user has the permission
     * @return isValid Whether the cache is valid (within CACHE_DURATION_BLOCKS)
     * @return blockNumber Cache update blockNumber (block.number)
     */
    function getUserPermissionWithMeta(address user, bytes32 actionKey)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool hasPermission, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheUpdateBlocks[user];
        hasPermission = _userPermissionsCache[user][actionKey];
        isValid = _isCacheValid(blockNumber);
    }

    /**
     * @notice Query whether a user is an administrator, with cache validity and blockNumber
     *         (B-class cache unified output format).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized to read `user` (Scheme U; see {onlyAuthorizedFor})
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     *
     * @param user User address
     * @return isAdmin Whether the user is an administrator
     * @return isValid Whether the cache is valid (within CACHE_DURATION_BLOCKS)
     * @return blockNumber Cache update blockNumber (block.number)
     */
    function isUserAdminWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool isAdmin, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheUpdateBlocks[user];
        isAdmin = _userPermissionsCache[user][ActionKeys.ACTION_ADMIN];
        isValid = _isCacheValid(blockNumber);
    }

    /**
     * @notice Query a user's permission level, with cache validity and blockNumber
     *         (B-class cache unified output format).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized to read `user` (Scheme U; see {onlyAuthorizedFor})
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     *
     * @param user User address
     * @return level Permission level (PermissionLevel enum)
     * @return isValid Whether the cache is valid (within CACHE_DURATION_BLOCKS)
     * @return blockNumber Cache update blockNumber (block.number)
     */
    function getUserPermissionLevelWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (IAccessControlManager.PermissionLevel level, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheUpdateBlocks[user];
        level = _userPermissionLevelCache[user];
        isValid = _isCacheValid(blockNumber);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _getACM() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    function _isCacheValid(uint256 updateBlock) internal view returns (bool) {
        if (updateBlock == 0 || updateBlock > block.number) return false;
        return block.number - updateBlock <= _CACHE_DURATION_BLOCKS;
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade (internal, called by upgradeTo/upgradeToAndCall).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN role (MissingRole via ACM)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - onlyValidRegistry modifier
     * - ACTION_ADMIN role-gated via ACM
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /**
     * @notice Get Registry contract address (legacy getter for backward compatibility).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function registryAddr() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get the API semantic version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return apiVersion_ API semantic version
     */
    function apiVersion() public pure override returns (uint256 apiVersion_) {
        return 1;
    }

    /**
     * @notice Get the output/schema version for this module's cached data.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return schemaVersion_ Schema version
     */
    function schemaVersion() public pure override returns (uint256 schemaVersion_) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
} 