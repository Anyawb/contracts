///      (see `IPriceOracleAdapterRead.getPrice` for `price` and `decimals` semantics).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {ActionKeys} from "../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../constants/ModuleKeys.sol";
import {NotAContract, ZeroAddress} from "../../errors/StandardErrors.sol";
import {ILendingEngineBasic} from "../../interfaces/ILendingEngineBasic.sol";
import {IVaultCoreMinimal} from "../../interfaces/IVaultCoreMinimal.sol";
import {ViewConstants} from "../view/ViewConstants.sol";
import {SystemEvents} from "../SystemEvents.sol";
import {CacheEvents} from "../CacheEvents.sol";
import {HealthEvents} from "../HealthEvents.sol";
import {LendingEngineStorage} from "./lendingEngine/LendingEngineStorage.sol";
import {LendingEngineValuation} from "./lendingEngine/LendingEngineValuation.sol";
import {LendingEngineCore} from "./lendingEngine/LendingEngineCore.sol";

/// @title IStatisticsPushManagerMinimal
/// @notice Minimal notification interface for StatisticsPushManager.
/// @dev Used by {VaultLendingEngine} to trigger best-effort user statistics
///      refreshes without importing the full push-manager implementation.
interface IStatisticsPushManagerMinimal {
    /// @notice Requests a user statistics refresh.
    function notifyUserStats(address user) external;
}

/**
 * @title VaultLendingEngine
 * @notice Serves as the multi-asset debt-ledger source of truth for Vault borrow, repay, and liquidation writes.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Debt-ledger writes occur here and should be consumed through the debt read and write interfaces where possible.
 * - Write entrypoints are restricted to VaultCore and, where applicable, SettlementManager.
 * - Module address resolution is centralized in Registry.
 * - View and Health updates are best-effort and must not block ledger writes.
 * - State-changing external entrypoints are non-reentrant and upgrades are ACM role-gated.
 */
