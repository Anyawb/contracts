// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";
import { IVaultRouter } from "../interfaces/IVaultRouter.sol";

/// @notice Minimal VaultCore mock exposing viewContractAddrVar() and forwarding calls to LendingEngine for tests
contract MockVaultCoreView {
    address public viewContractAddr;
    address public lendingEngine;

    function setViewContractAddr(address newView) external {
        viewContractAddr = newView;
    }

    function setLendingEngine(address newLending) external {
        lendingEngine = newLending;
    }

    function viewContractAddrVar() external view returns (address) {
        return viewContractAddr;
    }

    /**
     * @notice Minimal VaultCore push path used by VaultLendingEngine (best-effort).
     * @dev VaultLendingEngine pushes through VaultCore to satisfy VaultRouter-onlyVaultCore restriction.
     *      This mock forwards the call to the configured view contract.
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external {
        // best-effort in tests: if view not set, just return
        if (viewContractAddr == address(0)) return;
        IVaultRouter(viewContractAddr).pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
        nextVersion; // silence (View may ignore)
    }

    /**
     * @notice Minimal delta push path used by CollateralManager (best-effort).
     * @dev CollateralManager may push deltas via VaultCore in some paths; keep a forwarding stub for tests.
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external {
        if (viewContractAddr == address(0)) return;
        IVaultRouter(viewContractAddr).pushUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, nextVersion);
    }

    // Forwarding helpers to satisfy onlyVaultCore guard in tests
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external {
        ILendingEngineBasic(lendingEngine).borrow(user, asset, amount, collateralAdded, termDays);
    }

    function repay(address user, address asset, uint256 amount) external {
        ILendingEngineBasic(lendingEngine).repay(user, asset, amount);
    }
}

