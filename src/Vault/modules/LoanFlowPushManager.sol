// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { CacheEvents } from "../CacheEvents.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { IPriceOracle } from "../../interfaces/IPriceOracle.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../errors/StandardErrors.sol";

interface ILoanFlowViewMinimal {
    function getUserLoanFlowVersionForPusher(address user) external view returns (uint64);

    function pushUserLoanFlowUpdate(
        address user,
        uint256 borrowDeltaUsd8,
        uint256 repayDeltaUsd8,
        uint64 borrowCountDelta,
        uint64 repayCountDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
}

/**
 * @title LoanFlowPushManager
 * @notice Single-entry best-effort orchestrator that computes USD-8 values and pushes loan-flow deltas into LoanFlowView.
 *
 * Core properties (Architecture-Guide alignment):
 * - **Single on-chain entrypoint**: only this contract calls `LoanFlowView.pushUserLoanFlowUpdate(...)`.
 * - **USD-8 SSOT**: converts raw asset amounts into USD-8 via `KEY_PRICE_ORACLE`.
 * - **Best-effort**: MUST NOT revert the caller's ledger flow; failures emit {CacheUpdateFailedWithContext} and return.
 * - **Strict optimistic concurrency**: reads current version from LoanFlowView and pushes with `nextVersion = cur + 1`.
 *
 * Notes:
 * - This module is intentionally NOT the SSOT for loans; it is a cache orchestrator for view metrics only.
 * - Event counts are explicit deltas (borrowCountDelta / repayCountDelta) so counting remains correct even if USD-8 delta rounds to 0.
 */
contract LoanFlowPushManager is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable, CacheEvents {
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
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
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

    /*━━━━━━━━━━━━━━━ Public notify APIs (best-effort) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Best-effort notify that a borrow occurred (loan created) and LoanFlowView should be updated.
     * @dev MUST NOT revert the caller's flow; emits CacheUpdateFailedWithContext on internal failures and returns.
     *
     * Security:
     * - Restricted to the SSOT order engine (`Registry[KEY_ORDER_ENGINE]`) via `_requireNotifier()`.
     *
     * Units:
     * - `amountBaseUnits` uses the underlying asset decimals (token units).
     *
     * @param user Borrower address
     * @param asset Borrowed asset address
     * @param amountBaseUnits Borrow principal in base units (token decimals)
     * @param orderId Loan order id (used for deterministic requestId)
     */
    function notifyBorrow(address user, address asset, uint256 amountBaseUnits, uint256 orderId)
        external
        onlyValidRegistry
        nonReentrant
    {
        _requireNotifier(msg.sender);
        bytes32 requestId = _makeRequestIdBorrow(user, orderId);
        _pushLoanFlowDeltaBestEffort(user, asset, amountBaseUnits, true, requestId);
    }

    /**
     * @notice Best-effort notify that a repay occurred (partial or full) and LoanFlowView should be updated.
     * @dev MUST NOT revert the caller's flow; emits CacheUpdateFailedWithContext on internal failures and returns.
     *
     * Security:
     * - Restricted to the SSOT order engine (`Registry[KEY_ORDER_ENGINE]`) via `_requireNotifier()`.
     *
     * Units:
     * - `amountBaseUnits` uses the underlying asset decimals (token units).
     *
     * @param user Borrower address
     * @param asset Repaid asset address
     * @param amountBaseUnits Repay amount in base units (token decimals)
     * @param orderId Loan order id (used for deterministic requestId)
     * @param repaidAmountAfter Cumulative repaidAmount after applying this repay (from OrderEngine state; used for uniqueness)
     */
    function notifyRepay(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external onlyValidRegistry nonReentrant {
        _requireNotifier(msg.sender);
        bytes32 requestId = _makeRequestIdRepay(user, orderId, repaidAmountAfter);
        _pushLoanFlowDeltaBestEffort(user, asset, amountBaseUnits, false, requestId);
    }

    /*━━━━━━━━━━━━━━━ Retry APIs (role-gated) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Retry a borrow delta push (USD-8 conversion + strict push).
     * @dev Intended for keepers/offchain retry services. This call may emit CacheUpdateFailedWithContext and return.
     *
     * Reverts if:
     * - caller lacks ACTION_VIEW_PUSH (MissingRole)
     */
    function retryBorrow(address user, address asset, uint256 amountBaseUnits, uint256 orderId)
        external
        onlyValidRegistry
        nonReentrant
    {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        bytes32 requestId = _makeRequestIdBorrow(user, orderId);
        _pushLoanFlowDeltaBestEffort(user, asset, amountBaseUnits, true, requestId);
    }

    /**
     * @notice Retry a repay delta push (USD-8 conversion + strict push).
     * @dev Intended for keepers/offchain retry services. This call may emit CacheUpdateFailedWithContext and return.
     *
     * Reverts if:
     * - caller lacks ACTION_VIEW_PUSH (MissingRole)
     */
    function retryRepay(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external onlyValidRegistry nonReentrant {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        bytes32 requestId = _makeRequestIdRepay(user, orderId, repaidAmountAfter);
        _pushLoanFlowDeltaBestEffort(user, asset, amountBaseUnits, false, requestId);
    }

    /*━━━━━━━━━━━━━━━ Internal: conversion + strict push (best-effort) ━━━━━━━━━━━━━━━*/

    function _pushLoanFlowDeltaBestEffort(
        address user,
        address asset,
        uint256 amountBaseUnits,
        bool isBorrow,
        bytes32 requestId
    ) internal {
        if (user == address(0) || asset == address(0)) {
            emit CacheUpdateFailedWithContext(user, asset, requestId, address(0), 0, 0, abi.encode("user/asset=0"), 0, 0);
            return;
        }
        if (amountBaseUnits == 0) {
            emit CacheUpdateFailedWithContext(user, asset, requestId, address(0), 0, 0, abi.encode("amount=0"), 0, 0);
            return;
        }

        // Resolve dependencies.
        address viewAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_FLOW_VIEW);
        address oracleAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_PRICE_ORACLE);
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(user, asset, requestId, viewAddr, 0, 0, abi.encode("loanFlowView missing"), 0, 0);
            return;
        }
        if (oracleAddr == address(0) || oracleAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(user, asset, requestId, viewAddr, 0, 0, abi.encode("priceOracle missing"), 0, 0);
            return;
        }

        // USD-8 conversion (SSOT): valueUsd8 = amountBaseUnits * priceUsd8 / 10**assetDecimals.
        uint256 valueUsd8;
        uint256 priceUsd8;
        uint256 assetDecimals;
        try IPriceOracle(oracleAddr).getPrice(asset) returns (uint256 p, uint256, uint256 d) {
            priceUsd8 = p;
            assetDecimals = d;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(user, asset, requestId, viewAddr, 0, 0, reason, 0, 0);
            return;
        }
        if (priceUsd8 == 0) {
            emit CacheUpdateFailedWithContext(user, asset, requestId, viewAddr, 0, 0, abi.encode("price=0"), 0, 0);
            return;
        }
        if (assetDecimals > 77) {
            // Avoid 10**decimals overflow guardrail; matches ValuationOracleView defensive posture.
            emit CacheUpdateFailedWithContext(user, asset, requestId, viewAddr, 0, 0, abi.encode("decimals too large"), 0, 0);
            return;
        }
        uint256 denom = 10 ** assetDecimals;
        valueUsd8 = Math.mulDiv(amountBaseUnits, priceUsd8, denom);

        // Strict optimistic concurrency: read current version, nextVersion = cur + 1.
        uint64 nextVersion;
        try ILoanFlowViewMinimal(viewAddr).getUserLoanFlowVersionForPusher(user) returns (uint64 cur) {
            nextVersion = cur + 1;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                viewAddr,
                isBorrow ? valueUsd8 : 0,
                isBorrow ? 0 : valueUsd8,
                reason,
                0,
                0
            );
            return;
        }

