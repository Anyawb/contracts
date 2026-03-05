// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockLoanFlowView
/// @notice Minimal mock for EasyEmissionController tests
contract MockLoanFlowView {
    uint256 private _totalBorrowVolumeUsd8;
    uint256 private _totalRepayVolumeUsd8;
    uint256 private _totalBorrowCount;
    uint256 private _totalRepayCount;
    bool private _isValid;
    uint256 private _blockNumber;

    function setGlobalLoanFlow(
        uint256 totalBorrowVolumeUsd8,
        uint256 totalRepayVolumeUsd8,
        uint256 totalBorrowCount,
        uint256 totalRepayCount,
        bool isValid,
        uint256 blockNumber
    ) external {
        _totalBorrowVolumeUsd8 = totalBorrowVolumeUsd8;
        _totalRepayVolumeUsd8 = totalRepayVolumeUsd8;
        _totalBorrowCount = totalBorrowCount;
        _totalRepayCount = totalRepayCount;
        _isValid = isValid;
        _blockNumber = blockNumber;
    }

    function getGlobalLoanFlowWithMeta()
        external
        view
        returns (
            uint256 totalBorrowVolumeUsd8,
            uint256 totalRepayVolumeUsd8,
            uint256 totalBorrowCount,
            uint256 totalRepayCount,
            bool isValid,
            uint256 blockNumber
        )
    {
        return (
            _totalBorrowVolumeUsd8,
            _totalRepayVolumeUsd8,
            _totalBorrowCount,
            _totalRepayCount,
            _isValid,
            _blockNumber
        );
    }
}
