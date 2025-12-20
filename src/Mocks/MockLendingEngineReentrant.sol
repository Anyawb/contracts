// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVaultBusinessLogicLikeForLE {
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;
}

/// @title MockLendingEngineReentrant
/// @notice Attempts to re-enter VBL.liquidate during forceReduceDebt
contract MockLendingEngineReentrant {
    IVaultBusinessLogicLikeForLE public vbl;
    address public user;
    address public collateralAsset;
    uint256 public cAmt;
    uint256 public dAmt;

    constructor(address _vbl) {
        vbl = IVaultBusinessLogicLikeForLE(_vbl);
    }

    function setReentryParams(
        address _user,
        address _collateralAsset,
        uint256 _cAmt,
        uint256 _dAmt
    ) external {
        user = _user;
        collateralAsset = _collateralAsset;
        cAmt = _cAmt;
        dAmt = _dAmt;
    }

    function forceReduceDebt(address /*user*/, address debtAsset, uint256 /*amount*/) external {
        vbl.liquidate(user, collateralAsset, debtAsset, cAmt, dAmt, 0);
    }

    // Stubs to satisfy interface shape (not used in reentry test)
    function borrow(address, address, uint256, uint256, uint16) external pure {}
    function repay(address, address, uint256) external pure {}
    function getDebt(address, address) external pure returns (uint256) { return 0; }
    function getTotalDebtByAsset(address) external pure returns (uint256) { return 0; }
    function getUserTotalDebtValue(address) external pure returns (uint256) { return 0; }
    function getTotalDebtValue() external pure returns (uint256) { return 0; }
    function getUserDebtAssets(address) external pure returns (address[] memory) { return new address[](0); }
    function calculateExpectedInterest(address, address, uint256) external pure returns (uint256) { return 0; }
    function getReducibleDebtAmount(address, address) external pure returns (uint256) { return 0; }
    function calculateDebtValue(address, address) external pure returns (uint256) { return 0; }
}





