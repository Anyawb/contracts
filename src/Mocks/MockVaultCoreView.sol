// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";

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

    // Forwarding helpers to satisfy onlyVaultCore guard in tests
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external {
        ILendingEngineBasic(lendingEngine).borrow(user, asset, amount, collateralAdded, termDays);
    }

    function repay(address user, address asset, uint256 amount) external {
        ILendingEngineBasic(lendingEngine).repay(user, asset, amount);
    }
}

