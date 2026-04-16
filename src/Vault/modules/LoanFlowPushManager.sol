// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {Registry} from "../../registry/Registry.sol";
import {ModuleKeys} from "../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../constants/ActionKeys.sol";
import {CacheEvents} from "../CacheEvents.sol";
import {AssetDecimalMath} from "../../libraries/AssetDecimalMath.sol";
import {IAccessControlManager} from "../../interfaces/IAccessControlManager.sol";
import {IPriceOracleRead} from "../../interfaces/IPriceOracleRead.sol";
import {
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../errors/StandardErrors.sol";

/// @title ILoanFlowViewMinimal
/// @notice Minimal write interface for LoanFlowView push operations.
/// @dev Used by {LoanFlowPushManager} to read versions and push flow deltas
///      without importing the full view implementation.
interface ILoanFlowViewMinimal {
    /// @notice Returns the current user loan-flow version expected by the pusher.
    function getUserLoanFlowVersionForPusher(
        address user
    ) external view returns (uint64);

    /// @notice Pushes one user loan-flow delta into LoanFlowView.
    function pushUserLoanFlowUpdate(
        address user,
        uint256 borrowDeltaValue,
        uint256 repayDeltaValue,
        uint64 borrowCountDelta,
        uint64 repayCountDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
}

/**
 * @title LoanFlowPushManager
 * @notice Pushes authoritative loan-flow deltas into LoanFlowView through best-effort paths.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Single on-chain entrypoint for LoanFlowView pushes.
 * - Uses KEY_PRICE_ORACLE as the asset-native valuation source of truth and normalizes
 *   cross-asset flow into the shared 18-decimal system valuation unit.
 * - Best-effort push failures emit CacheUpdateFailedWithContext and must not block ledger writes.
 * - Uses strict optimistic concurrency with nextVersion equal to current version plus one.
 * - This module is a view-cache orchestrator only and is not the SSOT for loan state.
 */
contract LoanFlowPushManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    CacheEvents
{
    uint8 private constant _SYSTEM_VALUATION_DECIMALS = 18;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LoanFlowPushManager (UUPS).
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
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Public Notify APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push a borrow delta into LoanFlowView after a loan-creation write.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller is not KEY_ORDER_ENGINE (MissingRole)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns without reverting the caller's broader flow.
     *
     * Security:
     * - Restricted to the order-engine source of truth via `_requireNotifier()`.
    * - Converts token-native debt amounts into the shared 18-decimal valuation unit before pushing.
     *
     * @param user Borrower address
     * @param asset Borrowed asset address
     * @param amountBaseUnits Borrow principal in base units (token decimals)
     * @param orderId Loan order id (used for deterministic requestId)
     */
    function notifyBorrow(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId
    ) external onlyValidRegistry nonReentrant {
        _requireNotifier(msg.sender);
        bytes32 requestId = _makeRequestIdBorrow(user, orderId);
        _pushLoanFlowDeltaBestEffort(
            user,
            asset,
            amountBaseUnits,
            true,
            requestId
        );
    }

    /**
     * @notice Push a repay delta into LoanFlowView after a repayment write.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller is not KEY_ORDER_ENGINE (MissingRole)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns without reverting the caller's broader flow.
     *
     * Security:
     * - Restricted to the order-engine source of truth via `_requireNotifier()`.
    * - Converts token-native debt amounts into the shared 18-decimal valuation unit before pushing.
     *
     * @param user Borrower address
     * @param asset Repaid asset address
     * @param amountBaseUnits Repay amount in base units (token decimals)
     * @param orderId Loan order id (used for deterministic requestId)
     * @param repaidAmountAfter Cumulative repaidAmount after applying this repay,
     *        sourced from OrderEngine state and used for uniqueness.
     */
    function notifyRepay(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external onlyValidRegistry nonReentrant {
        _requireNotifier(msg.sender);
        bytes32 requestId = _makeRequestIdRepay(
            user,
            orderId,
            repaidAmountAfter
        );
        _pushLoanFlowDeltaBestEffort(
            user,
            asset,
            amountBaseUnits,
            false,
            requestId
        );
    }

    /*━━━━━━━━━━━━━━━ Retry APIs (role-gated) ━━━━━━━━━━━━━━━*/

    /**
    * @notice Retry a borrow delta push by recomputing the normalized valuation delta and replaying the view update.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH (MissingRole)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns.
     *
     * Security:
     * - Retry entrypoint for keepers and off-chain repair services.
     */
    function retryBorrow(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId
    ) external onlyValidRegistry nonReentrant {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        bytes32 requestId = _makeRequestIdBorrow(user, orderId);
        _pushLoanFlowDeltaBestEffort(
            user,
            asset,
            amountBaseUnits,
            true,
            requestId
        );
    }

    /**
    * @notice Retry a repay delta push by recomputing the normalized valuation delta and replaying the view update.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH (MissingRole)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns.
     *
     * Security:
     * - Retry entrypoint for keepers and off-chain repair services.
     */
    function retryRepay(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external onlyValidRegistry nonReentrant {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        bytes32 requestId = _makeRequestIdRepay(
            user,
            orderId,
            repaidAmountAfter
        );
        _pushLoanFlowDeltaBestEffort(
            user,
            asset,
            amountBaseUnits,
            false,
            requestId
        );
    }

    /*━━━━━━━━━━━━━━━ Internal Conversion And Push ━━━━━━━━━━━━━━━*/

    function _pushLoanFlowDeltaBestEffort(
        address user,
        address asset,
        uint256 amountBaseUnits,
        bool isBorrow,
        bytes32 requestId
    ) internal {
        if (user == address(0) || asset == address(0)) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                address(0),
                0,
                0,
                abi.encode("user/asset=0"),
                0,
                0
            );
            return;
        }
        if (amountBaseUnits == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                address(0),
                0,
                0,
                abi.encode("amount=0"),
                0,
                0
            );
            return;
        }

        // Resolve dependencies.
        address viewAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LOAN_FLOW_VIEW
        );
        address oracleAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_PRICE_ORACLE
        );
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                0,
                0,
                abi.encode("loanFlowView missing"),
                0,
                0
            );
            return;
        }
        if (oracleAddr == address(0) || oracleAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                0,
                0,
                abi.encode("priceOracle missing"),
                0,
                0
            );
            return;
        }

        // Asset-native valuation first, then normalize into the shared 18-decimal system valuation unit.
        uint256 normalizedValue;
        uint256 priceValue;
        uint256 assetDecimals;
        try IPriceOracleRead(oracleAddr).getPrice(asset) returns (
            uint256 p,
            uint256,
            uint256 d
        ) {
            priceValue = p;
            assetDecimals = d;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                0,
                0,
                reason,
                0,
                0
            );
            return;
        }
        if (priceValue == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                0,
                0,
                abi.encode("price=0"),
                0,
                0
            );
            return;
        }
        if (assetDecimals > 77) {
            // Avoid 10**decimals overflow guardrail; matches ValuationOracleView defensive posture.
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                0,
                0,
                abi.encode("decimals too large"),
                0,
                0
            );
            return;
        }
        uint256 value = AssetDecimalMath.calcValue(
            amountBaseUnits,
            priceValue,
            uint8(assetDecimals)
        );
        normalizedValue = AssetDecimalMath.normalizeValueDown(
            value,
            uint8(assetDecimals),
            _SYSTEM_VALUATION_DECIMALS
        );

        // Strict optimistic concurrency: read current version, nextVersion = cur + 1.
        uint64 nextVersion;
        try
            ILoanFlowViewMinimal(viewAddr).getUserLoanFlowVersionForPusher(user)
        returns (uint64 cur) {
            nextVersion = cur + 1;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                isBorrow ? normalizedValue : 0,
                isBorrow ? 0 : normalizedValue,
                reason,
                0,
                0
            );
            return;
        }

        uint256 borrowDelta = isBorrow ? normalizedValue : 0;
        uint256 repayDelta = isBorrow ? 0 : normalizedValue;
        uint64 borrowCountDelta = isBorrow ? 1 : 0;
        uint64 repayCountDelta = isBorrow ? 0 : 1;

        try
            ILoanFlowViewMinimal(viewAddr).pushUserLoanFlowUpdate(
                user,
                borrowDelta,
                repayDelta,
                borrowCountDelta,
                repayCountDelta,
                requestId,
                0, // seq (disabled; flow deltas are commutative)
                nextVersion
            )
        {
            return;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                borrowDelta,
                repayDelta,
                reason,
                0,
                nextVersion
            );
        }
    }

    /*━━━━━━━━━━━━━━━ Internal: access helpers ━━━━━━━━━━━━━━━*/

    function _requireNotifier(address caller) internal view {
        // Only OrderEngine (ledger SSOT for LOAN_CREATED/LOAN_REPAID) may call notify*.
        address orderEngine = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_ORDER_ENGINE
        );
        if (caller != orderEngine) revert MissingRole();
    }

    function _requireRole(bytes32 role, address account) internal view {
        address acm = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        if (acm == address(0) || acm.code.length == 0) revert NotAContract(acm);
        if (!IAccessControlManager(acm).hasRole(role, account))
            revert MissingRole();
    }

    /*━━━━━━━━━━━━━━━ Internal: requestId helpers ━━━━━━━━━━━━━━━*/

    function _makeRequestIdBorrow(
        address user,
        uint256 orderId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("LOAN_FLOW_BORROW", user, orderId));
    }

    function _makeRequestIdRepay(
        address user,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "LOAN_FLOW_REPAY",
                    user,
                    orderId,
                    repaidAmountAfter
                )
            );
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/

    function _authorizeUpgrade(
        address
    ) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━━━*/

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
    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    uint256[50] private __gap;
}
