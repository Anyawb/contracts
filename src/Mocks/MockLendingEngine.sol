// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockLendingEngine
/// @notice Mock lending engine used in tests.
/// @dev NOTE:
/// - This mock is used as a lightweight KEY_LE stand-in in multiple tests.
/// - It is intentionally NOT the ORDER_ENGINE (see `src/core/LendingEngine.sol` + `IOrderEngine`).
contract MockLendingEngine {
    mapping(address => uint256) private _userTotalDebt;

    /*━━━━━━━━━━━━━━━ Test Helpers ━━━━━━━━━━━━━━━*/
    function setUserDebt(
        address user,
        address /*asset*/,
        uint256 amount
    ) external {
        _userTotalDebt[user] = amount;
    }

    function getUserTotalDebtValue(
        address user
    ) external view returns (uint256) {
        return _userTotalDebt[user];
    }

    function getUserTotalDebtValueBestEffort(
        address user
    ) external view returns (uint256) {
        return _userTotalDebt[user];
    }

    function getUserTotalDebtValueStrict(
        address user
    ) external view returns (uint256) {
        return _userTotalDebt[user];
    }
}
