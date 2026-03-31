// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {Registry} from "../registry/Registry.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {
    ZeroAddress,
    NotAContract,
    InvalidCaller
} from "../errors/StandardErrors.sol";

/// @title AICreditsVault
/// @notice AI credits on-chain balance SSOT : buy credits + batch settle
/// deductions.
/// @dev Per docs/Usage-Guide/AI-Credits-Billing-Guide.md:
///      - High-frequency per-request charging is OFF-CHAIN (usage ledger).
///      - On-chain only tracks auditable creditsBalance and batch
/// settlements.
contract AICreditsVault is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    address private _registryAddr;

    /// @dev credits are natural numbers: 1 = 1 AI call.
    mapping(bytes32 tenantId => mapping(address user => uint256 credits))
        private _creditsBalance;

    /// @dev Purchase/exchange idempotency: (tenantId,user,clientOrderId) can only apply once.
    mapping(bytes32 tenantId => mapping(address user => mapping(bytes32 clientOrderId => bool used)))
        private _usedClientOrderId;

    /// @dev Settlement idempotency: each settlementBatchId can only apply once.
    mapping(bytes32 settlementBatchId => bool applied)
        private _appliedSettlementBatch;

    /// @dev Price per 1 credit, per payment token, in token smallest units (e.g. USDC 6 decimals).
    mapping(address payToken => uint256 pricePerCredit) private _pricePerCredit;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a user purchases credits with an approved payment token.
    /// @dev Emitted after payment transfer succeeds and the buyer balance is incremented.
    event CreditsPurchased(
        bytes32 indexed tenantId,
        address indexed buyer,
        address indexed payToken,
        uint256 payAmount,
        uint256 credits,
        bytes32 clientOrderId,
        uint256 blockNumber
    );

    /// @notice Emitted when an operator settles a batch of offchain credit deductions.
    /// @dev `merkleRoot` is an informational audit anchor for the offchain settlement payload.
    event CreditsSettled(
        bytes32 indexed tenantId,
        bytes32 indexed settlementBatchId,
        uint256 userCount,
        uint256 totalCredits,
        bytes32 merkleRoot,
        uint256 blockNumber
    );

    /// @notice Emitted for each user balance deduction inside a settlement batch.
    event CreditsDeducted(
        bytes32 indexed tenantId,
        address indexed user,
        uint256 credits,
        bytes32 settlementBatchId
    );

    /// @notice Emitted when governance updates the token-denominated price of one credit.
    event PricePerCreditUpdated(
        address indexed payToken,
        uint256 oldPricePerCredit,
        uint256 newPricePerCredit
    );

    /*━━━━━━━━━━━━━━━ Initialization ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the vault with the Registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero (see {ZeroAddress})
     *      - `initialRegistryAddr` has no code (see {NotAContract})
     *
     * Security:
     * - Single-use initializer for the UUPS proxy instance
     *
     * @param initialRegistryAddr Registry contract address used to resolve AccessControlManager.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━━━*/

    /// @notice Returns the current Registry address used by the vault.
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice Returns the stored credit balance for `user` within `tenantId`.
    function creditsBalance(
        bytes32 tenantId,
        address user
    ) external view returns (uint256) {
        return _creditsBalance[tenantId][user];
    }

    /// @notice Returns the configured token-denominated price for one credit.
    function pricePerCredit(address payToken) external view returns (uint256) {
        return _pricePerCredit[payToken];
    }

    /// @notice Returns whether a client order id has already been consumed for a tenant/user pair.
    function isClientOrderIdUsed(
        bytes32 tenantId,
        address user,
        bytes32 clientOrderId
    ) external view returns (bool) {
        return _usedClientOrderId[tenantId][user][clientOrderId];
    }

    /// @notice Returns whether a settlement batch id has already been applied.
    function isSettlementBatchApplied(
        bytes32 settlementBatchId
    ) external view returns (bool) {
        return _appliedSettlementBatch[settlementBatchId];
    }

    /*━━━━━━━━━━━━━━━ Admin / Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates the Registry address used for permission resolution.
     * @dev Reverts if:
     *      - caller lacks `ACTION_ADMIN`
     *      - `newRegistryAddr` is zero (see {ZeroAddress})
     *      - `newRegistryAddr` has no code (see {NotAContract})
     *
     * Security:
     * - Role-gated through AccessControlManager resolved from the current Registry
     *
     * @param newRegistryAddr New Registry address.
     */
    function setRegistry(address newRegistryAddr) external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0)
            revert NotAContract(newRegistryAddr);
        _registryAddr = newRegistryAddr;
    }

    /**
     * @notice Sets the token-denominated price of one credit.
     * @dev Reverts if:
     *      - caller lacks `ACTION_SET_PARAMETER`
     *      - `payToken` is zero (see {ZeroAddress})
     *
     * Security:
     * - Role-gated parameter write
     * - Non-reentrant even though the function does not transfer tokens today, to preserve a conservative admin path
     *
     * @param payToken ERC-20 payment token.
     * @param newPricePerCredit Price per credit in the payment token smallest unit.
     */
    function setPricePerCredit(
        address payToken,
        uint256 newPricePerCredit
    ) external nonReentrant {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (payToken == address(0)) revert ZeroAddress();
        uint256 old = _pricePerCredit[payToken];
        _pricePerCredit[payToken] = newPricePerCredit;
        emit PricePerCreditUpdated(payToken, old, newPricePerCredit);
    }

    /*━━━━━━━━━━━━━━━ Core: Buy credits (on-chain) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Purchases credits for the caller using an exact token payment.
     * @dev Reverts if:
     *      - `payToken` is zero (see {ZeroAddress})
     *      - `credits` is zero (see {InvalidCaller})
     *      - `clientOrderId` is zero or already used for `(tenantId, msg.sender)` (see {InvalidCaller})
     *      - no price is configured for `payToken` (see {InvalidCaller})
     *      - `payAmount` does not equal `credits * pricePerCredit(payToken)` (see {InvalidCaller})
     *      - token transfer fails in `safeTransferFrom`
     *
     * Security:
     * - Exact-payment check prevents client-side underpayment manipulation
     * - Idempotency is enforced through `(tenantId, user, clientOrderId)`
     * - Non-reentrant around token transfer + balance mutation
     *
     * @param tenantId Tenant identifier used to namespace balances and order ids.
     * @param payToken ERC-20 payment token.
     * @param payAmount Exact payment amount in token base units.
     * @param credits Number of credits to mint to the caller balance.
     * @param clientOrderId Client-provided idempotency key.
     */
    function buyCredits(
        bytes32 tenantId,
        address payToken,
        uint256 payAmount,
        uint256 credits,
        bytes32 clientOrderId
    ) external nonReentrant {
        if (payToken == address(0)) revert ZeroAddress();
        if (credits == 0) revert InvalidCaller();
        if (clientOrderId == bytes32(0)) revert InvalidCaller();

        if (_usedClientOrderId[tenantId][msg.sender][clientOrderId])
            revert InvalidCaller();
        _usedClientOrderId[tenantId][msg.sender][clientOrderId] = true;

        uint256 unitPrice = _pricePerCredit[payToken];
        if (unitPrice == 0) revert InvalidCaller();

        // Require exact payment to prevent client-side manipulation.
        if (payAmount != credits * unitPrice) revert InvalidCaller();

        IERC20(payToken).safeTransferFrom(msg.sender, address(this), payAmount);

        _creditsBalance[tenantId][msg.sender] += credits;

        emit CreditsPurchased(
            tenantId,
            msg.sender,
            payToken,
            payAmount,
            credits,
            clientOrderId,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Core: Batch settle deductions (operator) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Applies an operator-managed batch of credit deductions.
     * @dev Reverts if:
     *      - caller lacks `ACTION_SET_PARAMETER`
     *      - `settlementBatchId` is zero or already applied (see {InvalidCaller})
     *      - `users` is empty or length-mismatched with `creditsUsed` (see {InvalidCaller})
     *      - any user is zero (see {ZeroAddress})
     *      - any user balance is lower than the requested deduction (see {InvalidCaller})
     *
     * Security:
     * - Batch idempotency is enforced before iterating
     * - A zero `creditsUsed[i]` is treated as a no-op and does not revert
     * - The function assumes the offchain batch contents were validated before submission
     *
     * @param tenantId Tenant identifier whose balances are being settled.
     * @param settlementBatchId Unique settlement batch idempotency key.
     * @param merkleRoot Informational commitment to the offchain settlement payload.
     * @param users Users whose balances will be decremented.
     * @param creditsUsed Credits to deduct from each aligned user.
     */
    function settleBatch(
        bytes32 tenantId,
        bytes32 settlementBatchId,
        bytes32 merkleRoot,
        address[] calldata users,
        uint256[] calldata creditsUsed
    ) external nonReentrant {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (settlementBatchId == bytes32(0)) revert InvalidCaller();
        if (_appliedSettlementBatch[settlementBatchId]) revert InvalidCaller();
        if (users.length == 0 || users.length != creditsUsed.length)
            revert InvalidCaller();

        _appliedSettlementBatch[settlementBatchId] = true;

        uint256 total;
        for (uint256 i = 0; i < users.length; i++) {
            address u = users[i];
            uint256 used = creditsUsed[i];
            if (u == address(0)) revert ZeroAddress();
            if (used == 0) continue;
            uint256 bal = _creditsBalance[tenantId][u];
            if (bal < used) revert InvalidCaller();
            unchecked {
                _creditsBalance[tenantId][u] = bal - used;
                total += used;
            }
            emit CreditsDeducted(tenantId, u, used, settlementBatchId);
        }

        emit CreditsSettled(
            tenantId,
            settlementBatchId,
            users.length,
            total,
            merkleRoot,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Internal ━━━━━━━━━━━━━━━*/

    /// @dev Resolves AccessControlManager from Registry and enforces `actionKey` for `user`.
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @dev UUPS upgrade hook gated by `ACTION_UPGRADE_MODULE`.
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    uint256[50] private __gap;
}
