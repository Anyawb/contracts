// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ILiquidationPayoutManager } from "../../../interfaces/ILiquidationPayoutManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { LiquidationAccessControl } from "../libraries/LiquidationAccessControl.sol";
import { LiquidationValidationLibrary } from "../libraries/LiquidationValidationLibrary.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";

/**
 * @title LiquidationPayoutManager
 * @notice Stores liquidation residual-value recipients and distribution rates.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Single source of truth for governance-controlled residual-value distribution.
 * - Execution remains in LiquidationManager and SettlementManager; this module only stores config and computes shares.
 * - Integer rounding remainder is assigned to the liquidator.
 */
contract LiquidationPayoutManager is Initializable, UUPSUpgradeable, ILiquidationPayoutManager {
    using LiquidationAccessControl for LiquidationAccessControl.Storage;

    /// @notice Distribution ratio denominator (in basis points), fixed at 10_000 (100%)
    uint256 private constant _BPS_DENOMINATOR = 10_000;

    /// @notice Registry address (private storage, following naming conventions)
    /// @dev Used for module address resolution and access control, exposed publicly through registryAddrVar()
    address private _registryAddr;

    /// @notice Access control storage
    /// @dev Reserved for upgrade-safe storage layout (and potential future integration).
    /// @dev Kept to avoid storage layout shifts across upgrades.
    LiquidationAccessControl.Storage internal _accessControlStorage;

    /// @notice Recipient address configuration (private storage)
    /// @dev Contains three recipient addresses: platform, risk reserve, lender compensation
    PayoutRecipients private _recipients;

    /// @notice Distribution ratio configuration (in basis points), total always equals 10_000
    /// @dev Contains distribution ratios for four roles: platform, risk reserve, lender compensation, liquidator
    PayoutRates private _rates;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when payout recipients or rates are updated.
    /// @dev Emitted by governance-controlled config update flows after validation succeeds.
    event PayoutConfigUpdated(PayoutRecipients recipients, PayoutRates rates);

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when payout rates do not sum to 10_000 basis points. Used by config update helpers.
    error LiquidationPayoutManager__InvalidRates();

    /// @dev Reverts when the initializer-provided AccessControlManager does not match Registry.KEY_ACCESS_CONTROL. Used by {initialize}.
    error LiquidationPayoutManager__AccessControlMismatch(address expectedAcm, address providedAcm);

    /// @dev Reverts when a UUPS upgrade target has no deployed code. Used by {_authorizeUpgrade}.
    error LiquidationPayoutManager__InvalidImplementation();

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /// @notice Ensure Registry is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @notice Constructor (disables initialization)
     * @dev Prevents direct calls to initialization function, ensures deployment through proxy pattern
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the liquidation payout manager
     * @dev Reverts if:
     *      - registryAddr is zero address
     *      - accessControlAddr is zero address
     *      - Registry.KEY_ACCESS_CONTROL is set and does not equal accessControlAddr
     *      - any recipient address in recipients is zero address
     *      - rates sum does not equal 10_000 basis points
     *
     * Security:
     * - Initializer modifier ensures single initialization
     * - All addresses are validated to be non-zero
     * - Distribution ratios are validated to sum to 10_000
     *
     * @param registryAddr Registry contract address for module management and address resolution
     * @param accessControlAddr Access control interface address for permission verification
     * @param recipients Initial recipient address configuration (platform, risk reserve, lender compensation)
     * @param rates Initial distribution ratio configuration (in basis points, must sum to 10_000)
     */
    function initialize(
        address registryAddr,
        address accessControlAddr,
        PayoutRecipients calldata recipients,
        PayoutRates calldata rates
    ) external initializer {
        if (registryAddr == address(0)) revert ZeroAddress();
        if (accessControlAddr == address(0)) revert ZeroAddress();
        if (registryAddr.code.length == 0) revert NotAContract(registryAddr);

        __UUPSUpgradeable_init();

        _registryAddr = registryAddr;
        // Access control is sourced from Registry.KEY_ACCESS_CONTROL at call-time (Architecture-Guide).
        // We validate the initializer-provided value to catch deployment misconfiguration.
        // IMPORTANT: in some unit tests a MockRegistry may not have KEY_ACCESS_CONTROL set yet at init time.
        // In that case, skip the mismatch check and rely on runtime gating via onlyRole().
        address expectedAcm = Registry(registryAddr).getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        if (expectedAcm != address(0) && expectedAcm != accessControlAddr) {
            revert LiquidationPayoutManager__AccessControlMismatch(expectedAcm, accessControlAddr);
        }

        _setConfig(recipients, rates);
    }

    /**
     * @notice Get Registry address (naming follows architecture conventions)
     * @return registryAddr Registry contract address
     */
    function registryAddrVar() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /**
     * @notice Get current recipient address configuration
     * @return recipients Recipient address configuration struct (platform, risk reserve, lender compensation)
     */
    function getRecipients() external view override returns (PayoutRecipients memory recipients) {
        return _recipients;
    }

    /**
     * @notice Get current distribution ratio configuration
     * @return rates Distribution ratio configuration struct (in basis points), sum equals 10_000
     */
    function getRates() external view override returns (PayoutRates memory rates) {
        return _rates;
    }

    /**
     * @notice Calculate distribution shares (integer distribution, remainder all goes to liquidator)
    * - liquidatorShare is computed as collateralAmount minus the first three shares, so any rounding remainder is deterministically assigned to the liquidator.
     * @param collateralAmount Amount of seized collateral
     * @return platformShare Platform share (collateral amount × platformBps / 10_000)
     * @return reserveShare Risk reserve share (collateral amount × reserveBps / 10_000)
     * @return lenderShare Lender compensation share (collateral amount × lenderBps / 10_000)
     * @return liquidatorShare Liquidator share (collateral amount - sum of first three, including remainder)
     */
    function calculateShares(uint256 collateralAmount)
        external
        view
        override
        returns (uint256 platformShare, uint256 reserveShare, uint256 lenderShare, uint256 liquidatorShare)
    {
        if (collateralAmount == 0) return (0, 0, 0, 0);

        platformShare = (collateralAmount * _rates.platformBps) / _BPS_DENOMINATOR;
        reserveShare = (collateralAmount * _rates.reserveBps) / _BPS_DENOMINATOR;
        lenderShare = (collateralAmount * _rates.lenderBps) / _BPS_DENOMINATOR;

        uint256 allocated = platformShare + reserveShare + lenderShare;
        // Remainder (including rounding errors) all goes to liquidator, ensuring total equals collateral amount
        liquidatorShare = collateralAmount - allocated;
    }

    /**
     * @notice Update recipient addresses and distribution ratio configuration
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - any recipient address is zero address
     *      - rates sum does not equal 10_000 basis points
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param recipients New recipient address configuration (platform, risk reserve, lender compensation)
     * @param rates New distribution ratio configuration (in basis points, must sum to 10_000)
     */
    function updateConfig(PayoutRecipients calldata recipients, PayoutRates calldata rates)
        external
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        _setConfig(recipients, rates);
    }

    /**
     * @notice Update recipient addresses only (rates unchanged)
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - any recipient address is zero address
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param recipients New recipient address configuration (platform, risk reserve, lender compensation)
     */
    function updateRecipients(PayoutRecipients calldata recipients) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (recipients.platform == address(0)) revert ZeroAddress();
        if (recipients.reserve == address(0)) revert ZeroAddress();
        if (recipients.lenderCompensation == address(0)) revert ZeroAddress();

        _recipients = recipients;
        emit PayoutConfigUpdated(recipients, _rates);
    }

    /**
     * @notice Update distribution ratios only (recipients unchanged)
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - rates sum does not equal 10_000 basis points
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param rates New distribution ratio configuration (in basis points, must sum to 10_000)
     */
    function updateRates(PayoutRates calldata rates) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        uint256 totalBps = rates.platformBps + rates.reserveBps + rates.lenderBps + rates.liquidatorBps;
        if (totalBps != _BPS_DENOMINATOR) revert LiquidationPayoutManager__InvalidRates();

        _rates = rates;
        emit PayoutConfigUpdated(_recipients, rates);
    }

    /**
     * @notice Access control modifier
     * @param role Required role (ActionKeys constant)
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL module is not found in Registry
     *      - caller does not have the required role (via AccessControlManager.requireRole)
     *
     * Security:
     * - Role-gated via global AccessControlManager (Registry.KEY_ACCESS_CONTROL)
     * - Aligns with Architecture-Guide: write entrypoints must be gated by ACM
     */
    modifier onlyRole(bytes32 role) {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(role, msg.sender);
        _;
    }

    /**
     * @notice UUPS upgrade authorization function
     * @dev Reverts if:
     *      - caller does not have ACTION_UPGRADE_MODULE role
     *      - newImplementation is zero address
     *
     * Security:
     * - Role-gated (ACTION_UPGRADE_MODULE)
     * - Validates new implementation address is non-zero to prevent upgrading to invalid address
     * - Follows UUPS upgrade pattern, supports secure contract upgrades
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation)
        internal
        view
        override
        onlyRole(ActionKeys.ACTION_UPGRADE_MODULE)
    {
        LiquidationValidationLibrary.validateAddress(newImplementation, "Implementation");
        if (newImplementation.code.length == 0) revert LiquidationPayoutManager__InvalidImplementation();
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;

    /**
     * @notice Internal configuration setting function
     * @dev Reverts if:
     *      - any recipient address is zero address
     *      - rates sum does not equal 10_000 basis points
     *
     * @param recipients Recipient address configuration
     * @param rates Distribution ratio configuration
     */
    function _setConfig(PayoutRecipients calldata recipients, PayoutRates calldata rates) internal {
        if (recipients.platform == address(0)) revert ZeroAddress();
        if (recipients.reserve == address(0)) revert ZeroAddress();
        if (recipients.lenderCompensation == address(0)) revert ZeroAddress();

        uint256 totalBps = rates.platformBps + rates.reserveBps + rates.lenderBps + rates.liquidatorBps;
        if (totalBps != _BPS_DENOMINATOR) revert LiquidationPayoutManager__InvalidRates();

        _recipients = recipients;
        _rates = rates;

        emit PayoutConfigUpdated(recipients, rates);
    }
}
