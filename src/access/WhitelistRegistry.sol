// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {IWhitelistRegistry} from "../interfaces/IWhitelistRegistry.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";
import {NotAContract, ZeroAddress} from "../errors/StandardErrors.sol";
import {Registry} from "../registry/Registry.sol";

/**
 * @title WhitelistRegistry
 * @notice Provide the centralized account whitelist registry used by live deployment and integration flows.
 * @dev Reverts if:
 *      - initialization or registry updates receive a zero or non-contract registry address (ZeroAddress / NotAContract)
 *      - write paths are called without the required ActionKeys permission resolved from Registry (propagates from ACM)
 *      - add/remove operations receive zero addresses or invalid whitelist state transitions
 *      - batch write paths receive an empty input array (WhitelistRegistry__EmptyAccountsArray)
 *
 * Security:
 * - Registry is the SSOT for resolving AccessControlManager; this contract does not hardcode privileged operators.
 * - Address add/remove writes are role-gated through ACTION_ADD_WHITELIST and ACTION_REMOVE_WHITELIST.
 * - Upgrade authorization is gated through ACTION_UPGRADE_MODULE and follows the protocol's Registry-based governance path.
 * - Read functions are side-effect free and return the in-memory whitelist state tracked by this module.
 *
 * @custom:security-contact security@example.com
 */
