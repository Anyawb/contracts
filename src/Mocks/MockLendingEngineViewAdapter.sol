// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal mock implementing LendingEngineView adapter surface for tests
contract MockLendingEngineViewAdapter {
    struct LoanOrder {
        uint256 principal;
        uint256 rate;
        uint256 term;
        address borrower;
        address lender;
        address asset;
        uint256 startTimestamp;
        uint256 maturity;
        uint256 repaidAmount;
    }

    address private _registryAddr;

    mapping(uint256 => LoanOrder) private _orders;
    mapping(address => uint256) private _userLoanCount;
    mapping(uint256 => uint256) private _failedFeeAmount;
    mapping(uint256 => uint256) private _nftRetryCount;
    mapping(uint256 => mapping(address => bool)) private _orderAccess;
    mapping(address => bool) private _matchEngine;

    /* ------------------------------- Setters ------------------------------- */

    function setRegistry(address registryAddr) external {
        _registryAddr = registryAddr;
    }

    function setLoanOrder(uint256 orderId, LoanOrder calldata order) external {
        _orders[orderId] = order;
    }

    function setUserLoanCount(address user, uint256 count) external {
        _userLoanCount[user] = count;
    }

    function setFailedFeeAmount(uint256 orderId, uint256 feeAmount) external {
        _failedFeeAmount[orderId] = feeAmount;
    }

    function setNftRetryCount(uint256 orderId, uint256 retryCount) external {
        _nftRetryCount[orderId] = retryCount;
    }

    function setOrderAccess(uint256 orderId, address user, bool allowed) external {
        _orderAccess[orderId][user] = allowed;
    }

    function setMatchEngine(address account, bool isMatch) external {
        _matchEngine[account] = isMatch;
    }

    /* ------------------------------- View API ------------------------------ */

    function _getLoanOrderForView(uint256 orderId) external view returns (LoanOrder memory order) {
        return _orders[orderId];
    }

    function _getUserLoanCountForView(address user) external view returns (uint256 count) {
        return _userLoanCount[user];
    }

    function _getFailedFeeAmountForView(uint256 orderId) external view returns (uint256 feeAmount) {
        return _failedFeeAmount[orderId];
    }

    function _getNftRetryCountForView(uint256 orderId) external view returns (uint256 retryCount) {
        return _nftRetryCount[orderId];
    }

    function _canAccessLoanOrderForView(uint256 orderId, address user) external view returns (bool hasAccess) {
        return _orderAccess[orderId][user];
    }

    function _isMatchEngineForView(address account) external view returns (bool isMatch) {
        return _matchEngine[account];
    }

    function _getRegistryForView() external view returns (address registry) {
        return _registryAddr;
    }
}

