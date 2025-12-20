// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVaultBusinessLogicLike {
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;
}

/// @title MockEventsViewReentrant
/// @notice Attempts to re-enter VBL.liquidate during push to validate nonReentrancy rollback
contract MockEventsViewReentrant {
    IVaultBusinessLogicLike public vbl;
    address public user;
    address public collateralAsset;
    address public debtAsset;
    uint256 public cAmt;
    uint256 public dAmt;

    constructor(address _vbl) {
        vbl = IVaultBusinessLogicLike(_vbl);
    }

    function setReentryParams(
        address _user,
        address _collateralAsset,
        address _debtAsset,
        uint256 _cAmt,
        uint256 _dAmt
    ) external {
        user = _user;
        collateralAsset = _collateralAsset;
        debtAsset = _debtAsset;
        cAmt = _cAmt;
        dAmt = _dAmt;
    }

    function pushLiquidationUpdate(
        address,
        address,
        address,
        uint256,
        uint256,
        address,
        uint256,
        uint256
    ) external {
        // re-enter with preset params; expected to revert via ReentrancyGuard
        vbl.liquidate(user, collateralAsset, debtAsset, cAmt, dAmt, 0);
    }
}





