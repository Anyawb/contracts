// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {IPositionViewBasic} from "../../../interfaces/IPositionViewBasic.sol";
import {ISystemRiskView} from "../../../interfaces/ISystemRiskView.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {RiskUtils} from "../../utils/RiskUtils.sol";
import {ViewVersioned} from "../ViewVersioned.sol";

/**
 * @title PreviewView
 * @notice Preview facade for basic deposit, withdraw, borrow, and repay estimations.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller is not the target user and lacks VIEW_USER_DATA / ADMIN (MissingRole)
 *      - PositionView module is missing in Registry (reverts in Registry.getModuleOrRevert)
 *      - asset is zero address (PreviewView__InvalidInput)
 *
 * Security:
 * - View-only facade: does not perform core business writes; values are computed from PositionView snapshots.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract PreviewView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Invalid input parameters.
    /// @dev Reverts when `asset` is the zero address.
    ///      Used by: previewDeposit/previewWithdraw/previewBorrow/previewRepay.
    error PreviewView__InvalidInput();

    /// @notice Invalid system-scoped risk parameter from SSOT.
    error PreviewView__InvalidRiskParameter();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Gate: caller must be the target user, or have VIEW_USER_DATA / ADMIN.
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            ) &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_USER_DATA,
                msg.sender
            )
        ) {
            // Strict permission alignment across view modules.
            revert MissingRole();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the PreviewView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - Initializer: callable once.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Preview APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Preview the post-deposit health factor for a user's position.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyUserOrViewer)
     *      - asset is zero address (PreviewView__InvalidInput)
     *      - PositionView module is missing (reverts in Registry.getModuleOrRevert)
     *
     * Security:
     * - View-only.
     *
     * @param user Target user address.
     * @param asset Asset address.
     * @param amount Amount to add to collateral in PositionView-defined units.
     * @return hfAfter Health factor after the deposit (bps=1e4). Returns max uint256 if debt is zero.
     * @return ok True if `hfAfter` is at or above the minimum health-factor threshold.
     * @return positionIsValid True if the PositionView cache is valid.
     * @return positionUpdateBlock PositionView cache update block number.
     * @return positionVersion PositionView cache version.
     */
    function previewDeposit(
        address user,
        address asset,
        uint256 amount
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            uint256 hfAfter,
            bool ok,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion
        )
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        ) = _getPositionWithMeta(user, asset);
        uint256 newCollateral = collateral + amount;
        hfAfter = _calcHF(newCollateral, debt);
        ok = hfAfter >= _minHealthFactorBps();
        positionIsValid = isValid;
        positionUpdateBlock = blockNumber;
        positionVersion = version;
    }

    /**
     * @notice Preview the post-withdraw health factor for a user's position.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyUserOrViewer)
     *      - asset is zero address (PreviewView__InvalidInput)
     *      - PositionView module is missing (reverts in Registry.getModuleOrRevert)
     *
     * Security:
     * - View-only.
     *
     * @param user Target user address.
     * @param asset Asset address.
     * @param amount Amount to remove from collateral in PositionView-defined units.
     * @return hfAfter Health factor after the withdrawal (bps=1e4). Returns max uint256 if debt is zero.
     * @return ok True if `hfAfter` is at or above the minimum health-factor threshold.
     * @return positionIsValid True if the PositionView cache is valid.
     * @return positionUpdateBlock PositionView cache update block number.
     * @return positionVersion PositionView cache version.
     */
    function previewWithdraw(
        address user,
        address asset,
        uint256 amount
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            uint256 hfAfter,
            bool ok,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion
        )
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        ) = _getPositionWithMeta(user, asset);
        uint256 newCollateral = collateral > amount ? collateral - amount : 0;
        hfAfter = _calcHF(newCollateral, debt);
        ok = hfAfter >= _minHealthFactorBps();
        positionIsValid = isValid;
        positionUpdateBlock = blockNumber;
        positionVersion = version;
    }

    /**
     * @notice Preview the post-borrow health factor, LTV, and remaining borrowable headroom.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyUserOrViewer)
     *      - asset is zero address (PreviewView__InvalidInput)
     *      - PositionView module is missing (reverts in Registry.getModuleOrRevert)
     *
     * Security:
     * - View-only.
     *
     * @param user Target user address.
     * @param asset Asset address.
     * @param collateralIn Reserved input kept for backward compatibility. Currently unused.
     * @param collateralAdd Amount to add to collateral in PositionView-defined units.
     * @param borrowAmount Amount to add to debt in PositionView-defined units.
     * @return newHF Health factor after the borrow (bps=1e4). Returns max uint256 if debt is zero.
     * @return newLTV Loan-to-value ratio after the borrow (bps=1e4). Returns 0 if collateral==0 or debt==0.
     * @return maxBorrowable Remaining borrowable headroom under the max LTV constraint.
     * @return positionIsValid True if the PositionView cache is valid.
     * @return positionUpdateBlock PositionView cache update block number.
     * @return positionVersion PositionView cache version.
     */
    function previewBorrow(
        address user,
        address asset,
        uint256 collateralIn,
        uint256 collateralAdd,
        uint256 borrowAmount
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            uint256 newHF,
            uint256 newLTV,
            uint256 maxBorrowable,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion
        )
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        collateralIn; // reserved/ignored (backward compatibility)
        (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        ) = _getPositionWithMeta(user, asset);

        uint256 newCollateral = collateral + collateralAdd;
        uint256 newDebt = debt + borrowAmount;

        newHF = _calcHF(newCollateral, newDebt);
        newLTV = _calcLTV(newCollateral, newDebt);

        uint256 maxDebt = (newCollateral * _maxLtvBps()) / 10_000;
        if (newDebt >= maxDebt) {
            maxBorrowable = 0;
        } else {
            maxBorrowable = maxDebt - newDebt;
        }
        positionIsValid = isValid;
        positionUpdateBlock = blockNumber;
        positionVersion = version;
    }

    /**
     * @notice Return the current max borrowable headroom for a user/asset, with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyUserOrViewer)
     *      - asset is zero address (PreviewView__InvalidInput)
     *      - PositionView module is missing (reverts in Registry.getModuleOrRevert)
     *
     * Security:
     * - View-only.
     *
     * @param user Target user address.
     * @param asset Asset address.
     * @return maxBorrowable Remaining borrowable headroom under the max LTV constraint.
     * @return positionIsValid True if the PositionView cache is valid.
     * @return positionUpdateBlock PositionView cache update block number.
     * @return positionVersion PositionView cache version.
     */
    function getMaxBorrowableWithMeta(
        address user,
        address asset
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            uint256 maxBorrowable,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion
        )
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        ) = _getPositionWithMeta(user, asset);
        uint256 maxDebt = (collateral * _maxLtvBps()) / 10_000;
        maxBorrowable = debt >= maxDebt ? 0 : (maxDebt - debt);
        positionIsValid = isValid;
        positionUpdateBlock = blockNumber;
        positionVersion = version;
    }

    /**
     * @notice Preview the post-repay health factor and LTV for a user's position.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyUserOrViewer)
     *      - asset is zero address (PreviewView__InvalidInput)
     *      - PositionView module is missing (reverts in Registry.getModuleOrRevert)
     *
     * Security:
     * - View-only.
     *
     * @param user Target user address.
     * @param asset Asset address.
     * @param amount Amount to reduce from debt in PositionView-defined units.
     * @return newHF Health factor after the repay (bps=1e4). Returns max uint256 if debt becomes zero.
     * @return newLTV Loan-to-value ratio after the repay (bps=1e4). Returns 0 if collateral==0 or debt==0.
     * @return positionIsValid True if the PositionView cache is valid.
     * @return positionUpdateBlock PositionView cache update block number.
     * @return positionVersion PositionView cache version.
     */
    function previewRepay(
        address user,
        address asset,
        uint256 amount
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            uint256 newHF,
            uint256 newLTV,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion
        )
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        ) = _getPositionWithMeta(user, asset);
        uint256 newDebt = amount >= debt ? 0 : debt - amount;
        newHF = _calcHF(collateral, newDebt);
        newLTV = _calcLTV(collateral, newDebt);
        positionIsValid = isValid;
        positionUpdateBlock = blockNumber;
        positionVersion = version;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _positionView() internal view returns (IPositionViewBasic) {
        return
            IPositionViewBasic(
                Registry(_registryAddr).getModuleOrRevert(
                    ModuleKeys.KEY_POSITION_VIEW
                )
            );
    }

    function _systemRiskView() internal view returns (ISystemRiskView) {
        return
            ISystemRiskView(
                Registry(_registryAddr).getModuleOrRevert(
                    ModuleKeys.KEY_SYSTEM_RISK_VIEW
                )
            );
    }

    function _minHealthFactorBps()
        internal
        view
        returns (uint256 minHealthFactor)
    {
        minHealthFactor = _systemRiskView().getMinHealthFactor();
        if (minHealthFactor == 0) revert PreviewView__InvalidRiskParameter();
    }

    function _maxLtvBps() internal view returns (uint256 maxLtvBps) {
        maxLtvBps = _systemRiskView().getMaxLtvBps();
        if (maxLtvBps == 0) revert PreviewView__InvalidRiskParameter();
    }

    function _getPositionWithMeta(
        address user,
        address asset
    )
        internal
        view
        returns (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        )
    {
        return _positionView().getUserPositionWithMeta(user, asset);
    }

    function _calcHF(
        uint256 collateral,
        uint256 debt
    ) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        if (collateral == 0) return 0;
        return (collateral * 10_000) / debt;
    }

    function _calcLTV(
        uint256 collateral,
        uint256 debt
    ) internal pure returns (uint256) {
        if (collateral == 0) return 0;
        if (debt == 0) return 0;
        return RiskUtils.calculateLTV(debt, collateral);
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return the API semantic version for this module.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     *
     * @return version API semantic version.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Return the schema version for this module's outputs.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     *
     * @return version Schema version.
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;
}
