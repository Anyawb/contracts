// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {UserView} from "../Vault/view/modules/UserView.sol";

/**
 * @title UserViewSelectorHarness
 * @notice Test-only harness to expose UserView selector constants.
 * @dev This contract MUST NOT be deployed in production. It exists to enable unit tests
 *      to assert selector constants match canonical signatures and SSOT module ABIs.
 */
contract UserViewSelectorHarness is UserView {
    function selGetUserPosition() external pure returns (bytes4) {
        return _SEL_GET_USER_POSITION;
    }

    function selGetUserPositionWithMeta() external pure returns (bytes4) {
        return _SEL_GET_USER_POSITION_WITH_META;
    }

    function selGetUserPositionWithValidity() external pure returns (bytes4) {
        return _SEL_GET_USER_POSITION_WITH_VALIDITY;
    }

    function selGetPositionUpdatedAt() external pure returns (bytes4) {
        return _SEL_GET_POSITION_UPDATED_AT;
    }

    function selGetPositionVersion() external pure returns (bytes4) {
        return _SEL_GET_POSITION_VERSION;
    }

    function selBalanceOf() external pure returns (bytes4) {
        return _SEL_BALANCE_OF;
    }

    function selGetUserSnapshotWithMeta() external pure returns (bytes4) {
        return _SEL_GET_USER_SNAPSHOT_WITH_META;
    }

    function selGetUserSnapshot() external pure returns (bytes4) {
        return _SEL_GET_USER_SNAPSHOT;
    }

    function selGetUserHealthFactor() external pure returns (bytes4) {
        return _SEL_GET_USER_HEALTH_FACTOR;
    }

    function selGetUserHealthFactorWithMeta() external pure returns (bytes4) {
        return _SEL_GET_USER_HEALTH_FACTOR_WITH_META;
    }

    function selPreviewBorrow() external pure returns (bytes4) {
        return _SEL_PREVIEW_BORROW;
    }

    function selPreviewDeposit() external pure returns (bytes4) {
        return _SEL_PREVIEW_DEPOSIT;
    }

    function selPreviewRepay() external pure returns (bytes4) {
        return _SEL_PREVIEW_REPAY;
    }

    function selPreviewWithdraw() external pure returns (bytes4) {
        return _SEL_PREVIEW_WITHDRAW;
    }

    function selBatchGetUserPositions() external pure returns (bytes4) {
        return _SEL_BATCH_GET_USER_POSITIONS;
    }

    function selBatchGetHealthFactors() external pure returns (bytes4) {
        return _SEL_BATCH_GET_HEALTH_FACTORS;
    }

    function selBatchGetHealthFactorsWithMeta() external pure returns (bytes4) {
        return _SEL_BATCH_GET_HEALTH_FACTORS_WITH_META;
    }
}