contract VaultLendingEngine is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    ILendingEngineBasic,
    CacheEvents,
    HealthEvents
{
    using LendingEngineValuation for LendingEngineStorage.Layout;
    using LendingEngineCore for LendingEngineStorage.Layout;

    /// @dev Storage accessor for library-based modules (slot 0)
    function _s()
        internal
        pure
        returns (LendingEngineStorage.Layout storage stor)
    {
        return LendingEngineStorage.layout();
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @notice Multi-asset per-user debt mapping: user -> asset -> debtAmount.
    /// @dev Stores each user's outstanding debt amount per asset in token base units (token decimals).
    mapping(address => mapping(address => uint256)) private _userDebt;

    /// @notice System total debt per asset: asset -> totalDebtAmount.
    /// @dev Aggregate outstanding debt per asset in token base units (token decimals).
    mapping(address => uint256) private _totalDebtByAsset;

    /// @notice Cached total debt value per user in the normalized system valuation unit.
    /// @dev Best-effort cached value normalized to 18 decimals; see `LendingEngineValuation`.
    mapping(address => uint256) private _userTotalDebtValue;

    /// @notice Cached system total debt value in the normalized system valuation unit.
    /// @dev Aggregate of per-user cached total debt values, normalized to 18 decimals.
    uint256 private _totalDebtValue;

    /// @notice Price oracle adapter address (legacy contract slot mirror).
    /// @dev Used for valuation of debt; SSOT for internal logic is `_s()._priceOracleAddr`.
    address private _priceOracleAddr;

    /// @notice Settlement token address (legacy contract slot mirror).
    /// @dev Used by graceful-degradation helpers when deriving fallback valuation context; SSOT is `_s()._settlementTokenAddr`.
    address private _settlementTokenAddr;

    /// @notice Registry address (legacy contract slot mirror).
    /// @dev Used for module discovery and standardized events; SSOT is `_s()._registryAddr`.
    address private _registryAddr;

    /// @notice Cached list of debt assets per user: user -> asset[].
    /// @dev Maintained for efficient traversal of a user's debt assets.
    mapping(address => address[]) private _userDebtAssets;

    /// @notice Index mapping for `_userDebtAssets`: user -> asset -> (index+1).
    /// @dev Uses 1-based indexing to allow 0 to mean "not present".
    mapping(address => mapping(address => uint256)) private _userDebtAssetIndex;

    /// @notice Number of debt assets per user: user -> count.
    /// @dev Mirrors `_userDebtAssets[user].length` as a cached count.
    mapping(address => uint256) private _userDebtAssetCount;

    /// @notice Maximum batch size limit (SSOT: ViewConstants).
    /// @dev Kept consistent with the View layer to avoid constant drift.
    uint256 internal constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /// @notice Annual interest rate per asset: asset -> annualInterestRate (1e18 fixed-point).
    /// @dev 1e18 = 100% APR; used for view-only interest estimations in this module.
    mapping(address => uint256) private _interestRatePerYear;

    /// @notice Storage gap for upgrade safety.
    /// @dev Legacy storage gap kept for storage layout compatibility (do not use).
    uint256[45] private _legacyGap;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /// @notice Ensure the Registry address is configured and is a contract.
    modifier onlyValidRegistry() {
        // IMPORTANT: use the registry address that all internal logic depends on (library storage layout).
        address registryAddress = _s()._registryAddr;
        if (registryAddress == address(0)) revert ZeroAddress();
        if (registryAddress.code.length == 0)
            revert NotAContract(registryAddress);
        _;
    }

    /// @notice Restrict to VaultCore.
    /// @dev `msg.sender` must equal `Registry.getModuleOrRevert(KEY_VAULT_CORE)`.
    modifier onlyVaultCore() {
        if (msg.sender != _getModuleAddress(ModuleKeys.KEY_VAULT_CORE)) {
            revert VaultLendingEngine__OnlyVaultCore();
        }
        _;
    }

    /// @notice Restrict to VaultCore or SettlementManager (repay settlement path).
    modifier onlyVaultCoreOrSettlementManager() {
        address vaultCore = _getModuleAddress(ModuleKeys.KEY_VAULT_CORE);
        // Best-effort: if SettlementManager is not registered, do not block VaultCore.
        address settlementManager = LendingEngineCore._getModuleAddressOrZero(
            _s(),
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        if (msg.sender != vaultCore && msg.sender != settlementManager) {
            revert VaultLendingEngine__OnlyVaultCore();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when an entrypoint is called by an address other than VaultCore
    ///      or a permitted equivalent. Used by VaultCore-gated paths.
    error VaultLendingEngine__OnlyVaultCore();
    /// @dev Reverts when a liquidation debt write is attempted by an unauthorized
    ///      liquidation executor. Used by liquidation write paths.
    error VaultLendingEngine__OnlyLiquidationExecutor();
    /// @dev Reverts when paired array parameters have different lengths. Used by batch debt operations.
    error VaultLendingEngine__LengthMismatch();
    /// @dev Reverts when a required array parameter is empty. Used by batch debt operations.
    error VaultLendingEngine__EmptyArray();
    /// @dev Reverts when a batch operation exceeds the configured maximum size.
    ///      Used by bounded batch debt operations.
    error VaultLendingEngine__BatchTooLarge();
    /// @dev Reverts when a UUPS upgrade target is not a valid implementation contract.
    ///      Used by {_authorizeUpgrade}.
    error VaultLendingEngine__InvalidImplementation();
    /// @dev Reverts when the configured Registry address is missing or not a contract.
    ///      Used by strict registry validation paths.
    error VaultLendingEngine__InvalidRegistry();

    /*━━━━━━━━━━━━━━━ Liquidation Entry Guards ━━━━━━━━━━━━━━━*/
    /// @notice Restricts liquidation debt writes to the liquidation executors (SSOT).
    /// @dev Allows:
    ///      - Registry(KEY_LIQUIDATION_MANAGER)
    ///      - Registry(KEY_SETTLEMENT_MANAGER) (optional; if missing, only liquidation manager is allowed)
    modifier onlyLiquidationExecutor() {
        address liquidationManager = _getModuleAddress(
            ModuleKeys.KEY_LIQUIDATION_MANAGER
        );
        address settlementManager = LendingEngineCore._getModuleAddressOrZero(
            _s(),
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        if (
            msg.sender != liquidationManager &&
            (settlementManager == address(0) || msg.sender != settlementManager)
        ) {
            revert VaultLendingEngine__OnlyLiquidationExecutor();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Internal Functions ━━━━━━━━━━━━━━━*/

    /// @notice Resolve a module address from Registry through the strict library path.
    /// @param moduleKey Registry module key.
    /// @return moduleAddr Module address currently registered under the module key.
    function _getModuleAddress(
        bytes32 moduleKey
    ) internal view returns (address moduleAddr) {
        return LendingEngineCore._getModuleAddress(_s(), moduleKey);
    }

    /// @notice Require an ACM role (strict).
    /// @param actionKey Action key / role hash (see ActionKeys).
    /// @param user Address to validate.
    function _requireRole(bytes32 actionKey, address user) internal view {
        LendingEngineCore._requireRole(_s(), actionKey, user);
    }

    /// @dev Best-effort notify the single Statistics push orchestrator (strict B+).
    ///      This ledger module MUST NOT call StatisticsView directly.
    function _tryNotifyStatsPushManager(address user) internal {
        address mgr = LendingEngineCore._getModuleAddressOrZero(
            _s(),
            ModuleKeys.KEY_STATS_PUSH_MANAGER
        );
        if (mgr == address(0) || mgr.code.length == 0) return;
        try IStatisticsPushManagerMinimal(mgr).notifyUserStats(user) {
            return;
        } catch {
            return;
        }
    }

    /*━━━━━━━━━━━━━━━ Construction & initialization ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when a user's debt for an asset is recorded (borrow/repay/liquidation debt change).
    /// @param user Borrower address.
    /// @param asset Debt asset address.
    /// @param amount Debt delta amount in `asset` token base units (token decimals).
    /// @param isBorrow True for borrow (increase debt), false for repay / debt reduction.
    event DebtRecorded(
        address indexed user,
        address indexed asset,
        uint256 amount,
        bool isBorrow
    );

    /// @notice Emitted when the cached total debt value for a user is updated.
    /// @dev Value is computed by summing per-asset valuations produced by
    ///      `GracefulDegradation.getAssetValueWithFallback`.
    /// @param user Borrower address.
    /// @param oldValue Previous cached total debt value (see @dev for valuation semantics).
    /// @param newValue New cached total debt value (see @dev for valuation semantics).
    event UserTotalDebtValueUpdated(
        address indexed user,
        uint256 oldValue,
        uint256 newValue
    );

    /// @notice Emitted when the configured price oracle address is updated by governance.
    /// @param oldOracle Previous oracle address.
    /// @param newOracle New oracle address.
    event PriceOracleUpdated(
        address indexed oldOracle,
        address indexed newOracle
    );

    /// @notice Emitted when the configured settlement token address is updated by governance.
    /// @param oldToken Previous settlement token address.
    /// @param newToken New settlement token address.
    event SettlementTokenUpdated(
        address indexed oldToken,
        address indexed newToken
    );

    /// @notice Emitted when the configured Registry address is updated.
    /// @dev This contract currently does not expose a governance setter for Registry.
    ///      The event is kept for ABI compatibility.
    /// @param oldRegistry Previous Registry address.
    /// @param newRegistry New Registry address.
    event RegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    /// @notice Emitted after a batch debt-related operation completes.
    /// @param user User address the batch operation is associated with (if applicable).
    /// @param operations Number of operations processed in the batch.
    event BatchDebtOperationsCompleted(
        address indexed user,
        uint256 operations
    );

    /// @notice Emitted when an asset's annual interest rate is updated.
    /// @param asset Asset address.
    /// @param oldRate Previous annual rate in 1e18 fixed-point (1e18 = 100%).
    /// @param newRate New annual rate in 1e18 fixed-point (1e18 = 100%).
    event InterestRateUpdated(
        address indexed asset,
        uint256 oldRate,
        uint256 newRate
    );

    /// @notice Emitted when valuation falls back to a degraded pricing path.
    /// @dev `fallbackPrice` is the computed value output from `GracefulDegradation`, where value is derived as:
    ///      `amount * price / 10**oracleDecimals`
    ///      (see `IPriceOracleAdapterRead.getPrice` for `price` and `decimals` semantics).
    /// @param asset Asset being valued.
    /// @param reason Human-readable reason for degradation.
    /// @param fallbackPrice Fallback value produced by the degradation strategy (see @dev).
    /// @param usedFallback True if a fallback strategy was used; false if the primary path was healthy.
    event VaultLendingEngineGracefulDegradation(
        address indexed asset,
        string reason,
        uint256 fallbackPrice,
        bool usedFallback
    );

    /// @notice Emitted when a price oracle health check is performed for an asset.
    /// @param asset Asset being checked.
    /// @param isHealthy True if the oracle path is considered healthy.
    /// @param details Human-readable health-check details.
    event VaultLendingEnginePriceOracleHealthCheck(
        address indexed asset,
        bool isHealthy,
        string details
    );

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /**
     * @notice Initialize the VaultLendingEngine module.
     * @dev Reverts if:
     *      - called more than once (initializer)
     *      - initialPriceOracle == address(0) (ZeroAddress)
     *      - initialSettlementToken == address(0) (ZeroAddress)
     *      - initialRegistry == address(0) (ZeroAddress)
     *
     * Security:
     * - Initializer: single-use initialization (OpenZeppelin Initializable).
     * - Stores addresses in BOTH legacy contract slots and the library storage layout
     *   to preserve storage layout compatibility.
     *
     * @param initialPriceOracle Price oracle adapter address used for valuation.
     * @param initialSettlementToken Settlement token address used as the valuation denomination reference.
     * @param initialRegistry Registry address used for module discovery and standardized event emission.
     */
    function initialize(
        address initialPriceOracle,
        address initialSettlementToken,
        address initialRegistry
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        // NOTE: this module does not enable Pausable at the module layer.

        if (initialPriceOracle == address(0)) revert ZeroAddress();
        if (initialSettlementToken == address(0)) revert ZeroAddress();
        if (initialRegistry == address(0)) revert ZeroAddress();

        _priceOracleAddr = initialPriceOracle;
        _settlementTokenAddr = initialSettlementToken;
        _registryAddr = initialRegistry;

        // Keep library storage layout in sync (SSOT for internal logic).
        LendingEngineStorage.Layout storage s = _s();
        s._priceOracleAddr = initialPriceOracle;
        s._settlementTokenAddr = initialSettlementToken;
        s._registryAddr = initialRegistry;

        // Emit standardized action event (observability).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return a user's current debt balance for an asset.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; reads the ledger SSOT from the library storage layout.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @return debt Current debt amount in `asset` token base units (token decimals).
     */
    function getDebt(
        address user,
        address asset
    ) external view onlyValidRegistry returns (uint256 debt) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _s()._userDebt[user][asset];
    }

    /**
     * @notice Return the system total debt for an asset.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; reads the ledger SSOT from the library storage layout.
     *
     * @param asset Debt asset address.
     * @return totalDebt Total outstanding debt for `asset` in token base units (token decimals).
     */
    function getTotalDebtByAsset(
        address asset
    ) external view onlyValidRegistry returns (uint256 totalDebt) {
        if (asset == address(0)) revert ZeroAddress();
        return _s()._totalDebtByAsset[asset];
    }

    /**
    * @notice Return the total debt value for a user in the normalized system valuation unit.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
    * - View-only; recomputes the total from per-asset debt positions using the protocol valuation helper.
     * - Valuation is best-effort; missing price configuration does not revert debt writes.
     *
     * @param user Borrower address.
    * @return totalValue Total debt value for the user normalized to 18 decimals.
     */
    function getUserTotalDebtValue(
        address user
    ) external view onlyValidRegistry returns (uint256 totalValue) {
        return getUserTotalDebtValueBestEffort(user);
    }

    /**
    * @notice Return the best-effort total debt value for a user in the normalized system valuation unit.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     */
    function getUserTotalDebtValueBestEffort(
        address user
    ) public view onlyValidRegistry returns (uint256 totalValue) {
        if (user == address(0)) revert ZeroAddress();
        return LendingEngineValuation.calculateUserTotalDebtValueBestEffort(_s(), user);
    }

    /**
    * @notice Return the strict total debt value for a user in the normalized system valuation unit.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     *      - any authoritative price read required for valuation fails
     */
    function getUserTotalDebtValueStrict(
        address user
    ) public view onlyValidRegistry returns (uint256 totalValue) {
        if (user == address(0)) revert ZeroAddress();
        return LendingEngineValuation.calculateUserTotalDebtValueStrict(_s(), user);
    }

    /**
    * @notice Return the cached system total debt value in the normalized system valuation unit.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *
     * Security:
     * - View-only; returns the cached system total maintained by per-user debt valuation updates.
     *
    * @return totalValue Cached system total debt value normalized to 18 decimals.
     */
    function getTotalDebtValue()
        external
        view
        onlyValidRegistry
        returns (uint256 totalValue)
    {
        return _s()._totalDebtValue;
    }

    /**
     * @notice Return the list of assets a user currently has debt in.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; returns the ledger-maintained asset list for efficient traversal.
     *
     * @param user Borrower address.
     * @return assets Asset addresses for which the user currently has non-zero debt.
     */
    function getUserDebtAssets(
        address user
    ) external view onlyValidRegistry returns (address[] memory assets) {
        if (user == address(0)) revert ZeroAddress();
        LendingEngineStorage.Layout storage s = _s();
        uint256 count = s._userDebtAssetCount[user];
        assets = new address[](count);

        for (uint256 i = 0; i < count; i++) {
            assets[i] = s._userDebtAssets[user][i];
        }
    }

    /**
     * @notice Estimate expected interest for borrowing a given amount of an asset (simple annualized model).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; uses the governance-configured `annualInterestRate` mapping.
     * - This is a simplified estimation helper and is NOT used as the canonical settlement computation.
     *
     * @param user Borrower address (unused; reserved for future per-user rate models).
     * @param asset Debt asset address.
     * @param amount Principal amount in `asset` token base units (token decimals).
     * @return interest Estimated interest amount in token base units.
     */
    function calculateExpectedInterest(
        address user,
        address asset,
        uint256 amount
    ) external view onlyValidRegistry returns (uint256 interest) {
        user; // silence unused parameter
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) return 0;

        uint256 rate = _interestRatePerYear[asset];
        if (rate == 0) return 0;

        // interest = amount * rate / 1e18
        interest = (amount * rate) / 1e18;
    }

    /**
     * @notice Return the annual interest rate for an asset in basis points.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; converts stored 1e18 fixed-point to bps (1e4 = 100%).
     *
     * @param asset Asset address.
     * @return annualRateBps Current annual interest rate in bps.
     */
    function estimateAnnualRateBps(
        address asset
    ) external view onlyValidRegistry returns (uint256 annualRateBps) {
        if (asset == address(0)) revert ZeroAddress();
        uint256 rate1e18 = _interestRatePerYear[asset];
        if (rate1e18 == 0) return 0;
        // annualRateBps = rate1e18 * 1e4 / 1e18
        unchecked {
            annualRateBps = (rate1e18 * 10000) / 1e18;
        }
    }

    /**
     * @notice Estimate interest for a principal over a term (day-based; simple pro-rata model).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; uses a simplified pro-rata model: `principal * rate * termDays / 365`.
     *
     * @param asset Debt asset address.
     * @param principal Principal amount in `asset` token base units (token decimals).
     * @param termDays Loan term in days. If 0, returns full-year interest.
     * @return interest Estimated interest amount in token base units.
     */
    function estimateInterest(
        address asset,
        uint256 principal,
        uint16 termDays
    ) external view onlyValidRegistry returns (uint256 interest) {
        if (asset == address(0)) revert ZeroAddress();
        if (principal == 0) return 0;
        uint256 rate = _interestRatePerYear[asset];
        if (rate == 0) return 0;
        unchecked {
            if (termDays == 0) {
                // Full-year interest.
                return (principal * rate) / 1e18;
            }
            // principal * rate(1e18) * termDays / (365 * 1e18)
            return (principal * rate * uint256(termDays)) / (365 * 1e18);
        }
    }

    /*━━━━━━━━━━━━━━━ Internal Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Check whether the price-oracle path is healthy for an asset through a best-effort diagnostic helper.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only diagnostic helper.
     *
     * @param oracle Price oracle adapter address.
     * @param asset Asset address.
     * @return isHealthy True if the oracle path is currently considered healthy.
     * @return details Human-readable health-check details.
     */
    function _checkPriceOracleHealth(
        address oracle,
        address asset
    ) internal view returns (bool isHealthy, string memory details) {
        return LendingEngineValuation.checkPriceOracleHealth(oracle, asset);
    }

    /*━━━━━━━━━━━━━━━ Business Logic ━━━━━━━━━━━━━━━*/
    /**
     * @notice Record a borrow: increases the user's debt for an asset (ledger write SSOT).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - msg.sender != VaultCore (VaultLendingEngine__OnlyVaultCore) (via onlyVaultCore)
     *      - amount == 0 (AmountIsZero) (via LendingEngineAccounting)
     *      - user == address(0) (ZeroAddress) (via LendingEngineAccounting)
     *      - asset == address(0) (ZeroAddress) (via LendingEngineAccounting)
     *      - amount cannot be represented as int256
     *        (LendingEngineCore__AmountOverflowInt256) (via LendingEngineCore)
     *      - valuation delta underflows system total
     *        (LendingEngineValuation__TotalDebtValueUnderflow) (via LendingEngineValuation)
     *
     * Security:
     * - Non-reentrant (ReentrancyGuardUpgradeable).
     * - Ledger SSOT: debt is recorded first; View/Health pushes are best-effort and do NOT revert the ledger.
     * - Only VaultCore may write borrow debt changes.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Borrow amount in `asset` token base units (token decimals).
     * @param collateralAdded Reserved parameter (unused in this module; supplied by higher-level flows).
     * @param termDays Loan term in days (0 = unspecified).
     */
    function borrow(
        address user,
        address asset,
        uint256 amount,
        uint256 collateralAdded,
        uint16 termDays
    ) external override onlyValidRegistry onlyVaultCore nonReentrant {
        collateralAdded; // silence unused parameter
        _s().borrow(user, asset, amount, termDays);
        _tryNotifyStatsPushManager(user);
    }

    /**
     * @notice Record a repay: decreases the user's debt for an asset (ledger write SSOT).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - msg.sender is not VaultCore nor SettlementManager
     *        (VaultLendingEngine__OnlyVaultCore) (via onlyVaultCoreOrSettlementManager)
     *      - amount == 0 (AmountIsZero) (via LendingEngineAccounting)
     *      - user == address(0) (ZeroAddress) (via LendingEngineAccounting)
     *      - asset == address(0) (ZeroAddress) (via LendingEngineAccounting)
     *      - amount > current debt (Overpay) (via LendingEngineAccounting)
     *      - amount cannot be represented as int256
     *        (LendingEngineCore__AmountOverflowInt256) (via LendingEngineCore)
     *      - valuation delta underflows system total
     *        (LendingEngineValuation__TotalDebtValueUnderflow) (via LendingEngineValuation)
     *
     * Security:
     * - Non-reentrant (ReentrancyGuardUpgradeable).
     * - Ledger SSOT: repayment is recorded first; View/Health pushes are best-effort and do NOT revert the ledger.
     * - Caller-gated: VaultCore (primary) and SettlementManager (repay settlement path).
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Repay amount in `asset` token base units (token decimals).
     */
    function repay(
        address user,
        address asset,
        uint256 amount
    )
        external
        override
        onlyValidRegistry
        onlyVaultCoreOrSettlementManager
        nonReentrant
    {
        _s().repay(user, asset, amount);
        _tryNotifyStatsPushManager(user);
    }

    /**
     * @notice Force-reduce a user's debt for an asset (liquidation path).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - msg.sender is not an authorized liquidation executor
     *        (VaultLendingEngine__OnlyLiquidationExecutor) (via onlyLiquidationExecutor)
     *      - caller lacks ACTION_LIQUIDATE role (MissingRole) (via LendingEngineCore -> ACM.requireRole)
     *      - amount == 0 (AmountIsZero) (via LendingEngineAccounting)
     *      - user == address(0) (ZeroAddress) (via LendingEngineAccounting)
     *      - asset == address(0) (ZeroAddress) (via LendingEngineAccounting)
     *      - amount cannot be represented as int256
     *        (LendingEngineCore__AmountOverflowInt256) (via LendingEngineCore)
     *      - valuation delta underflows system total
     *        (LendingEngineValuation__TotalDebtValueUnderflow) (via LendingEngineValuation)
     *
     * Security:
     * - Non-reentrant (ReentrancyGuardUpgradeable).
     * - Dual gating: (1) executor address allowlist via Registry keys; (2) role check ACTION_LIQUIDATE via ACM.
     * - Ledger SSOT: debt is recorded first; View/Health pushes are best-effort and do NOT revert the ledger.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Requested debt reduction amount in `asset` token base units (token decimals).
     *              If amount > debt, full debt is reduced.
     */
    function forceReduceDebt(
        address user,
        address asset,
        uint256 amount
    ) external override onlyValidRegistry onlyLiquidationExecutor nonReentrant {
        _s().forceReduceDebt(user, asset, amount);
        _tryNotifyStatsPushManager(user);
    }

    /// @notice Update the cached total debt value for a user through the valuation library.
    /// @dev Best-effort valuation helper; see `LendingEngineValuation.updateUserTotalDebtValue`.
    /// @param user Borrower address.
    function _updateUserTotalDebtValue(address user) internal {
        _s().updateUserTotalDebtValue(user);
    }

    /*━━━━━━━━━━━━━━━ Admin Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Batch recompute cached debt values for a set of users (governance operation).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (MissingRole) (via ACM.requireRole)
     *      - users.length == 0 (VaultLendingEngine__EmptyArray)
     *      - users.length > _MAX_BATCH_SIZE (VaultLendingEngine__BatchTooLarge)
     *      - any users[i] == address(0) (ZeroAddress)
     *      - valuation delta underflows system total
     *        (LendingEngineValuation__TotalDebtValueUnderflow) (via LendingEngineValuation)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     * - Best-effort valuation: missing oracle or settlement configuration emits events and keeps the previous
     *   cached values.
     *
     * @param users Array of user addresses to recompute cached debt values for.
     */
    function batchUpdateUserDebtValues(
        address[] calldata users
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (users.length == 0) revert VaultLendingEngine__EmptyArray();
        if (users.length > _MAX_BATCH_SIZE)
            revert VaultLendingEngine__BatchTooLarge();

        // Gas optimization: use unchecked increment in the loop.
        unchecked {
            for (uint256 i = 0; i < users.length; i++) {
                if (users[i] == address(0)) revert ZeroAddress();
                _updateUserTotalDebtValue(users[i]);
            }
        }

        // Emit standardized action event (observability).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Set the price oracle address used for debt valuation (governance operation).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (MissingRole) (via ACM.requireRole)
     *      - newPriceOracle == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     * - Updates BOTH legacy contract slots and library storage layout to preserve storage layout compatibility.
     *
     * @param newPriceOracle New price oracle adapter address.
     */
    function setPriceOracle(address newPriceOracle) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newPriceOracle == address(0)) revert ZeroAddress();

        address oldOracle = _priceOracleAddr;
        _priceOracleAddr = newPriceOracle;
        // Keep library storage in sync (SSOT for internal logic is the library layout).
        _s()._priceOracleAddr = newPriceOracle;

        emit PriceOracleUpdated(oldOracle, newPriceOracle);

        // Emit standardized action event (observability).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Set the settlement token address used as the valuation denomination reference (governance operation).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (MissingRole) (via ACM.requireRole)
     *      - newSettlementToken == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     * - Updates BOTH legacy contract slots and library storage layout to preserve storage layout compatibility.
     *
     * @param newSettlementToken New settlement token address.
     */
    function setSettlementToken(
        address newSettlementToken
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newSettlementToken == address(0)) revert ZeroAddress();

        address oldToken = _settlementTokenAddr;
        _settlementTokenAddr = newSettlementToken;
        // Keep library storage in sync (SSOT for internal logic is the library layout).
        _s()._settlementTokenAddr = newSettlementToken;

        emit SettlementTokenUpdated(oldToken, newSettlementToken);

        // Emit standardized action event (observability).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Set the annual interest rate for an asset (governance operation).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (MissingRole) (via ACM.requireRole)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param asset Asset address.
     * @param annualRate Annual rate in 1e18 fixed-point (1e18 = 100%).
     */
    function setInterestRate(
        address asset,
        uint256 annualRate
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();

        uint256 oldRate = _interestRatePerYear[asset];
        _interestRatePerYear[asset] = annualRate;

        emit InterestRateUpdated(asset, oldRate, annualRate);

        // Emit standardized action event (observability).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Return the configured annual interest rate for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param asset Asset address.
     * @return annualRate Current annual rate in 1e18 fixed-point.
     */
    function interestRatePerYear(
        address asset
    ) external view returns (uint256 annualRate) {
        return _interestRatePerYear[asset];
    }

    /*━━━━━━━━━━━━━━━ Upgrade Auth ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - caller lacks ACTION_UPGRADE_MODULE (MissingRole) (via ACM.requireRole)
     *      - newImplementation == address(0) (ZeroAddress)
     *      - newImplementation has no code (VaultLendingEngine__InvalidImplementation)
     *
     * Security:
     * - UUPSUpgradeable: upgrade authorization is SSOT here.
     * - Role-gated via ACM.requireRole(ACTION_UPGRADE_MODULE).
     *
     * @param newImplementation New implementation contract address.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();

        // Validate new implementation contract.
        if (newImplementation.code.length == 0)
            revert VaultLendingEngine__InvalidImplementation();

        // Emit standardized action event (observability).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ ILendingEngineBasic: Minimal Ledger Implementations ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the current reducible debt amount for a user and asset (liquidation helper).
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; returns current debt balance from the ledger SSOT.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @return reducibleAmount Current reducible debt amount in token base units.
     */
    function getReducibleDebtAmount(
        address user,
        address asset
    ) external view onlyValidRegistry returns (uint256 reducibleAmount) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _s()._userDebt[user][asset];
    }

    /**
    * @notice Compute the debt value for a user's single asset position in the normalized system valuation unit.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only; this calls into `GracefulDegradation` helpers and is intended for UI/analytics.
     * - The valuation semantics follow `GracefulDegradation.getAssetValueWithFallback`.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
    * @return value Current debt value normalized to 18 decimals.
     */
    function calculateDebtValue(
        address user,
        address asset
    ) external view onlyValidRegistry returns (uint256 value) {
        return calculateDebtValueBestEffort(user, asset);
    }

    /**
    * @notice Compute the best-effort debt value for a user's single asset position in the normalized system valuation unit.
     */
    function calculateDebtValueBestEffort(
        address user,
        address asset
    ) public view onlyValidRegistry returns (uint256 value) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return LendingEngineValuation.calculateDebtValueBestEffort(_s(), user, asset);
    }

    /**
    * @notice Compute the strict debt value for a user's single asset position in the normalized system valuation unit.
     */
    function calculateDebtValueStrict(
        address user,
        address asset
    ) public view onlyValidRegistry returns (uint256 value) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return LendingEngineValuation.calculateDebtValueStrict(_s(), user, asset);
    }

    // Reward hooks were intentionally removed from this module.
    // Reward SSOT is handled by the ORDER_ENGINE / RewardManager flow, not the debt ledger.

    /**
     * @notice Legacy no-op: previously pushed full user position to View cache (compat shim).
     * @dev The SSOT is now delta-based pushes implemented in `LendingEngineCore.borrow/repay/forceReduceDebt`.
     *      This function remains as a no-op to preserve backward compatibility for older linkages.
     */
    function _pushUserPositionToView(
        address user,
        address asset
    ) internal pure {
        // Legacy no-op (compat shim).
        user;
        asset;
    }

    /// @notice Resolve the current VaultRouter address (via Registry -> VaultCore).
    function _resolveVaultRouterAddr() internal view returns (address) {
        // Best-effort helper: must not revert when used by diagnostics or cache-push paths.
        address vaultCore = LendingEngineCore._getModuleAddressOrZero(
            _s(),
            ModuleKeys.KEY_VAULT_CORE
        );
        if (vaultCore == address(0) || vaultCore.code.length == 0)
            return address(0);
        try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (
            address v
        ) {
            return v;
        } catch {
            return address(0);
        }
    }

    /// @notice Aggregate collateral and debt values, then push the resulting health status through a best-effort path.
    function _pushHealthStatus(address user) internal {
        LendingEngineCore._pushHealthStatus(_s(), user);
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
