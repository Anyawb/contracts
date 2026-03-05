// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { IOrderEngine } from "../../../interfaces/IOrderEngine.sol";
import { IOrderEngineViewAdapter } from "../../../interfaces/IOrderEngineViewAdapter.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/**
 * @title LendingEngineView
 * @notice Read-only view module for lending/order-engine data (0-gas queries).
 * @dev This module is decoupled from the core engine and resolves dependencies via Registry.
 *
 * Reverts if:
 * - registry is zero / not a contract (ZeroAddress / NotAContract)
 * - caller lacks required role for a gated read (MissingRole)
 *
 * Security:
 * - Read-only: this module does not perform business writes
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM)
 */
contract LendingEngineView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Gate for ops/system-level diagnostics reads.
    modifier onlyOps() {
        if (
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /// @dev Gate for user-scoped reads (caller must be the user, or have VIEW_USER_DATA / ADMIN).
    modifier onlyAuthorizedUser(address user) {
        if (
            msg.sender != user && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LendingEngineView (UUPS).
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

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a loan order snapshot for off-chain display.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized to view the order (MissingRole)
     *
     * Security:
     * - Read-only
     *
     * @param orderId Engine order identifier
     * @return order Loan order struct snapshot (see IOrderEngine.LoanOrder)
     */
    function getLoanOrder(uint256 orderId)
        external
        view
        onlyValidRegistry
        returns (IOrderEngine.LoanOrder memory order)
    {
        // Permission alignment: allow borrower/lender access, or ops/admin (VIEW_USER_DATA / ADMIN).
        bool isOps = ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
            || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);

        // Treat adapter as a data source; enforce borrower/lender access at the view boundary.
        order = _engine().getLoanOrderForView(orderId);
        bool isBorrower = order.borrower != address(0) && msg.sender == order.borrower;
        bool isLender = order.lender != address(0) && msg.sender == order.lender;
        if (!isOps && !isBorrower && !isLender) revert MissingRole();
        return order;
    }

    /**
     * @notice Get the accumulated failed fee amount for an order (ops diagnostics).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @param orderId Engine order identifier
     * @return feeAmount Failed fee amount (engine-defined units/decimals)
     */
    function getFailedFeeAmount(uint256 orderId)
        external
        view
        onlyValidRegistry
        onlyOps
        returns (uint256 feeAmount)
    {
        return _engine().getFailedFeeAmountForView(orderId);
    }

    /**
     * @notice Get the NFT mint retry count for an order (ops diagnostics).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @param orderId Engine order identifier
     * @return retryCount Retry count
     */
    function getNftRetryCount(uint256 orderId)
        external
        view
        onlyValidRegistry
        onlyOps
        returns (uint256 retryCount)
    {
        return _engine().getNftRetryCountForView(orderId);
    }

    /**
     * @notice Check whether a user can access a given loan order, with metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyAuthorizedUser)
     *
     * Security:
     * - Read-only
     *
     * @param orderId Engine order identifier
     * @param user Target user address
     * @return hasAccess Whether the user is allowed to view the order
     * @return isValid Whether the read succeeded
     * @return blockNumber Read block number (block.number)
     */
    function canAccessLoanOrder(uint256 orderId, address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(user)
        returns (bool hasAccess, bool isValid, uint256 blockNumber)
    {
        if (user == address(0)) return (false, true, _now());
        IOrderEngine.LoanOrder memory order = _engine().getLoanOrderForView(orderId);
        hasAccess = (order.borrower != address(0) && user == order.borrower)
            || (order.lender != address(0) && user == order.lender);
        return (hasAccess, true, _now());
    }

    /**
     * @notice Check whether an account is the match engine (ops diagnostics).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @param account Account address to check
     * @return isMatch Whether the account is the match engine
     */
    function isMatchEngine(address account)
        external
        view
        onlyValidRegistry
        onlyOps
        returns (bool isMatch)
    {
        return _engine().isMatchEngineForView(account);
    }

    /**
     * @notice Convenience helper to read the Registry address from the underlying engine adapter (ops only).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @return registry Registry contract address as reported by the engine adapter
     */
    function getRegistryFromEngine()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (address registry)
    {
        return _engine().getRegistryForView();
    }

    /**
     * @notice Get the Registry contract address.
     * @dev This getter may return address(0) if the contract is not initialized.
     *
     * Security:
     * - Read-only
     *
     * @return registryAddrVar Registry contract address
     */
    function getRegistry() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /**
     * @notice Get the Registry contract address (legacy getter).
     * @dev This function is kept for backward compatibility; prefer `getRegistry()`.
     *
     * Security:
     * - Read-only
     *
     * @return registryAddrVar Registry contract address
     */
    function registryAddr() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

    function _engine() internal view returns (IOrderEngineViewAdapter) {
        address engineAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        return IOrderEngineViewAdapter(engineAddr);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}
