// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockLoanFlowView
/// @notice Minimal mock for EasyEmissionController tests
contract MockLoanFlowView {
    uint256 private _totalBorrowVolumeValue;
    uint256 private _totalRepayVolumeValue;
    uint256 private _totalBorrowCount;
    uint256 private _totalRepayCount;
    bool private _isValid;
    uint256 private _blockNumber;

    function setGlobalLoanFlow(
        uint256 totalBorrowVolumeValue,
        uint256 totalRepayVolumeValue,
        uint256 totalBorrowCount,
        uint256 totalRepayCount,
        bool isValid,
        uint256 blockNumber
    ) external {
        _totalBorrowVolumeValue = totalBorrowVolumeValue;
        _totalRepayVolumeValue = totalRepayVolumeValue;
        _totalBorrowCount = totalBorrowCount;
        _totalRepayCount = totalRepayCount;
        _isValid = isValid;
        _blockNumber = blockNumber;
    }

    function getGlobalLoanFlowWithMeta()
        external
        view
        returns (
            uint256 totalBorrowVolumeValue,
            uint256 totalRepayVolumeValue,
            uint256 totalBorrowCount,
            uint256 totalRepayCount,
            bool isValid,
            uint256 blockNumber
        )
    {
        return (
            _totalBorrowVolumeValue,
            _totalRepayVolumeValue,
            _totalBorrowCount,
            _totalRepayCount,
            _isValid,
            _blockNumber
        );
    }
}
