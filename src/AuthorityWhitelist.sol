// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IAuthorityWhitelist} from "./interfaces/IAuthorityWhitelist.sol";
import {IAccessControlManager} from "./interfaces/IAccessControlManager.sol";
import {ActionKeys} from "./constants/ActionKeys.sol";
import {ModuleKeys} from "./constants/ModuleKeys.sol";
import {SystemEvents} from "./Vault/SystemEvents.sol";
import {NotAContract, ZeroAddress} from "./errors/StandardErrors.sol";
import {Registry} from "./registry/Registry.sol";

/*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

/// @dev Reverts when attempting to remove an authority that is not currently whitelisted.
error AuthorityWhitelist__AuthorityNotExisted();

/// @dev Reverts when attempting to add an authority that is already whitelisted.
error AuthorityWhitelist__AlreadyExists();

/**
 * @title AuthorityWhitelist
 * @notice Authority-subject whitelist for managing approved authority names.
 * @dev Reverts if:
 *      - Registry is unset or invalid when a Registry-dependent path is invoked (ZeroAddress / NotAContract)
 *      - caller lacks the required governance role for whitelist administration or upgrades (via ACM)
 *      - duplicate add or missing remove operations are attempted (AuthorityWhitelist__AlreadyExists / AuthorityWhitelist__AuthorityNotExisted)
 *
 * Security:
 * - UUPS upgradeable contract with governance-gated administration through ACM ActionKeys.
 * - Stores only authority-name membership and does not act as a generic address registry.
 * - Read-side integrations should prefer the dedicated whitelist read interfaces.
 *
 * @custom:security-contact security@example.com
 */
contract AuthorityWhitelist is
    Initializable,
    UUPSUpgradeable,
    IAuthorityWhitelist
{
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @dev Authority-name membership keyed by `keccak256(bytes(name))`.
    mapping(bytes32 => bool) private _whitelist;

    /// @notice Registry contract address used for ACM resolution and governance controls.
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @notice Ensure the Registry address is configured and points to a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when an authority name is added to the whitelist.
    /// @dev Event only.
    event AuthorityAdded(string name, address indexed operator);

    /// @notice Emitted when an authority name is removed from the whitelist.
    /// @dev Event only.
    event AuthorityRemoved(string name, address indexed operator);

    /// @notice Emitted when the whitelist updates the Registry dependency it uses.
    /// @dev Event only.
    event RegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the authority whitelist with the authoritative Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *      - initializer is invoked more than once
     *
     * Security:
     * - Initializer: callable once.
     * - Seeds a small default authority set for bootstrap compatibility.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();

        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        _registryAddr = initialRegistryAddr;

        // Seed common authority names for bootstrap compatibility.
        _add("Moody's");
        _add("Standard Chartered");
        _add("S&P Global");
        _add("Fitch Ratings");

        // Emit a standardized governance action for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ External Admin ━━━━━━━━━━━━━━━*/

    /**
     * @notice Add an authority name to the whitelist.
     * @dev Reverts if:
     *      - Registry is unset or invalid (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADD_WHITELIST (via ACM)
     *      - `name` is already whitelisted (AuthorityWhitelist__AlreadyExists)
     *
     * Security:
     * - Role-gated via ACTION_ADD_WHITELIST.
     * - Emits both a domain event and a standardized ActionExecuted event.
     *
     * @param name Authority name. Matching is case-sensitive.
     */
    function addAuthority(string calldata name) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        _add(name);

        // Emit a standardized governance action for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Remove an authority name from the whitelist.
     * @dev Reverts if:
     *      - Registry is unset or invalid (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_REMOVE_WHITELIST (via ACM)
     *      - `name` is not currently whitelisted (AuthorityWhitelist__AuthorityNotExisted)
     *
     * Security:
     * - Role-gated via ACTION_REMOVE_WHITELIST.
     * - Emits both a domain event and a standardized ActionExecuted event.
     *
     * @param name Authority name. Matching is case-sensitive.
     */
    function removeAuthority(string calldata name) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        bytes32 key = keccak256(bytes(name));
        if (!_whitelist[key]) revert AuthorityWhitelist__AuthorityNotExisted();
        _whitelist[key] = false;
        emit AuthorityRemoved(name, msg.sender);

        // Emit a standardized governance action for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ View ━━━━━━━━━━━━━━━*/

    /**
     * @notice Check whether an authority name is whitelisted.
     * @dev Reverts if:
     *      - Registry is unset or invalid (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - View-only read.
     *
     * @param name Authority name. Matching is case-sensitive.
     * @return existed True if `name` is currently whitelisted.
     */
    function check(
        string calldata name
    ) external view override onlyValidRegistry returns (bool) {
        return _whitelist[keccak256(bytes(name))];
    }

    /**
     * @notice Return the Registry address through the admin-gated accessor.
     * @dev Reverts if:
     *      - Registry is unset or invalid (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (via ACM)
     *
     * Security:
     * - View-only read.
     * - Role-gated via ACTION_ADMIN.
     *
     * @return registryAddr_ Registry contract address.
     */
    function getRegistry() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _registryAddr;
    }

    /**
     * @notice Update the Registry address used by this whitelist.
     * @dev Reverts if:
     *      - Registry is unset or invalid (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (via ACM)
     *      - newRegistryAddr == address(0) (ZeroAddress)
     *      - newRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated via ACTION_SET_PARAMETER.
     * - Emits standardized governance and registry-update events.
     *
     * @param newRegistryAddr New Registry contract address.
     */
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0)
            revert NotAContract(newRegistryAddr);

        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;

        // Emit a standardized governance action for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );

        emit RegistryUpdated(oldRegistry, newRegistryAddr);
    }

    /*━━━━━━━━━━━━━━━ Internal Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Resolve ACM from Registry and require that `user` has `actionKey`.
     * @dev Reverts if Registry or ACM resolution fails, or if the role check fails.
     * @param actionKey Action key.
     * @param user User address to check.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice Add an authority name to storage without external permission checks.
     * @dev Reverts if `name` is already whitelisted.
     * @param name Authority name. Matching is case-sensitive.
     */
    function _add(string memory name) internal {
        bytes32 key = keccak256(bytes(name));
        if (_whitelist[key]) revert AuthorityWhitelist__AlreadyExists();
        _whitelist[key] = true;
        emit AuthorityAdded(name, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ Upgrade Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM)
     *      - newImplementation == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACTION_UPGRADE_MODULE.
     * - Emits a standardized governance action event.
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();

        // Emit a standardized governance action for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/

    /// @dev Storage gap reserved for upgrade safety.
    uint256[50] private __gap;
}
