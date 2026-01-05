// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockGuaranteeFundForEarlyRepayment
/// @notice Lightweight stub for EarlyRepaymentGuaranteeManager tests.
/// @dev Provides the signatures ERGM expects without transferring funds.
contract MockGuaranteeFundForEarlyRepayment {
    event Settled(
        address indexed borrower,
        address indexed asset,
        address indexed lender,
        address platform,
        uint256 refundToBorrower,
        uint256 penaltyToLender,
        uint256 platformFee
    );

    event ForfeitPartial(
        address indexed borrower,
        address indexed asset,
        address indexed receiver,
        uint256 amount
    );

    function settleEarlyRepayment(
        address borrower,
        address asset,
        address lender,
        address platform,
        uint256 refundToBorrower,
        uint256 penaltyToLender,
        uint256 platformFee
    ) external returns (bool) {
        emit Settled(borrower, asset, lender, platform, refundToBorrower, penaltyToLender, platformFee);
        return true;
    }

    function forfeitPartial(
        address borrower,
        address asset,
        address receiver,
        uint256 amount
    ) external returns (bool) {
        emit ForfeitPartial(borrower, asset, receiver, amount);
        return true;
    }
}
