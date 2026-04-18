// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockLendingEngineBasic} from "./MockLendingEngineBasic.sol";

/// @title RevertingDebtValuationLendingEngine
/// @notice Test helper that keeps debt ledger reads available but makes debt valuation unavailable.
contract RevertingDebtValuationLendingEngine is MockLendingEngineBasic {
    function calculateDebtValue(
        address,
        address
    ) external pure override returns (uint256) {
        revert("revert-debtValue");
    }

    function calculateDebtValueBestEffort(
        address,
        address
    ) external pure override returns (uint256) {
        revert("revert-debtValue");
    }

    function calculateDebtValueStrict(
        address,
        address
    ) external pure override returns (uint256) {
        revert("revert-debtValue");
    }
}
