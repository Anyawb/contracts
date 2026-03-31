// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Registry} from "../../registry/Registry.sol";
import {ModuleKeys} from "../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../constants/ActionKeys.sol";
import {IAccessControlManager} from "../../interfaces/IAccessControlManager.sol";
import {ILenderPoolVault} from "../../interfaces/ILenderPoolVault.sol";
import {
    NotAContract,
    ZeroAddress,
    AmountIsZero
} from "../../errors/StandardErrors.sol";

/**
 * @title LenderPoolVault
 * @notice Custodies pooled lender liquidity used for settlement matching.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Implements a minimal custody plus restricted transferOut pattern.
 * - Anyone may deposit funds into the pool.
 * - Only the Registry-configured VaultBusinessLogic or BlocksOnlyCoordinator may transfer funds out for settlement.
 * - In the order engine, the lender field is expected to equal this pool address under the pool-based architecture.
 */
contract LenderPoolVault is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILenderPoolVault
{
    using SafeERC20 for IERC20;

    /// @notice Registry address for module resolution and access control.
    /// @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
    address private _registryAddr;

    /**
     * @notice Return the Registry address reference used by this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return registryAddr Registry address.
     */
    function registryAddrVar() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a caller is not an authorized settlement orchestrator module. Used by {transferOut}.
    error LenderPoolVault__OnlyAuthorizedSettlementModule();
    /// @dev Reverts when a UUPS upgrade target has no deployed code. Used by {_authorizeUpgrade}.
    error LenderPoolVault__InvalidImplementation();

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /// @notice Ensure Registry is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LenderPoolVault module.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - initializer (callable once)
     *
     * @param initialRegistryAddr Registry address used for module resolution and access control.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    /**
     * @notice Pause the vault (disables deposit/transferOut).
     * @dev Reverts if:
     *      - caller lacks ACTION_ADMIN (via ACM.requireRole)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_ADMIN)
     * - whenPaused / whenNotPaused is enforced on write entrypoints
     */
    function pause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _pause();
    }

    /**
     * @notice Unpause the vault (re-enables deposit/transferOut).
     * @dev Reverts if:
     *      - caller lacks ACTION_ADMIN (via ACM.requireRole)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_ADMIN)
     */
    function unpause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _unpause();
    }

    /**
     * @notice Deposit assets into the lender pool vault.
     * @dev Reverts if:
     *      - asset == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - ERC20 transferFrom fails
     *
     * Security:
     * - nonReentrant
     * - whenNotPaused
     *
     * @param asset ERC20 asset address.
     * @param amount Amount to deposit (token native decimals).
     */
    function deposit(
        address asset,
        uint256 amount
    ) external override whenNotPaused nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Transfers assets out of the pool vault for settlement orchestration.
     * @dev Reverts if:
     *      - asset == address(0) or to == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - caller is not VaultBusinessLogic or BlocksOnlyCoordinator resolved from Registry
     *        (LenderPoolVault__OnlyAuthorizedSettlementModule)
     *      - ERC20 transfer fails
     *
     * Security:
     * - nonReentrant
     * - whenNotPaused
     * - Caller-gated to VaultBusinessLogic or BlocksOnlyCoordinator as the Registry-bound settlement orchestrators.
     * - BlocksOnlyCoordinator access exists specifically for the blocks-only product's principal disbursement and
     *   repayment or maturity flows.
     *
     * @param asset ERC20 asset address.
     * @param to Recipient address.
     * @param amount Amount to transfer (token native decimals).
     */
    function transferOut(
        address asset,
        address to,
        uint256 amount
    ) external override onlyValidRegistry whenNotPaused nonReentrant {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        _requireSettlementOrchestrator(msg.sender);
        IERC20(asset).safeTransfer(to, amount);
    }

    /**
     * @notice Requires `caller` to be a Registry-authorized settlement orchestrator.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller is not KEY_VAULT_BUSINESS_LOGIC nor KEY_BLOCKS_ONLY_COORDINATOR
     *        (LenderPoolVault__OnlyAuthorizedSettlementModule)
     *
     * Security:
     * - View-only authorization helper.
     * - Keeps pool outflow authority anchored to Registry so blocks-only settlement cannot bypass module governance.
     *
     * @param caller Caller address to validate.
     */
    function _requireSettlementOrchestrator(
        address caller
    ) internal view onlyValidRegistry {
        address vbl = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_BUSINESS_LOGIC
        );
        address blocksOnlyCoordinator = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_BLOCKS_ONLY_COORDINATOR
        );
        if (caller != vbl && caller != blocksOnlyCoordinator) {
            revert LenderPoolVault__OnlyAuthorizedSettlementModule();
        }
    }

    /**
     * @notice Require an AccessControlManager role.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - KEY_ACCESS_CONTROL is not registered (propagated)
     *      - caller lacks the requested role (propagated)
     *
     * Security:
     * - View-only authorization helper.
     *
     * @param role Action key / role hash to require.
     * @param caller Caller address to validate.
     */
    function _requireRole(
        bytes32 role,
        address caller
    ) internal view onlyValidRegistry {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(role, caller);
    }

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - newImplementation == address(0) (ZeroAddress)
     *      - newImplementation has no deployed code (LenderPoolVault__InvalidImplementation)
     *      - caller lacks ACTION_UPGRADE_MODULE (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Validates that the target implementation is a deployed contract.
     *
     * @param newImplementation Proposed implementation address.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert LenderPoolVault__InvalidImplementation();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