contract WhitelistRegistry is
    Initializable,
    UUPSUpgradeable,
    IWhitelistRegistry
{
    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when attempting to add an account that is already whitelisted.
    error WhitelistRegistry__AlreadyWhitelisted(address account);

    /// @dev Reverts when attempting to remove an account that is not currently whitelisted.
    error WhitelistRegistry__NotWhitelisted(address account);

    /// @dev Reverts when a batch add/remove operation receives an empty account list.
    error WhitelistRegistry__EmptyAccountsArray();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry address used to resolve protocol modules and permissions.
    address private _registryAddr;

    /// @notice O(1) membership lookup for the centralized account whitelist.
    mapping(address => bool) private _whitelist;

    /// @notice Dense list of whitelisted accounts for enumeration.
    address[] private _accounts;

    /// @notice O(1) index lookup into `_accounts` for swap-and-pop removals.
    mapping(address => uint256) private _accountIndex;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a single account is added to the whitelist.
    /// @dev `operator` is the authorized caller that performed the mutation.
    event AddressAdded(
        address indexed account,
        address indexed operator,
        uint256 blockNumber
    );

    /// @notice Emitted when a single account is removed from the whitelist.
    /// @dev `operator` is the authorized caller that performed the mutation.
    event AddressRemoved(
        address indexed account,
        address indexed operator,
        uint256 blockNumber
    );

    /// @notice Emitted when a batch add operation completes.
    /// @dev `addedCount` may be lower than `accounts.length` because already-whitelisted entries are skipped.
    event AddressesBatchAdded(
        address[] accounts,
        address indexed operator,
        uint256 addedCount,
        uint256 blockNumber
    );

    /// @notice Emitted when a batch remove operation completes.
    /// @dev `removedCount` may be lower than `accounts.length` because non-whitelisted entries are skipped.
    event AddressesBatchRemoved(
        address[] accounts,
        address indexed operator,
        uint256 removedCount,
        uint256 blockNumber
    );

    /// @notice Emitted when the Registry dependency is updated.
    /// @dev This updates the module-resolution SSOT used for future permission checks.
    event RegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry,
        address indexed operator,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @dev Ensures the stored Registry address is set and still points to contract code.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the whitelist registry with the protocol Registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is the zero address (ZeroAddress)
     *      - `initialRegistryAddr` has no code (NotAContract)
     *      - the proxy has already been initialized (propagates from Initializable)
     *
     * Security:
     * - Single-use initializer for the proxy instance.
     * - Sets the Registry dependency that will be used as the SSOT for all future role checks.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();

        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        _registryAddr = initialRegistryAddr;

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ External View Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return whether `account` is currently present in the centralized whitelist.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only membership probe.
     * - Returns `false` for unknown accounts rather than reverting.
     *
     * @param account Address being checked.
     * @return whitelisted Whether `account` is currently whitelisted.
     */
    function isWhitelisted(
        address account
    ) external view override returns (bool whitelisted) {
        return _whitelist[account];
    }

    /**
     * @notice Return the Registry address currently used for dependency resolution.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only metadata helper.
     *
     * @return registryAddr Registry contract address.
     */
    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /**
     * @notice Return the full list of whitelisted accounts.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only enumeration helper.
     * - Returned ordering follows the internal swap-and-pop storage list and is not insertion-stable.
     *
     * @return accounts Current whitelist snapshot.
     */
    function getWhitelistedAccounts()
        external
        view
        returns (address[] memory accounts)
    {
        return _accounts;
    }

    /**
     * @notice Return the number of currently whitelisted accounts.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only count helper.
     *
     * @return count Current whitelist size.
     */
    function getWhitelistedCount() external view returns (uint256 count) {
        return _accounts.length;
    }

    /*━━━━━━━━━━━━━━━ External Admin Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Add a single account to the centralized whitelist.
     * @dev Reverts if:
     *      - Registry is unset or no longer points to contract code (ZeroAddress / NotAContract)
     *      - Registry is missing KEY_ACCESS_CONTROL (propagates from Registry.getModuleOrRevert)
     *      - caller lacks ACTION_ADD_WHITELIST (propagates from ACM.requireRole)
     *      - `account` is the zero address (ZeroAddress)
     *      - `account` is already whitelisted (WhitelistRegistry__AlreadyWhitelisted)
     *
     * Security:
     * - Role-gated write path using ACTION_ADD_WHITELIST.
     * - Updates both the membership map and the enumerable account set.
     *
     * @param account Account address to whitelist.
     */
    function addAddress(address account) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (account == address(0)) revert ZeroAddress();
        if (_whitelist[account])
            revert WhitelistRegistry__AlreadyWhitelisted(account);

        _whitelist[account] = true;
        _accountIndex[account] = _accounts.length;
        _accounts.push(account);

        uint256 blockNumber = block.number;
        emit AddressAdded(account, msg.sender, blockNumber);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Remove a single account from the centralized whitelist.
     * @dev Reverts if:
     *      - Registry is unset or no longer points to contract code (ZeroAddress / NotAContract)
     *      - Registry is missing KEY_ACCESS_CONTROL (propagates from Registry.getModuleOrRevert)
     *      - caller lacks ACTION_REMOVE_WHITELIST (propagates from ACM.requireRole)
     *      - `account` is the zero address (ZeroAddress)
     *      - `account` is not currently whitelisted (WhitelistRegistry__NotWhitelisted)
     *
     * Security:
     * - Role-gated write path using ACTION_REMOVE_WHITELIST.
     * - Uses swap-and-pop to keep the enumerable account set dense.
     *
     * @param account Account address to remove.
     */
    function removeAddress(address account) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (account == address(0)) revert ZeroAddress();
        if (!_whitelist[account])
            revert WhitelistRegistry__NotWhitelisted(account);

        delete _whitelist[account];

        uint256 index = _accountIndex[account];
        uint256 lastIndex = _accounts.length - 1;
        if (index != lastIndex) {
            address lastAccount = _accounts[lastIndex];
            _accounts[index] = lastAccount;
            _accountIndex[lastAccount] = index;
        }
        _accounts.pop();
        delete _accountIndex[account];

        uint256 blockNumber = block.number;
        emit AddressRemoved(account, msg.sender, blockNumber);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Add multiple accounts to the centralized whitelist.
     * @dev Reverts if:
     *      - Registry is unset or no longer points to contract code (ZeroAddress / NotAContract)
     *      - Registry is missing KEY_ACCESS_CONTROL (propagates from Registry.getModuleOrRevert)
     *      - caller lacks ACTION_ADD_WHITELIST (propagates from ACM.requireRole)
     *      - `accounts` is empty (WhitelistRegistry__EmptyAccountsArray)
     *      - any entry in `accounts` is the zero address (ZeroAddress)
     *
     * Security:
     * - Role-gated batch write path using ACTION_ADD_WHITELIST.
     * - Already-whitelisted accounts are skipped rather than reverting the batch.
     *
     * @param accounts Account addresses to add.
     */
    function batchAddAddresses(
        address[] calldata accounts
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (accounts.length == 0)
            revert WhitelistRegistry__EmptyAccountsArray();

        uint256 addedCount = 0;
        for (uint256 i = 0; i < accounts.length; ++i) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (_whitelist[account]) continue;
            _whitelist[account] = true;
            _accountIndex[account] = _accounts.length;
            _accounts.push(account);
            addedCount++;
        }

        uint256 blockNumber = block.number;
        emit AddressesBatchAdded(accounts, msg.sender, addedCount, blockNumber);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Remove multiple accounts from the centralized whitelist.
     * @dev Reverts if:
     *      - Registry is unset or no longer points to contract code (ZeroAddress / NotAContract)
     *      - Registry is missing KEY_ACCESS_CONTROL (propagates from Registry.getModuleOrRevert)
     *      - caller lacks ACTION_REMOVE_WHITELIST (propagates from ACM.requireRole)
     *      - `accounts` is empty (WhitelistRegistry__EmptyAccountsArray)
     *      - any entry in `accounts` is the zero address (ZeroAddress)
     *
     * Security:
     * - Role-gated batch write path using ACTION_REMOVE_WHITELIST.
     * - Non-whitelisted accounts are skipped rather than reverting the batch.
     *
     * @param accounts Account addresses to remove.
     */
    function batchRemoveAddresses(
        address[] calldata accounts
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (accounts.length == 0)
            revert WhitelistRegistry__EmptyAccountsArray();

        uint256 removedCount = 0;
        for (uint256 i = 0; i < accounts.length; ++i) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (!_whitelist[account]) continue;

            delete _whitelist[account];

            uint256 index = _accountIndex[account];
            uint256 lastIndex = _accounts.length - 1;
            if (index != lastIndex) {
                address lastAccount = _accounts[lastIndex];
                _accounts[index] = lastAccount;
                _accountIndex[lastAccount] = index;
            }
            _accounts.pop();
            delete _accountIndex[account];
            removedCount++;
        }

        uint256 blockNumber = block.number;
        emit AddressesBatchRemoved(
            accounts,
            msg.sender,
            removedCount,
            blockNumber
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Update the Registry address used for permission resolution and module lookups.
     * @dev Reverts if:
     *      - current Registry is unset or no longer points to contract code (ZeroAddress / NotAContract)
     *      - current Registry is missing KEY_ACCESS_CONTROL (propagates from Registry.getModuleOrRevert)
     *      - caller lacks ACTION_SET_PARAMETER (propagates from ACM.requireRole)
     *      - `newRegistryAddr` is the zero address (ZeroAddress)
     *      - `newRegistryAddr` has no code (NotAContract)
     *
     * Security:
     * - Governance-sensitive write path using ACTION_SET_PARAMETER.
     * - Updates the dependency-resolution SSOT for all future authorization checks.
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

        uint256 blockNumber = block.number;
        emit RegistryUpdated(
            oldRegistry,
            newRegistryAddr,
            msg.sender,
            blockNumber
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            blockNumber
        );
        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            blockNumber
        );
    }

    /*━━━━━━━━━━━━━━━ Internal Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Resolve AccessControlManager from Registry and require `actionKey` for `user`.
     * @dev Reverts if:
     *      - Registry is missing KEY_ACCESS_CONTROL (propagates from Registry.getModuleOrRevert)
     *      - resolved AccessControlManager rejects `user` for `actionKey` (propagates from ACM.requireRole)
     *
     * Security:
     * - Centralized authorization helper for all whitelist write and upgrade paths.
     * - Uses Registry as the only source of truth for ACM resolution.
     *
     * @param actionKey Action key required for the guarded path.
     * @param user Address being authorized.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /*━━━━━━━━━━━━━━━ Upgrade Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS implementation upgrade.
     * @dev Reverts if:
     *      - caller lacks ACTION_UPGRADE_MODULE (propagates from ACM.requireRole)
     *      - `newImplementation` is the zero address (ZeroAddress)
     *
     * Security:
     * - Upgrade authorization is Registry-routed through AccessControlManager.
     * - Emits a standardized ActionExecuted event before the upgrade proceeds.
     *
     * @param newImplementation Candidate implementation address.
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

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}
