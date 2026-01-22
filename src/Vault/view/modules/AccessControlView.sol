// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";

/**
 * @title AccessControlView
 * @notice Permission view cache module: caches user permission bits and permission levels for frontend 0-gas queries.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller is not authorized (AccessControlView__UnauthorizedAccess)
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
     * @param timestamp Cache update timestamp (seconds since epoch)
     */
    event PermissionDataUpdated(
        address indexed user,
        bytes32 indexed actionKey,
        bool hasPermission,
        uint256 timestamp
    );

    /**
     * @notice Emitted when a user's permission level is cached.
     * @param user Target user address
     * @param newLevel New permission level (IAccessControlManager.PermissionLevel)
     * @param timestamp Cache update timestamp (seconds since epoch)
     */
    event PermissionLevelUpdated(
        address indexed user,
        IAccessControlManager.PermissionLevel newLevel,
        uint256 timestamp
    );

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Caller is not authorized to perform the requested read.
    error AccessControlView__UnauthorizedAccess();

    /// @notice Caller must be the AccessControlManager module.
    error AccessControlView__OnlyACM();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /// @dev User permission bit cache: user => actionKey => bool.
    mapping(address => mapping(bytes32 => bool)) private _userPermissionsCache;

    /// @dev User permission level cache.
    mapping(address => IAccessControlManager.PermissionLevel) private _userPermissionLevelCache;

    /// @dev Last cache update timestamp (seconds since epoch).
    mapping(address => uint256) private _cacheTimestamps;

    uint256 private constant _CACHE_DURATION = ViewConstants.CACHE_DURATION;

    /*━━━━━━━━━━━━━━━ Access helpers ━━━━━━━━━━━━━━━*/

    function _getUserPermission(address user) internal view returns (IAccessControlManager.PermissionLevel) {
        return IAccessControlManager(_getACM()).getUserPermission(user);
    }

    /// @dev Only allows caller if they are the target user or have ADMIN permission level.
    modifier onlyAuthorizedFor(address targetUser) {
        IAccessControlManager.PermissionLevel level = _getUserPermission(msg.sender);
        if (level < IAccessControlManager.PermissionLevel.ADMIN && msg.sender != targetUser) {
            revert AccessControlView__UnauthorizedAccess();
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
        // solhint-disable-next-line not-rely-on-time
        uint256 timestamp = block.timestamp;
        _cacheTimestamps[user] = timestamp;
        emit PermissionDataUpdated(user, actionKey, hasPermission, timestamp);
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
        // solhint-disable-next-line not-rely-on-time
        uint256 timestamp = block.timestamp;
        _cacheTimestamps[user] = timestamp;
        emit PermissionLevelUpdated(user, newLevel, timestamp);
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
     * @notice Query whether a user has a specific permission bit.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ADMIN permission level (AccessControlView__UnauthorizedAccess)
     *
     * Security:
     * - onlyAuthorizedFor modifier (only target user or ADMIN can query)
     *
     * @param user User address
     * @param actionKey Action key (bytes32)
     * @return hasPermission Whether the user has the permission
     * @return isValid Whether the cache is valid (within CACHE_DURATION)
     */
    function getUserPermission(
        address user,
        bytes32 actionKey
    ) external view onlyValidRegistry onlyAuthorizedFor(user) returns (bool hasPermission, bool isValid) {
        hasPermission = _userPermissionsCache[user][actionKey];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }

    /**
     * @notice Query whether a user has a specific permission bit, with cache validity and timestamp
     *         (B-class cache unified output format).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ADMIN permission level (AccessControlView__UnauthorizedAccess)
     *
     * Security:
     * - onlyAuthorizedFor modifier (only target user or ADMIN can query)
     *
     * @param user User address
     * @param actionKey Action key (bytes32)
     * @return hasPermission Whether the user has the permission
     * @return isValid Whether the cache is valid (within CACHE_DURATION)
     * @return timestamp Cache update timestamp (seconds since epoch)
     */
    function getUserPermissionWithMeta(address user, bytes32 actionKey)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool hasPermission, bool isValid, uint256 timestamp)
    {
        timestamp = _cacheTimestamps[user];
        hasPermission = _userPermissionsCache[user][actionKey];
        isValid = _isCacheValid(timestamp);
    }

    /**
     * @notice Query whether a user is an administrator.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ADMIN permission level (AccessControlView__UnauthorizedAccess)
     *
     * Security:
     * - onlyAuthorizedFor modifier (only target user or ADMIN can query)
     *
     * @param user User address
     * @return isAdmin Whether the user is an administrator
     * @return isValid Whether the cache is valid (within CACHE_DURATION)
     */
    function isUserAdmin(
        address user
    ) external view onlyValidRegistry onlyAuthorizedFor(user) returns (bool isAdmin, bool isValid) {
        isAdmin = _userPermissionsCache[user][ActionKeys.ACTION_ADMIN];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }

    /**
     * @notice Query whether a user is an administrator, with cache validity and timestamp
     *         (B-class cache unified output format).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ADMIN permission level (AccessControlView__UnauthorizedAccess)
     *
     * Security:
     * - onlyAuthorizedFor modifier (only target user or ADMIN can query)
     *
     * @param user User address
     * @return isAdmin Whether the user is an administrator
     * @return isValid Whether the cache is valid (within CACHE_DURATION)
     * @return timestamp Cache update timestamp (seconds since epoch)
     */
    function isUserAdminWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool isAdmin, bool isValid, uint256 timestamp)
    {
        timestamp = _cacheTimestamps[user];
        isAdmin = _userPermissionsCache[user][ActionKeys.ACTION_ADMIN];
        isValid = _isCacheValid(timestamp);
    }

    /**
     * @notice Query a user's permission level.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ADMIN permission level (AccessControlView__UnauthorizedAccess)
     *
     * Security:
     * - onlyAuthorizedFor modifier (only target user or ADMIN can query)
     *
     * @param user User address
     * @return level Permission level (PermissionLevel enum)
     * @return isValid Whether the cache is valid (within CACHE_DURATION)
     */
    function getUserPermissionLevel(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (IAccessControlManager.PermissionLevel level, bool isValid)
    {
        level   = _userPermissionLevelCache[user];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }

    /**
     * @notice Query a user's permission level, with cache validity and timestamp
     *         (B-class cache unified output format).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ADMIN permission level (AccessControlView__UnauthorizedAccess)
     *
     * Security:
     * - onlyAuthorizedFor modifier (only target user or ADMIN can query)
     *
     * @param user User address
     * @return level Permission level (PermissionLevel enum)
     * @return isValid Whether the cache is valid (within CACHE_DURATION)
     * @return timestamp Cache update timestamp (seconds since epoch)
     */
    function getUserPermissionLevelWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (IAccessControlManager.PermissionLevel level, bool isValid, uint256 timestamp)
    {
        timestamp = _cacheTimestamps[user];
        level = _userPermissionLevelCache[user];
        isValid = _isCacheValid(timestamp);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _getACM() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    function _isCacheValid(uint256 timestamp) internal view returns (bool) {
        // solhint-disable-next-line not-rely-on-time
        return timestamp > 0 && block.timestamp - timestamp <= _CACHE_DURATION;
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
        IAccessControlManager(_getACM()).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
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