        uint256 borrowDelta = isBorrow ? valueUsd8 : 0;
        uint256 repayDelta = isBorrow ? 0 : valueUsd8;
        uint64 borrowCountDelta = isBorrow ? 1 : 0;
        uint64 repayCountDelta = isBorrow ? 0 : 1;

        try ILoanFlowViewMinimal(viewAddr).pushUserLoanFlowUpdate(
            user,
            borrowDelta,
            repayDelta,
            borrowCountDelta,
            repayCountDelta,
            requestId,
            0, // seq (disabled; flow deltas are commutative)
            nextVersion
        ) {
            // ok
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user, asset, requestId, viewAddr, borrowDelta, repayDelta, reason, 0, nextVersion
            );
        }
    }

    /*━━━━━━━━━━━━━━━ Internal: access helpers ━━━━━━━━━━━━━━━*/

    function _requireNotifier(address caller) internal view {
        // Only OrderEngine (ledger SSOT for LOAN_CREATED/LOAN_REPAID) may call notify*.
        address orderEngine = Registry(_registryAddr).getModule(ModuleKeys.KEY_ORDER_ENGINE);
        if (caller != orderEngine) revert MissingRole();
    }

    function _requireRole(bytes32 role, address account) internal view {
        address acm = Registry(_registryAddr).getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        if (acm == address(0) || acm.code.length == 0) revert NotAContract(acm);
        if (!IAccessControlManager(acm).hasRole(role, account)) revert MissingRole();
    }

    /*━━━━━━━━━━━━━━━ Internal: requestId helpers ━━━━━━━━━━━━━━━*/

    function _makeRequestIdBorrow(address user, uint256 orderId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("LOAN_FLOW_BORROW", user, orderId));
    }

    function _makeRequestIdRepay(address user, uint256 orderId, uint256 repaidAmountAfter) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("LOAN_FLOW_REPAY", user, orderId, repaidAmountAfter));
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/

    function _authorizeUpgrade(address) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━━━*/

    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    uint256[50] private __gap;
}

