// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILoanFlowPushManagerMock {
    function notifyBorrow(
        address user,
        address asset,
        uint256 amount,
        uint256 orderId
    ) external;
    function notifyRepay(
        address user,
        address asset,
        uint256 amount,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external;
}

/**
 * @title MockOrderEngineCaller
 * @notice Test helper contract that simulates the ORDER_ENGINE calling notify APIs.
 * @dev Only used in unit tests to satisfy `msg.sender == Registry[KEY_ORDER_ENGINE]` checks.
 */
contract MockOrderEngineCaller {
    function callNotifyBorrow(
        address loanFlowPushManager,
        address user,
        address asset,
        uint256 amount,
        uint256 orderId
    ) external {
        (bool ok, ) = loanFlowPushManager.call(
            abi.encodeCall(
                ILoanFlowPushManagerMock.notifyBorrow,
                (user, asset, amount, orderId)
            )
        );
        require(ok, "MOEC: borrow fail");
    }

    function callNotifyRepay(
        address loanFlowPushManager,
        address user,
        address asset,
        uint256 amount,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external {
        (bool ok, ) = loanFlowPushManager.call(
            abi.encodeCall(
                ILoanFlowPushManagerMock.notifyRepay,
                (user, asset, amount, orderId, repaidAmountAfter)
            )
        );
        require(ok, "MOEC: repay fail");
    }
}
