// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { LiquidationRiskLib } from "../../liquidation/libraries/LiquidationRiskLib.sol";
import { ILiquidationRiskRead } from "../../../interfaces/ILiquidationRiskRead.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import {
    ArrayLengthMismatch,
    BatchTooLarge,
    EmptyArray,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title LiquidationRiskView
 * @notice Exposes role-gated liquidation risk reads and batch helpers for liquidation risk evaluation.
 * @dev DEPRECATED as a primary entrypoint: use RiskView (user-dimensional risk) and
 *      HealthView (health factor) for canonical reads. System-only parameters are in SystemRiskView.
 * @dev Reverts if:
 *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
 *      - caller lacks required Scheme U permissions (see access-control modifiers)
 *      - batch inputs are invalid (see {EmptyArray}, {ArrayLengthMismatch}, {BatchTooLarge})
 *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
 *
 * Security:
 * - Scheme U reads via {ViewAccessLib} and {ActionKeys}
 * - Upgrade authorization is role-gated (ACTION_ADMIN)
 */
contract LiquidationRiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Ensures the Registry address is configured and is a contract.
     * @dev Reverts if:
     *      - _registryAddr is zero (see {ZeroAddress})
     *      - _registryAddr is not a contract (see {NotAContract})
     *
     * Security:
    * - View-only guard.
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @notice Scheme U access for a specific user.
     * @dev Reverts if:
     *      - caller is not user and lacks VIEW_USER_DATA or ADMIN
     *
     * Security:
     * - Self access is allowed; non-self requires VIEW_USER_DATA or ADMIN
     *
     * @param user Target user address
     */
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /**
     * @notice Scheme U batch access (no self-bypass).
     * @dev Reverts if:
     *      - caller lacks VIEW_USER_DATA or ADMIN
     *
     * Security:
     * - Role-gated reads (VIEW_USER_DATA or ADMIN)
     */
    modifier onlyUserBatchViewer() {
        if (
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the view module with the Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Initializer is single-use (OpenZeppelin Initializable)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Pure helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Calculates health factors for a batch of collateral/debt pairs.
     * @dev Reverts if:
     *      - collaterals.length != debts.length (see {ArrayLengthMismatch})
     *
     * Security:
    * - Pure function.
     *
    * @param collaterals Collateral amounts in implementation-defined units.
    * @param debts Debt amounts in implementation-defined units.
    * @return healthFactors Health factors returned by LiquidationRiskLib.
     */
    function batchCalculateHealthFactors(
        uint256[] calldata collaterals,
        uint256[] calldata debts
    ) external pure returns (uint256[] memory healthFactors) {
        uint256 len = collaterals.length;
        if (len != debts.length) revert ArrayLengthMismatch(len, debts.length);
        healthFactors = new uint256[](len);
        for (uint256 i; i < len; ) {
            healthFactors[i] = LiquidationRiskLib.calculateHealthFactor(collaterals[i], debts[i]);
            unchecked { ++i; }
        }
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns whether a user is liquidatable according to the RiskManager, with metadata.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyUserOrViewer})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U reads (self or VIEW_USER_DATA/ADMIN)
     *
    * @param user Target user address.
    * @return liquidatable True if the RiskManager reports the user as liquidatable.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
     */
    function isLiquidatable(address user)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (bool liquidatable, bool isValid, uint256 blockNumber)
    {
        liquidatable = _rm().isLiquidatable(user);
        return (liquidatable, true, _now());
    }

    /**
     * @notice Returns whether a user is liquidatable under a provided collateral/debt scenario, with metadata.
     *         (Scenario is provided for a specific asset.)
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyUserOrViewer})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U reads (self or VIEW_USER_DATA/ADMIN)
     *
    * @param user Target user address.
     * @param collateral Collateral amount (asset decimals; as expected by RiskManager)
     * @param debt Debt amount (asset decimals; as expected by RiskManager)
    * @param asset Asset address.
    * @return liquidatable True if the RiskManager reports the scenario as liquidatable.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (bool liquidatable, bool isValid, uint256 blockNumber)
    {
        liquidatable = _rm().isLiquidatable(user, collateral, debt, asset);
        return (liquidatable, true, _now());
    }

    /**
     * @notice Returns the liquidation risk score for a user, with metadata.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyUserOrViewer})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U reads (self or VIEW_USER_DATA/ADMIN)
     *
    * @param user Target user address.
    * @return riskScore Risk score in implementation-defined scale.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
     */
    function getLiquidationRiskScore(address user)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 riskScore, bool isValid, uint256 blockNumber)
    {
        riskScore = _rm().getLiquidationRiskScore(user);
        return (riskScore, true, _now());
    }

    /**
     * @notice Batch-check whether users are liquidatable, with metadata.
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks VIEW_USER_DATA or ADMIN (Scheme U batch)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U batch reads (VIEW_USER_DATA/ADMIN)
     *
    * @param users Target user addresses.
    * @return liquidatableFlags Per-user liquidation flags.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
     */
    function batchIsLiquidatable(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyUserBatchViewer
        returns (bool[] memory liquidatableFlags, bool isValid, uint256 blockNumber)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(len, ViewConstants.MAX_BATCH_SIZE);
        }
        liquidatableFlags = _rm().batchIsLiquidatable(users);
        return (liquidatableFlags, true, _now());
    }

    /**
     * @notice Returns liquidation risk scores for a batch of users, with metadata.
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks VIEW_USER_DATA or ADMIN (Scheme U batch)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U batch reads (VIEW_USER_DATA/ADMIN)
     *
    * @param users Target user addresses.
    * @return riskScores Per-user risk scores in implementation-defined scale.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
     */
    function batchGetLiquidationRiskScores(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyUserBatchViewer
        returns (uint256[] memory riskScores, bool isValid, uint256 blockNumber)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(len, ViewConstants.MAX_BATCH_SIZE);
        }
        riskScores = _rm().batchGetLiquidationRiskScores(users);
        return (riskScores, true, _now());
    }

    /*━━━━━━━━━━━━━━━ View (Registry) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the Registry address (preferred getter name).
     * @dev Reverts if:
     *      - (never; may return address(0) if not initialized)
     *
     * Security:
    * - View-only.
     *
    * @return registry Registry address.
     */
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

    function _rm() internal view returns (ILiquidationRiskRead) {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        return ILiquidationRiskRead(rm);
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgradeable ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorizes upgrades for the UUPS proxy.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_ADMIN (via {ViewAccessLib})
     *      - newImplementation is zero (see {ZeroAddress})
     *      - newImplementation is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrades (ACTION_ADMIN)
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the API version of this module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
    * - Pure function.
     *
    * @return version API version.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version of this module.
     * @dev Reverts if:
     *      - (never)
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
    /// @dev Storage gap reserved for future upgrades.
    uint256[50] private __gap;
}
