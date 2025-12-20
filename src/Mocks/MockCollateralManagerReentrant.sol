// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVaultBusinessLogicLikeForCM {
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;
}

/// @title MockCollateralManagerReentrant
/// @notice Attempts to re-enter VBL.liquidate during withdrawCollateral
contract MockCollateralManagerReentrant {
    IVaultBusinessLogicLikeForCM public vbl;
    address public user;
    address public debtAsset;
    uint256 public cAmt;
    uint256 public dAmt;

    constructor(address _vbl) {
        vbl = IVaultBusinessLogicLikeForCM(_vbl);
    }

    function setReentryParams(address _user, address _debtAsset, uint256 _cAmt, uint256 _dAmt) external {
        user = _user;
        debtAsset = _debtAsset;
        cAmt = _cAmt;
        dAmt = _dAmt;
    }

    function withdrawCollateral(address /*_user*/, address collateralAsset, uint256 /*amount*/) external {
        // re-enter with preset params; should revert via nonReentrant
        vbl.liquidate(user, collateralAsset, debtAsset, cAmt, dAmt, 0);
    }
}





