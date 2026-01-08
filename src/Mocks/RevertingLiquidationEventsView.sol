// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationEventsView } from "../interfaces/ILiquidationEventsView.sol";

/// @title RevertingLiquidationEventsView
/// @notice Test-only LiquidationEventsView that always reverts to simulate downstream failures.
contract RevertingLiquidationEventsView is ILiquidationEventsView {
    error RevertingLiquidationEventsView__ForcedRevert();

    function pushLiquidationUpdate(
        address,
        address,
        address,
        uint256,
        uint256,
        address,
        uint256,
        uint256
    ) external pure override {
        revert RevertingLiquidationEventsView__ForcedRevert();
    }

    function pushBatchLiquidationUpdate(
        address[] calldata,
        address[] calldata,
        address[] calldata,
        uint256[] calldata,
        uint256[] calldata,
        address,
        uint256[] calldata,
        uint256
    ) external pure override {
        revert RevertingLiquidationEventsView__ForcedRevert();
    }

    function pushLiquidationPayout(
        address,
        address,
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure override {
        revert RevertingLiquidationEventsView__ForcedRevert();
    }
}

