// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockOrderEngineCaller
 * @notice Test helper contract that simulates the ORDER_ENGINE calling notify APIs.
 * @dev Only used in unit tests to satisfy `msg.sender == Registry[KEY_ORDER_ENGINE]` checks.
 */
contract MockOrderEngineCaller {
    function callNotifyBorrow(address loanFlowPushManager, address user, address asset, uint256 amount, uint256 orderId)
        external
    {
        (bool ok, ) = loanFlowPushManager.call(
            abi.encodeWithSignature("notifyBorrow(address,address,uint256,uint256)", user, asset, amount, orderId)
        );
        require(ok, "MockOrderEngineCaller: borrow notify failed");
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
            abi.encodeWithSignature(
                "notifyRepay(address,address,uint256,uint256,uint256)", user, asset, amount, orderId, repaidAmountAfter
            )
        );
        require(ok, "MockOrderEngineCaller: repay notify failed");
    }
}

