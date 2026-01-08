// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ILiquidationPayoutManager } from "../../../interfaces/ILiquidationPayoutManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { LiquidationAccessControl } from "../libraries/LiquidationAccessControl.sol";
import { LiquidationValidationLibrary } from "../libraries/LiquidationValidationLibrary.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";

/// @title LiquidationPayoutManager
/// @notice Liquidation residual value distribution management module: stores distribution ratios and recipient addresses, provides share calculation
/// @dev Follows architecture guide (Architecture-Guide.md §732-771): serves as the single source of truth for "liquidation residual value distribution module", responsible for residual value distribution configuration and execution coordination
/// @dev Module positioning: Registry.KEY_LIQUIDATION_PAYOUT_MANAGER points to this contract, governance layer can centrally maintain residual value recipient addresses and ratios
/// @dev Design principles:
///     - Residual value distribution SSOT: this module stores governance-controlled recipient addresses and BPS configuration, all liquidation executors must read configuration from here first
///     - Execution coordination: SettlementManager/LiquidationManager execute actual transfers through CollateralManager/FeeRouter and other ledger contracts based on calculateShares results, meeting the guide requirement of "module-led distribution execution"
///     - Governability: recipient addresses and distribution ratios can be safely adjusted through ACTION_SET_PARAMETER permission
///     - Integer distribution: remainder (including rounding errors) all goes to liquidator, ensuring total equals collateral amount
/// @dev Integration with liquidation flow:
///     - LiquidationManager/SettlementManager call calculateShares after seizing collateral to get shares for each role, then execute CollateralManager.withdrawCollateralTo and other operations accordingly
///     - After distribution completes, trigger DataPush through LiquidatorView (as required by Architecture-Guide.md), facilitating frontend/offline service consumption
/// @dev Naming conventions (following Architecture-Guide.md §852-879):
///     - Private state variables: _ + camelCase (e.g., _registryAddr, _recipients, _rates)
///     - Public variables: camelCase + Var (e.g., registryAddrVar)
///     - Event names: PascalCase, past tense (e.g., PayoutConfigUpdated)
///     - Error names: PascalCase with __ prefix (e.g., LiquidationPayoutManager__InvalidRates)
contract LiquidationPayoutManager is Initializable, UUPSUpgradeable, ILiquidationPayoutManager {
    using LiquidationAccessControl for LiquidationAccessControl.Storage;

    /// @notice Distribution ratio denominator (in basis points), fixed at 10_000 (100%)
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Registry address (private storage, following naming conventions)
    /// @dev Used for module address resolution and access control, exposed publicly through registryAddrVar()
    address private _registryAddr;

    /// @notice Access control storage
    /// @dev Uses LiquidationAccessControl library for permission management, supports ACM integration
    LiquidationAccessControl.Storage internal accessControlStorage;

    /// @notice Recipient address configuration (private storage)
    /// @dev Contains three recipient addresses: platform, risk reserve, lender compensation
    PayoutRecipients private _recipients;

    /// @notice Distribution ratio configuration (in basis points), total always equals 10_000
    /// @dev Contains distribution ratios for four roles: platform, risk reserve, lender compensation, liquidator
    PayoutRates private _rates;

    /**
     * @notice Payout configuration updated event
     * @param recipients Updated recipient address configuration
     * @param rates Updated distribution ratio configuration
     * @dev Follows event naming convention: PascalCase, past tense
     */
    event PayoutConfigUpdated(PayoutRecipients recipients, PayoutRates rates);

    /// @notice Invalid distribution ratios error
    /// @dev Triggered when distribution ratio sum does not equal 10_000 basis points
    /// @dev Follows error naming convention: PascalCase with __ prefix
    error LiquidationPayoutManager__InvalidRates();

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

        __UUPSUpgradeable_init();

        _registryAddr = registryAddr;
        LiquidationAccessControl.initialize(accessControlStorage, accessControlAddr, accessControlAddr);

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

        platformShare = (collateralAmount * _rates.platformBps) / BPS_DENOMINATOR;
        reserveShare = (collateralAmount * _rates.reserveBps) / BPS_DENOMINATOR;
        lenderShare = (collateralAmount * _rates.lenderBps) / BPS_DENOMINATOR;

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
    function updateConfig(PayoutRecipients calldata recipients, PayoutRates calldata rates) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        _setConfig(recipients, rates);
    }

    /**
     * @notice Access control modifier
     * @param role Required role (ActionKeys constant)
     * @dev Uses LiquidationAccessControl library for permission verification
     * @dev Follows architecture guide: access control is unified through ACM
     */
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(accessControlStorage, role, msg.sender);
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
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationValidationLibrary.validateAddress(newImplementation, "Implementation");
    }

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
        if (totalBps != BPS_DENOMINATOR) revert LiquidationPayoutManager__InvalidRates();

        _recipients = recipients;
        _rates = rates;

        emit PayoutConfigUpdated(recipients, rates);
    }
}
