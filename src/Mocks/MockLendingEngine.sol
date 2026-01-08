// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngine } from "../interfaces/ILendingEngine.sol";

/// @title MockLendingEngine
/// @notice 模拟借贷引擎，用于测试
contract MockLendingEngine is ILendingEngine {
    mapping(address => uint256) private _userTotalDebt;
    function recordBorrow(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
    }

    function borrow(address user, address asset, uint256 amount, uint16 termDays) external pure {
        user; asset; amount; termDays; // silence unused parameters
    }

    function repay(uint256 orderId, address asset, uint256 repayAmount) external pure {
        orderId; asset; repayAmount; // silence unused parameters
    }

    function createLoanOrder(LoanOrder calldata order) external pure returns (uint256) {
        order; // silence unused parameter
        return 0;
    }

    function getLoanOrder(uint256 orderId) external pure returns (LoanOrder memory) {
        orderId; // silence unused parameter
        return LoanOrder(0,0,0,address(0),address(0),address(0),0,0,0);
    }

    // ====== Views to satisfy ILendingEngine ======
    function getUserLoanCount(address) external pure returns (uint256) { return 0; }
    function canAccessLoanOrder(uint256, address) external pure returns (bool) { return true; }
    function getRegistry() external pure returns (address) { return address(0); }
    function isMatchEngine(address) external pure returns (bool) { return false; }
    function getFailedFeeAmount(uint256) external pure returns (uint256) { return 0; }
    function getNftRetryCount(uint256) external pure returns (uint256) { return 0; }
    function getRegisteredMonitorCount() external pure returns (uint256) { return 0; }

    // ====== Test helpers ======
    function setUserDebt(address user, address /*asset*/, uint256 amount) external {
        _userTotalDebt[user] = amount;
    }

    function getUserTotalDebtValue(address user) external view returns (uint256) {
        return _userTotalDebt[user];
    }
} 