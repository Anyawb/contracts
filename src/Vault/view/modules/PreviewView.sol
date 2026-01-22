// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { RiskUtils } from "../../utils/RiskUtils.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @notice Minimal PositionView read interface.
 * @dev Used by PreviewView to fetch user position data from PositionView without introducing circular dependencies.
 */
interface IPositionViewRead {
    /**
     * @notice Get a user's position for a given asset.
     * @dev Reverts if:
     *      - PositionView reverts (implementation-defined)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Collateral amount (PositionView-defined units/decimals)
     * @return debt Debt amount (PositionView-defined units/decimals)
     */
    function getUserPosition(address user, address asset) external view returns (uint256, uint256);
}

/**
 * @title PreviewView
 * @notice Read-only preview facade for basic deposit/withdraw/borrow/repay estimations (0-gas queries).
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller is not the target user and lacks VIEW_USER_DATA / ADMIN (MissingRole)
 *      - PositionView module is missing in Registry (reverts in Registry.getModuleOrRevert)
 *      - asset is zero address (PreviewView__InvalidInput)
 *
 * Security:
 * - Read-only: does not perform core business writes; values are computed from PositionView snapshots.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract PreviewView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Legacy error kept for backward compatibility; new paths revert `MissingRole()`.
    error PreviewView__Unauthorized();
    
    /// @notice Invalid input parameters.
    /// @dev Reverts when `asset` is the zero address.
    ///      Used by: previewDeposit/previewWithdraw/previewBorrow/previewRepay.
    error PreviewView__InvalidInput();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/

    /// @dev Minimum health factor threshold in basis points (bps=1e4). 10_000 = 100%.
    uint256 private constant _MIN_HF_BPS = 10_000;
    
    /// @dev Maximum LTV in basis points (bps=1e4). 7_500 = 75%.
    uint256 private constant _MAX_LTV_BPS = 7_500;

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
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender) &&
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
        ) {
            // Strict permission alignment across view modules.
            // solhint-disable-next-line custom-errors
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
     * - initializer (UUPS)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
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
     * - Read-only
     *
     * @param user Target user address
     * @param asset Asset address
     * @param amount Amount to add to collateral (PositionView-defined units/decimals)
     * @return hfAfter Health factor after the deposit (bps=1e4). Returns max uint256 if debt is zero.
     * @return ok Whether hfAfter >= MIN threshold
     */
    function previewDeposit(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 hfAfter, bool ok)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);
        uint256 newCollateral = collateral + amount;
        hfAfter = _calcHF(newCollateral, debt);
        ok = hfAfter >= _MIN_HF_BPS;
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
     * - Read-only
     *
     * @param user Target user address
     * @param asset Asset address
     * @param amount Amount to remove from collateral (PositionView-defined units/decimals)
     * @return hfAfter Health factor after the withdrawal (bps=1e4). Returns max uint256 if debt is zero.
     * @return ok Whether hfAfter >= MIN threshold
     */
    function previewWithdraw(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 hfAfter, bool ok)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);
        uint256 newCollateral = collateral > amount ? collateral - amount : 0;
        hfAfter = _calcHF(newCollateral, debt);
        ok = hfAfter >= _MIN_HF_BPS;
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
     * - Read-only
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateralIn Reserved/ignored for backward compatibility (currently unused)
     * @param collateralAdd Amount to add to collateral (PositionView-defined units/decimals)
     * @param borrowAmount Amount to add to debt (PositionView-defined units/decimals)
     * @return newHF Health factor after the borrow (bps=1e4). Returns max uint256 if debt is zero.
     * @return newLTV Loan-to-value ratio after the borrow (bps=1e4). Returns 0 if collateral==0 or debt==0.
     * @return maxBorrowable Remaining borrowable headroom under MAX LTV (0 if already at/above max)
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
        returns (uint256 newHF, uint256 newLTV, uint256 maxBorrowable)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        collateralIn; // reserved/ignored (backward compatibility)
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);

        uint256 newCollateral = collateral + collateralAdd;
        uint256 newDebt = debt + borrowAmount;

        newHF = _calcHF(newCollateral, newDebt);
        newLTV = _calcLTV(newCollateral, newDebt);

        uint256 maxDebt = (newCollateral * _MAX_LTV_BPS) / 10_000;
        if (newDebt >= maxDebt) {
            maxBorrowable = 0;
        } else {
            maxBorrowable = maxDebt - newDebt;
        }
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
     * - Read-only
     *
     * @param user Target user address
     * @param asset Asset address
     * @param amount Amount to reduce from debt (PositionView-defined units/decimals)
     * @return newHF Health factor after the repay (bps=1e4). Returns max uint256 if debt becomes zero.
     * @return newLTV Loan-to-value ratio after the repay (bps=1e4). Returns 0 if collateral==0 or debt==0.
     */
    function previewRepay(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 newHF, uint256 newLTV)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);
        uint256 newDebt = amount >= debt ? 0 : debt - amount;
        newHF = _calcHF(collateral, newDebt);
        newLTV = _calcLTV(collateral, newDebt);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    
    function _positionView() internal view returns (IPositionViewRead) {
        return IPositionViewRead(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW));
    }

    function _getPosition(address user, address asset) internal view returns (uint256 collateral, uint256 debt) {
        return _positionView().getUserPosition(user, asset);
    }

    function _calcHF(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        if (collateral == 0) return 0;
        return (collateral * 10_000) / debt;
    }

    function _calcLTV(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        if (collateral == 0) return 0;
        if (debt == 0) return 0;
        return RiskUtils.calculateLTV(debt, collateral);
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (reverts in ViewAccessLib.requireRole)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get the Registry contract address.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr Registry contract address
     */
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the API version for this module.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return version API semantic version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Get the schema version for this module's outputs.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;
} 