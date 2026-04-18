// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {Registry} from "../../../registry/Registry.sol";
import {
    ZeroAddress,
    BatchTooLarge,
    EmptyArray,
    ArrayLengthMismatch,
    MissingRole,
    NotAContract,
    InvalidCaller
} from "../../../errors/StandardErrors.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {ILiquidationEventsView} from "../../../interfaces/ILiquidationEventsView.sol";
import {DataPushLibrary} from "../../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../../constants/DataPushTypes.sol";
import {ICollateralManager} from "../../../interfaces/ICollateralManager.sol";
import {IPositionViewValuation} from "../../../interfaces/IPositionViewValuation.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {ViewVersioned} from "../ViewVersioned.sol";

/**
 * @title LiquidatorView
 * @notice Liquidation view module that exposes role-gated reads and forwards liquidation updates/payouts to DataPush.
 * @dev Reverts if:
 *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
 *      - caller lacks required view permissions (see access-control modifiers)
 *      - unauthorized module attempts to push (see {InvalidCaller})
 *
 * Security:
 * - Role-gated reads via {ViewAccessLib} and {ActionKeys}
 * - Writer-gated pushes: only Registry-resolved liquidation modules may push updates.
 * - Push payloads preserve writer-provided token-native amounts and reporting fields; this module does not
 *   reinterpret bonus or payout amounts as normalized valuation-unit fields.
 * - Not an SSOT for ledger state; this is a view/cache push surface
 */
contract LiquidatorView is
    Initializable,
    UUPSUpgradeable,
    ILiquidationEventsView,
    ViewVersioned
{
    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a caller-provided `limit` parameter is invalid (e.g., zero).
    error LiquidatorView__InvalidLimit();

    /*━━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━━*/
    /// @notice Registry address (module resolution SSOT).
    address private _registryAddr;

    /// @notice Legacy SystemView placeholder (optional, backwards compatibility).
    address private _legacySystemViewAddr;

    /*━━━━━━━━━━━━━━━ Local Types (formerly LiquidationViewTypes) ━━━━━━━━━━━━━━━*/
    struct LiquidatorProfitView {
        address liquidator;
        uint256 totalProfit;
        uint256 totalLiquidations;
        uint256 lastLiquidationBlock;
        uint256 totalProfitValue;
        uint256 averageProfitPerLiquidation;
        uint256 blocksSinceLastLiquidation;
    }

    struct GlobalLiquidationView {
        uint256 totalLiquidations;
        uint256 totalProfitDistributed;
        uint256 totalLiquidators;
        uint256 averageProfitPerLiquidation;
        uint256 lastLiquidationBlock;
        uint256 liquidationSuccessRate;
    }

    /*━━━━━━━━━━━━━━━ DATA PUSH TYPES ━━━━━━━━━━━━━━━*/
    // NOTE: Prefer centralized DataPushTypes to avoid duplicated keccak256 constants across modules.
    bytes32 public constant DATA_TYPE_LIQUIDATION_UPDATE =
        DataPushTypes.DATA_TYPE_LIQUIDATION_UPDATE;
    bytes32 public constant DATA_TYPE_LIQUIDATION_BATCH_UPDATE =
        DataPushTypes.DATA_TYPE_LIQUIDATION_BATCH_UPDATE;
    bytes32 public constant DATA_TYPE_LIQUIDATION_PAYOUT =
        DataPushTypes.DATA_TYPE_LIQUIDATION_PAYOUT;

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Ensure Registry is configured.
     * @dev Reverts if:
     *      - `_registryAddr` is zero
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @notice Require system-level view permission.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     */
    modifier onlySystemViewer() {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_SYSTEM_DATA,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        _;
    }

    /**
     * @notice Require risk-level view permission.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_RISK_DATA
     */
    modifier onlyRiskViewer() {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_RISK_DATA,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        _;
    }

    /**
     * @notice Restrict liquidation-update push entrypoints to the configured liquidation writers.
     * @dev Reverts if:
     *      - caller is neither Registry.KEY_LIQUIDATION_MANAGER nor Registry.KEY_SETTLEMENT_MANAGER
     */
    modifier onlyLiquidationWriter() {
        address lm = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_MANAGER
        );
        address sm = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        if (msg.sender != lm && msg.sender != sm) revert InvalidCaller();
        _;
    }

    /**
     * @notice Restrict payout push entrypoint to liquidation manager, settlement manager, or payout manager.
     * @dev Reverts if:
     *      - caller is none of Registry.KEY_LIQUIDATION_MANAGER, Registry.KEY_SETTLEMENT_MANAGER,
     *        or Registry.KEY_LIQUIDATION_PAYOUT_MANAGER
     */
    modifier onlyLiquidationOrPayoutModule() {
        address lm = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_MANAGER
        );
        address sm = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        address pm = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER
        );
        if (msg.sender != lm && msg.sender != sm && msg.sender != pm)
            revert InvalidCaller();
        _;
    }

    /**
     * @notice Require liquidation view permission.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_LIQUIDATION_DATA
     */
    modifier onlyLiquidationViewer() {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_LIQUIDATION_DATA,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        _;
    }

    /**
     * @notice Require caller to be authorized to view `user` data.
     * @dev Reverts if:
     *      - access check fails in `_checkUserAccess`
     *
     * @param user Target user address
     */
    modifier onlyUserData(address user) {
        _checkUserAccess(user);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize LiquidatorView.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero
     *
     * Security:
     * - Initializer guarded (initializer modifier)
     *
     * @param initialRegistryAddr Registry address (module resolver SSOT)
     * @param initialSystemView Optional legacy SystemView address (can be zero)
     */
    function initialize(
        address initialRegistryAddr,
        address initialSystemView
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _legacySystemViewAddr = initialSystemView;
    }

    /**
     * @notice Get legacy SystemView address (compatibility).
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - View only
     *
     * @return systemView Legacy SystemView address (may be zero)
     */
    function systemViewVar() external view returns (address systemView) {
        return _legacySystemViewAddr;
    }

    /*━━━━━━━━━━━━━━━ PUSH FROM BUSINESS (SINGLE POINT) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Push a single liquidation update into the unified DataPush stream.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not an authorized liquidation writer (see {InvalidCaller})
     *
     * Security:
     * - Writer-gated: only the liquidation manager or settlement manager module may push updates
     * - Emits {DataPushTypes.DATA_TYPE_LIQUIDATION_UPDATE} for off-chain consumers
     *
     * @param user User address
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Collateral amount seized (collateral-token native decimals; as provided by writer)
     * @param debtAmount Debt amount reduced (debt-token native decimals; as provided by writer)
     * @param liquidator Liquidator address
     * @param bonus Liquidation bonus reporting value. Current writers treat this as a collateral-side token-native
     *        amount hint; consumers MUST NOT assume it is a normalized value-unit field.
     * @param blockNumber Event block number (as provided by writer)
     */
    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 blockNumber
    ) external override onlyValidRegistry onlyLiquidationWriter {
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_UPDATE,
            abi.encode(
                user,
                collateralAsset,
                debtAsset,
                collateralAmount,
                debtAmount,
                liquidator,
                bonus,
                blockNumber
            )
        );
    }

    /**
     * @notice Push a batch liquidation update into the unified DataPush stream.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not an authorized liquidation writer (see {InvalidCaller})
     *
     * Security:
     * - Writer-gated: only the liquidation manager or settlement manager module may push updates
     * - Assumes writer provides aligned arrays (this function does not validate lengths)
     * - Emits {DataPushTypes.DATA_TYPE_LIQUIDATION_BATCH_UPDATE} for off-chain consumers
     *
     * @param users User addresses
     * @param collateralAssets Collateral asset addresses
     * @param debtAssets Debt asset addresses
     * @param collateralAmounts Collateral amounts seized (collateral-token native decimals; as provided by writer)
     * @param debtAmounts Debt amounts reduced (debt-token native decimals; as provided by writer)
     * @param liquidator Liquidator address (applies to the batch)
     * @param bonuses Liquidation bonus reporting values; consumers MUST NOT assume these entries share the
     *        normalized valuation-unit semantics of protocol value totals.
     * @param blockNumber Event block number (as provided by writer)
     */
    function pushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 blockNumber
    ) external override onlyValidRegistry onlyLiquidationWriter {
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_BATCH_UPDATE,
            abi.encode(
                users,
                collateralAssets,
                debtAssets,
                collateralAmounts,
                debtAmounts,
                liquidator,
                bonuses,
                blockNumber
            )
        );
    }

    /**
     * @notice Push liquidation payout distribution into the unified DataPush stream.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not liquidation manager, settlement manager, or payout manager (see {InvalidCaller})
     *
     * Security:
     * - Writer-gated: only liquidation/settlement/payout modules may push updates
     * - Emits {DataPushTypes.DATA_TYPE_LIQUIDATION_PAYOUT} for off-chain consumers
     *
     * @param user User address
     * @param collateralAsset Collateral asset address
     * @param platform Platform payout recipient address
     * @param reserve Reserve payout recipient address
     * @param lender Lender payout recipient address
     * @param liquidator Liquidator payout recipient address
     * @param platformShare Platform share amount (collateral-token native decimals; as provided by writer)
     * @param reserveShare Reserve share amount (collateral-token native decimals; as provided by writer)
     * @param lenderShare Lender share amount (collateral-token native decimals; as provided by writer)
     * @param liquidatorShare Liquidator share amount (collateral-token native decimals; as provided by writer)
     * @param blockNumber Event block number (as provided by writer)
     */
    function pushLiquidationPayout(
        address user,
        address collateralAsset,
        address platform,
        address reserve,
        address lender,
        address liquidator,
        uint256 platformShare,
        uint256 reserveShare,
        uint256 lenderShare,
        uint256 liquidatorShare,
        uint256 blockNumber
    ) external override onlyValidRegistry onlyLiquidationOrPayoutModule {
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_PAYOUT,
            abi.encode(
                user,
                collateralAsset,
                platform,
                reserve,
                lender,
                liquidator,
                platformShare,
                reserveShare,
                lenderShare,
                liquidatorShare,
                blockNumber
            )
        );
    }

    function _resolvePositionViewAddr() internal view returns (address) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW);
    }

    /*━━━━━━━━━━━━━━━ REGISTRY HELPERS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Resolve a module address from Registry.
     * @dev Reverts if:
     *      - module is not registered (Registry.getModuleOrRevert)
     *
     * @param moduleKey Module key
     * @return Module address
     */
    function _getModuleFromRegistry(
        bytes32 moduleKey
    ) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Check whether a module is registered in Registry.
     * @dev Reverts if: (never)
     *
     * @param moduleKey Module key
     * @return isRegistered True if the module is registered.
     */
    function _isModuleRegistered(
        bytes32 moduleKey
    ) internal view returns (bool isRegistered) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /*━━━━━━━━━━━━━━━ LIQUIDATOR PROFIT / STATS (PLACEHOLDER) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get liquidator profit statistics view (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @param liquidator Liquidator address
     * @return profitView Profit/statistics view (placeholder values)
     */
    function getLiquidatorProfitView(
        address liquidator
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (LiquidatorProfitView memory profitView)
    {
        profitView = _buildLiquidatorProfitView(liquidator);
    }

    /**
     * @notice Get liquidator profit statistics view with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @param liquidator Liquidator address
     * @return profitView Profit/statistics view (placeholder values)
     * @return blockNumber Last update block number (0 for off-chain aggregation placeholder)
     * @return isValid Whether the snapshot is considered fresh (false for placeholder)
     */
    function getLiquidatorProfitViewWithMeta(
        address liquidator
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            LiquidatorProfitView memory profitView,
            uint256 blockNumber,
            bool isValid
        )
    {
        profitView = _buildLiquidatorProfitView(liquidator);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get global liquidation statistics view (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @return globalView Global liquidation view (placeholder values)
     */
    function getGlobalLiquidationView()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (GlobalLiquidationView memory globalView)
    {
        globalView = _buildGlobalLiquidationView();
    }

    /**
     * @notice Get global liquidation statistics view with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @return globalView Global liquidation view (placeholder values)
     * @return blockNumber Last update block number (0 for off-chain aggregation placeholder)
     * @return isValid Whether the snapshot is considered fresh (false for placeholder)
     */
    function getGlobalLiquidationViewWithMeta()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            GlobalLiquidationView memory globalView,
            uint256 blockNumber,
            bool isValid
        )
    {
        globalView = _buildGlobalLiquidationView();
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Batch get liquidator profit statistics views (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - `liquidators` is empty (EmptyArray)
     *      - length exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @param liquidators Array of liquidator addresses
     * @return views Array of views (placeholder values)
     */
    function batchGetLiquidatorProfitViews(
        address[] calldata liquidators
    )
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (LiquidatorProfitView[] memory views)
    {
        uint256 len = liquidators.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(len, ViewConstants.MAX_BATCH_SIZE);
        }
        views = new LiquidatorProfitView[](len);
        for (uint256 i = 0; i < len; i++) {
            views[i] = _buildLiquidatorProfitView(liquidators[i]);
        }
    }

    /**
     * @notice Batch get liquidator profit statistics views with staleness metadata.
     * @dev Reverts if:
     *      - `liquidators` is empty (EmptyArray)
     *      - length exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @param liquidators Array of liquidator addresses
     * @return views Array of views (placeholder values)
     * @return blockNumber Last update block number (0 for off-chain aggregation placeholder)
     * @return isValid Whether the snapshot is considered fresh (false for placeholder)
     */
    function batchGetLiquidatorProfitViewsWithMeta(
        address[] calldata liquidators
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            LiquidatorProfitView[] memory views,
            uint256 blockNumber,
            bool isValid
        )
    {
        views = batchGetLiquidatorProfitViews(liquidators);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get liquidator leaderboard (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - `limit` is zero (LiquidatorView__InvalidLimit)
     *      - `limit` exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @param limit Max number of entries to return
     * @return liquidators Liquidator address list (currently empty placeholder)
     * @return profits Profit amounts (currently empty placeholder)
     * @return liquidations Liquidation counts (currently empty placeholder)
     */
    function getLiquidatorLeaderboard(
        uint256 limit
    )
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            address[] memory liquidators,
            uint256[] memory profits,
            uint256[] memory liquidations
        )
    {
        if (limit == 0) revert LiquidatorView__InvalidLimit();
        if (limit > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(limit, ViewConstants.MAX_BATCH_SIZE);
        }
        // Aggregated off-chain; return empty placeholders on-chain.
        liquidators = new address[](0);
        profits = new uint256[](0);
        liquidations = new uint256[](0);
    }

    /**
     * @notice Get liquidator leaderboard with staleness metadata.
     * @dev Reverts if:
     *      - `limit` is zero (LiquidatorView__InvalidLimit)
     *      - `limit` exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorLeaderboardWithMeta(
        uint256 limit
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            address[] memory liquidators,
            uint256[] memory profits,
            uint256[] memory liquidations,
            uint256 blockNumber,
            bool isValid
        )
    {
        (liquidators, profits, liquidations) = getLiquidatorLeaderboard(limit);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get liquidator temporary debt info (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @param liquidator Liquidator address
     * @param asset Asset address
     * @return tempDebtAmount Temporary debt amount (placeholder; implementation-defined)
     */
    function getLiquidatorTempDebt(
        address liquidator,
        address asset
    )
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 tempDebtAmount)
    {
        // Aggregated off-chain; return zero placeholder on-chain.
        liquidator;
        asset;
        tempDebtAmount = 0;
    }

    /**
     * @notice Get liquidator temporary debt info with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorTempDebtWithMeta(
        address liquidator,
        address asset
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 tempDebtAmount, uint256 blockNumber, bool isValid)
    {
        tempDebtAmount = getLiquidatorTempDebt(liquidator, asset);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get liquidator profit rate (placeholder).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     *
     * @return profitRate Profit rate (bps; placeholder)
     */
    function getLiquidatorProfitRate()
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 profitRate)
    {
        // Aggregated off-chain; return zero placeholder on-chain.
        profitRate = 0;
    }

    /**
     * @notice Get liquidator profit rate with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorProfitRateWithMeta()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 profitRate, uint256 blockNumber, bool isValid)
    {
        profitRate = getLiquidatorProfitRate();
        (blockNumber, isValid) = _defaultMeta();
    }

    /*━━━━━━━━━━━━━━━ LIQUIDATOR ANALYTICS (PLACEHOLDER) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get liquidator activity stats (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorActivityStats(
        address liquidator,
        uint256 /* timeRange */
    )
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            uint256 totalLiquidations,
            uint256 totalProfit,
            uint256 averageProfit,
            uint256 lastActivity
        )
    {
        liquidator; // silence unused (Scheme A: off-chain aggregation)
        // Aggregated off-chain; return placeholders on-chain.
        totalProfit = 0;
        totalLiquidations = 0;
        lastActivity = 0;
        averageProfit = totalLiquidations > 0
            ? totalProfit / totalLiquidations
            : 0;
    }

    /**
     * @notice Get liquidator activity stats with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorActivityStatsWithMeta(
        address liquidator,
        uint256 timeRange
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            uint256 totalLiquidations,
            uint256 totalProfit,
            uint256 averageProfit,
            uint256 lastActivity,
            uint256 blockNumber,
            bool isValid
        )
    {
        (
            totalLiquidations,
            totalProfit,
            averageProfit,
            lastActivity
        ) = getLiquidatorActivityStats(liquidator, timeRange);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get liquidator efficiency ranking (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - `limit` is zero (LiquidatorView__InvalidLimit)
     *      - `limit` exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorEfficiencyRanking(
        uint256 limit
    )
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            address[] memory liquidators,
            uint256[] memory efficiencyScores,
            uint256[] memory avgResponseTime
        )
    {
        if (limit == 0) revert LiquidatorView__InvalidLimit();
        if (limit > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(limit, ViewConstants.MAX_BATCH_SIZE);
        }

        // Placeholder: ranking is aggregated off-chain; return empty arrays on-chain.
        liquidators = new address[](0);
        efficiencyScores = new uint256[](0);
        avgResponseTime = new uint256[](0);
    }

    /**
     * @notice Get liquidator efficiency ranking with staleness metadata.
     * @dev Reverts if:
     *      - `limit` is zero (LiquidatorView__InvalidLimit)
     *      - `limit` exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorEfficiencyRankingWithMeta(
        uint256 limit
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            address[] memory liquidators,
            uint256[] memory efficiencyScores,
            uint256[] memory avgResponseTime,
            uint256 blockNumber,
            bool isValid
        )
    {
        (
            liquidators,
            efficiencyScores,
            avgResponseTime
        ) = getLiquidatorEfficiencyRanking(limit);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get liquidator risk analysis (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_RISK_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorRiskAnalysis(
        address /* liquidator */
    )
        public
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (
            uint256 riskScore,
            uint8 riskLevel,
            string[] memory riskFactors
        )
    {
        // Placeholder: aggregated off-chain; return defaults on-chain.
        riskScore = 0;
        riskLevel = 0;
        riskFactors = new string[](0);
    }

    /**
     * @notice Get liquidator risk analysis with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_RISK_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidatorRiskAnalysisWithMeta(
        address liquidator
    )
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (
            uint256 riskScore,
            uint8 riskLevel,
            string[] memory riskFactors,
            uint256 blockNumber,
            bool isValid
        )
    {
        (riskScore, riskLevel, riskFactors) = getLiquidatorRiskAnalysis(
            liquidator
        );
        (blockNumber, isValid) = _defaultMeta();
    }

    /*━━━━━━━━━━━━━━━ LIQUIDATION MARKET (PLACEHOLDER) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get liquidation market overview (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View-only.
     */
    function getLiquidationMarketOverview()
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            uint256 totalLiquidations,
            uint256 totalVolume,
            uint256 activeLiquidators,
            uint256 avgLiquidationSize
        )
    {
        totalLiquidations = 0;
        totalVolume = 0;
        activeLiquidators = 0;
        avgLiquidationSize = 0;
    }

    /**
     * @notice Get liquidation market overview with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View only
     */
    function getLiquidationMarketOverviewWithMeta()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            uint256 totalLiquidations,
            uint256 totalVolume,
            uint256 activeLiquidators,
            uint256 avgLiquidationSize,
            uint256 blockNumber,
            bool isValid
        )
    {
        (
            totalLiquidations,
            totalVolume,
            activeLiquidators,
            avgLiquidationSize
        ) = getLiquidationMarketOverview();
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get liquidation trends (placeholder; aggregated off-chain).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View only
     */
    function getLiquidationTrends(
        uint256 /* timeRange */
    )
        public
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            uint256 liquidationCount,
            uint256 liquidationVolume,
            uint256 avgResponseTime
        )
    {
        liquidationCount = 0;
        liquidationVolume = 0;
        avgResponseTime = 0;
    }

    /**
     * @notice Get liquidation trends with staleness metadata.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View only
     */
    function getLiquidationTrendsWithMeta(
        uint256 timeRange
    )
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            uint256 liquidationCount,
            uint256 liquidationVolume,
            uint256 avgResponseTime,
            uint256 blockNumber,
            bool isValid
        )
    {
        (
            liquidationCount,
            liquidationVolume,
            avgResponseTime
        ) = getLiquidationTrends(timeRange);
        (blockNumber, isValid) = _defaultMeta();
    }

    /*━━━━━━━━━━━━━━━ LEGACY STATS (PLACEHOLDER) ━━━━━━━━━━━━━━━*/
    struct UserLiquidationStats {
        uint256 totalLiquidations;
        uint256 totalSeizedValue;
        uint256 lastLiquidationBlock;
    }

    struct SystemLiquidationSnapshot {
        uint256 totalLiquidations;
        uint256 totalProfitDistributed;
        uint256 totalLiquidators;
        uint256 lastUpdateBlock;
    }

    // Asset/period statistics are aggregated off-chain; do not expose on-chain interfaces here.

    /**
     * @notice Get user liquidation stats with staleness metadata (placeholder).
     * @dev Reverts if:
     *      - access check fails in `onlyUserData`
     *
     * Security:
     * - View only
     */
    function getUserLiquidationStats(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (
            UserLiquidationStats memory s,
            uint256 blockNumber,
            bool isValid
        )
    {
        s = _buildUserLiquidationStats(user);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Get user liquidation stats with staleness metadata (placeholder).
     * @dev Reverts if:
     *      - access check fails in `onlyUserData`
     *
     * Security:
     * - View only
     */
    function getUserLiquidationStatsWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (
            UserLiquidationStats memory s,
            uint256 blockNumber,
            bool isValid
        )
    {
        s = _buildUserLiquidationStats(user);
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Batch get user liquidation stats with staleness metadata (placeholder).
     * @dev Reverts if:
     *      - `users` is empty (EmptyArray)
     *      - batch size exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks Scheme U ops/admin access (VIEW_USER_DATA or ADMIN)
     *
     * Security:
     * - View only
     */
    function batchGetLiquidationStats(
        address[] calldata users
    )
        public
        view
        onlyValidRegistry
        returns (
            UserLiquidationStats[] memory list,
            uint256 blockNumber,
            bool isValid
        )
    {
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        }

        // Scheme U batch (SSOT): no self-bypass for `users[]` enumeration.
        // Caller must be ops/admin.
        bool ok = ViewAccessLib.hasRole(
            _registryAddr,
            ActionKeys.ACTION_VIEW_USER_DATA,
            msg.sender
        ) ||
            ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            );
        if (!ok) revert MissingRole();

        list = new UserLiquidationStats[](users.length);
        for (uint256 i = 0; i < users.length; ) {
            list[i] = _buildUserLiquidationStats(users[i]);
            unchecked {
                ++i;
            }
        }
        (blockNumber, isValid) = _defaultMeta();
    }

    /**
     * @notice Batch get user liquidation stats with staleness metadata (placeholder).
     * @dev Reverts if:
     *      - batch size exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks Scheme U ops/admin access (VIEW_USER_DATA or ADMIN)
     *
     * Security:
     * - View only
     */
    function batchGetLiquidationStatsWithMeta(
        address[] calldata users
    )
        external
        view
        onlyValidRegistry
        returns (
            UserLiquidationStats[] memory list,
            uint256 blockNumber,
            bool isValid
        )
    {
        return batchGetLiquidationStats(users);
    }

    /**
     * @notice Get system liquidation snapshot (placeholder).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View only
     */
    function getSystemLiquidationSnapshot()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (SystemLiquidationSnapshot memory snap)
    {
        snap = SystemLiquidationSnapshot({
            totalLiquidations: 0,
            totalProfitDistributed: 0,
            totalLiquidators: 0,
            lastUpdateBlock: 0
        });
    }

    /**
     * @notice Get system liquidation snapshot with staleness metadata (placeholder).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA
     *
     * Security:
     * - View only
     */
    function getSystemLiquidationSnapshotWithMeta()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (
            SystemLiquidationSnapshot memory snap,
            uint256 blockNumber,
            bool isValid
        )
    {
        snap = SystemLiquidationSnapshot({
            totalLiquidations: 0,
            totalProfitDistributed: 0,
            totalLiquidators: 0,
            lastUpdateBlock: 0
        });
        (blockNumber, isValid) = _defaultMeta();
    }

    /*━━━━━━━━━━━━━━━ COLLATERAL (VIEW-ONLY, PLACEHOLDER) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get seizable collateral amount with staleness metadata (best-effort; delegates to CollateralManager).
     * @dev Reverts if:
     *      - access check fails in `onlyUserData`
     *
     * Security:
     * - View only
     * - Best-effort: if CollateralManager call fails or module is unset, returns 0
     *
     * @param user User address
     * @param asset Collateral asset address
     * @return seizableAmount Seizable amount (token decimals of `asset`)
     * @return blockNumber Placeholder block number (0)
     * @return isValid Placeholder validity flag (false)
     */
    function getSeizableCollateralAmount(
        address user,
        address asset
    )
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (uint256 seizableAmount, uint256 blockNumber, bool isValid)
    {
        if (user == address(0) || asset == address(0)) {
            (blockNumber, isValid) = _defaultMeta();
            return (0, blockNumber, isValid);
        }
        // Delegate to CollateralManager; if not registered, returns 0 (best-effort, no revert).
        address cm = Registry(_registryAddr).getModule(ModuleKeys.KEY_CM);
        if (cm == address(0)) {
            (blockNumber, isValid) = _defaultMeta();
            return (0, blockNumber, isValid);
        }
        try ICollateralManager(cm).getCollateral(user, asset) returns (
            uint256 amt
        ) {
            (blockNumber, isValid) = _defaultMeta();
            return (amt, blockNumber, isValid);
        } catch {
            (blockNumber, isValid) = _defaultMeta();
            return (0, blockNumber, isValid);
        }
    }

    /**
     * @notice Get all seizable collaterals for a user with staleness metadata (best-effort).
     * @dev Reverts if:
     *      - access check fails in `onlyUserData`
     *
     * Security:
     * - View only
     * - Best-effort: if CollateralManager is unset, returns empty arrays
     *
     * @param user User address
     * @return assets Collateral asset list
     * @return amounts Collateral amounts (token decimals)
     * @return blockNumber Placeholder block number (0)
     * @return isValid Placeholder validity flag (false)
     */
    function getSeizableCollaterals(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (
            address[] memory assets,
            uint256[] memory amounts,
            uint256 blockNumber,
            bool isValid
        )
    {
        if (user == address(0)) {
            (blockNumber, isValid) = _defaultMeta();
            return (new address[](0), new uint256[](0), blockNumber, isValid);
        }
        // Assemble via CollateralManager; if not registered, returns empty arrays (best-effort).
        address cm = Registry(_registryAddr).getModule(ModuleKeys.KEY_CM);
        if (cm == address(0)) {
            (blockNumber, isValid) = _defaultMeta();
            return (new address[](0), new uint256[](0), blockNumber, isValid);
        }
        address[] memory assetsList = ICollateralManager(cm)
            .getUserCollateralAssets(user);
        uint256[] memory amountsList = new uint256[](assetsList.length);
        for (uint256 i = 0; i < assetsList.length; ) {
            try
                ICollateralManager(cm).getCollateral(user, assetsList[i])
            returns (uint256 bal) {
                amountsList[i] = bal;
            } catch {
                amountsList[i] = 0;
            }
            unchecked {
                ++i;
            }
        }
        (blockNumber, isValid) = _defaultMeta();
        return (assetsList, amountsList, blockNumber, isValid);
    }

    /**
     * @notice Calculate collateral value (best-effort; delegates to PositionView).
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_LIQUIDATION_DATA
     *
     * Security:
     * - View only
     * - Best-effort: returns 0 if PositionView is unset or call fails
     *
     * @param asset Collateral asset address
     * @param amount Amount (token decimals of `asset`)
     * @return value Value (PositionView denomination; implementation-defined)
     */
    function calculateCollateralValue(
        address asset,
        uint256 amount
    )
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256 value)
    {
        if (asset == address(0) || amount == 0) return 0;
        address pv = _resolvePositionViewAddr();
        if (pv == address(0)) return 0;
        try IPositionViewValuation(pv).getAssetValue(asset, amount) returns (
            uint256 v
        ) {
            return v;
        } catch {
            return 0;
        }
    }

    /**
     * @notice Get user total collateral value with staleness metadata (best-effort; delegates to PositionView).
     * @dev Reverts if:
     *      - access check fails in `onlyUserData`
     *
     * Security:
     * - View only
     * - Best-effort: returns 0 if PositionView is unset or call fails
     *
     * @param user User address
     * @return totalValue Total collateral value (PositionView denomination; implementation-defined)
     * @return blockNumber Placeholder block number (0)
     * @return isValid Placeholder validity flag (false)
     */
    function getUserTotalCollateralValue(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (uint256 totalValue, uint256 blockNumber, bool isValid)
    {
        if (user == address(0)) {
            (blockNumber, isValid) = _defaultMeta();
            return (0, blockNumber, isValid);
        }
        address pv = _resolvePositionViewAddr();
        if (pv == address(0)) {
            (blockNumber, isValid) = _defaultMeta();
            return (0, blockNumber, isValid);
        }
        try
            IPositionViewValuation(pv).getUserTotalCollateralValue(user)
        returns (uint256 v) {
            (blockNumber, isValid) = _defaultMeta();
            return (v, blockNumber, isValid);
        } catch {
            (blockNumber, isValid) = _defaultMeta();
            return (0, blockNumber, isValid);
        }
    }

    /**
     * @notice Batch get seizable collateral amounts (best-effort).
     * @dev Reverts if:
     *      - array length mismatch (ArrayLengthMismatch)
     *      - batch size exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_LIQUIDATION_DATA
     *
     * Security:
     * - View only
     *
     * @param users Array of users
     * @param assets Array of assets (aligned with users)
     * @return seizableAmounts Array of seizable amounts (token decimals)
     */
    function batchGetSeizableAmounts(
        address[] calldata users,
        address[] calldata assets
    )
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory seizableAmounts)
    {
        if (users.length == 0) revert EmptyArray();
        if (users.length != assets.length)
            revert ArrayLengthMismatch(users.length, assets.length);
        if (users.length > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        }

        address cm = Registry(_registryAddr).getModule(ModuleKeys.KEY_CM);
        seizableAmounts = new uint256[](users.length);
        if (cm == address(0)) return seizableAmounts;
        for (uint256 i = 0; i < users.length; ) {
            if (users[i] != address(0) && assets[i] != address(0)) {
                try
                    ICollateralManager(cm).getCollateral(users[i], assets[i])
                returns (uint256 amt) {
                    seizableAmounts[i] = amt;
                } catch {
                    seizableAmounts[i] = 0;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Batch calculate collateral values (best-effort).
     * @dev Reverts if:
     *      - array length mismatch (ArrayLengthMismatch)
     *      - batch size exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_LIQUIDATION_DATA
     *
     * Security:
     * - View only
     *
     * @param assets Array of assets
     * @param amounts Array of amounts (token decimals; aligned with assets)
     * @return values Array of values (PositionView denomination; implementation-defined)
     */
    function batchCalculateCollateralValues(
        address[] calldata assets,
        uint256[] calldata amounts
    )
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory values)
    {
        if (assets.length == 0) revert EmptyArray();
        if (assets.length != amounts.length)
            revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(assets.length, ViewConstants.MAX_BATCH_SIZE);
        }

        address pv = _resolvePositionViewAddr();
        values = new uint256[](assets.length);
        if (pv == address(0)) return values;
        for (uint256 i = 0; i < assets.length; ) {
            if (assets[i] != address(0) && amounts[i] > 0) {
                try
                    IPositionViewValuation(pv).getAssetValue(
                        assets[i],
                        amounts[i]
                    )
                returns (uint256 v) {
                    values[i] = v;
                } catch {
                    values[i] = 0;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Batch get user total collateral values (best-effort).
     * @dev Reverts if:
     *      - batch size exceeds MAX_BATCH_SIZE (BatchTooLarge)
     *      - caller lacks ACTION_VIEW_LIQUIDATION_DATA
     *
     * Security:
     * - View only
     *
     * @param users Array of users
     * @return totalValues Array of total collateral values (PositionView denomination; implementation-defined)
     */
    function batchGetUserTotalCollateralValues(
        address[] calldata users
    )
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory totalValues)
    {
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        }
        address pv = _resolvePositionViewAddr();
        totalValues = new uint256[](users.length);
        if (pv == address(0)) return totalValues;
        for (uint256 i = 0; i < users.length; ) {
            if (users[i] != address(0)) {
                try
                    IPositionViewValuation(pv).getUserTotalCollateralValue(
                        users[i]
                    )
                returns (uint256 v) {
                    totalValues[i] = v;
                } catch {
                    totalValues[i] = 0;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    /*━━━━━━━━━━━━━━━ REGISTRY ADMIN (DEPRECATED) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return the Registry address.
     * @dev Reverts if: (never). May return address(0) if not initialized.
     *
     * Security:
     * - View-only.
     *
     * @return registry Registry address.
     */
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    /**
     * @notice DEPRECATED: schedule module upgrade via Registry (kept for backwards compatibility).
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_UPGRADE_MODULE (see {ViewAccessLib})
     *      - Registry rejects the upgrade schedule (reverts in {Registry.scheduleModuleUpgrade})
     *
     * Security:
     * - Role-gated (ACTION_UPGRADE_MODULE)
     *
     * @param moduleKey Module key
     * @param newAddress New module address
     */
    function upgradeModule(
        bytes32 moduleKey,
        address newAddress
    ) external onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_UPGRADE_MODULE,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
    }

    /**
     * @notice DEPRECATED: execute module upgrade via Registry (kept for backwards compatibility).
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_UPGRADE_MODULE (see {ViewAccessLib})
     *      - Registry rejects upgrade execution (reverts in {Registry.executeModuleUpgrade})
     *
     * Security:
     * - Role-gated (ACTION_UPGRADE_MODULE)
     *
     * @param moduleKey Module key
     */
    function executeModuleUpgrade(
        bytes32 moduleKey
    ) external onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_UPGRADE_MODULE,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
    }

    /**
     * @notice DEPRECATED: cancel module upgrade via Registry (kept for backwards compatibility).
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_UPGRADE_MODULE (see {ViewAccessLib})
     *      - Registry rejects upgrade cancellation (reverts in {Registry.cancelModuleUpgrade})
     *
     * Security:
     * - Role-gated (ACTION_UPGRADE_MODULE)
     *
     * @param moduleKey Module key
     */
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_UPGRADE_MODULE,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
    }

    /*━━━━━━━━━━━━━━━ UUPS UPGRADE CONTROL ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrades.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks ACTION_UPGRADE_MODULE
     *      - `newImplementation` is zero
     *
     * Security:
     * - Role-gated (ACTION_UPGRADE_MODULE)
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_UPGRADE_MODULE,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ INTERNAL HELPERS ━━━━━━━━━━━━━━━*/
    function _buildUserLiquidationStats(
        address /* user */
    ) internal pure returns (UserLiquidationStats memory s) {
        // Aggregated off-chain; return zero placeholders on-chain.
        s = UserLiquidationStats({
            totalLiquidations: 0,
            totalSeizedValue: 0,
            lastLiquidationBlock: 0
        });
    }

    function _buildLiquidatorProfitView(
        address liquidator
    ) internal view returns (LiquidatorProfitView memory profitView) {
        // Aggregated off-chain; return zero placeholders on-chain.
        (
            uint256 totalProfit,
            uint256 liquidationCount,
            uint256 lastUpdateBlock
        ) = (0, 0, 0);
        uint256 avg = liquidationCount > 0 ? totalProfit / liquidationCount : 0;
        // Time-Dependency-Refactor SSOT: use block number as time axis marker.
        uint256 blocksSince = lastUpdateBlock > 0 &&
            block.number > lastUpdateBlock
            ? (block.number - lastUpdateBlock)
            : 0;

        profitView = LiquidatorProfitView({
            liquidator: liquidator,
            totalProfit: totalProfit,
            totalLiquidations: liquidationCount,
            lastLiquidationBlock: lastUpdateBlock,
            totalProfitValue: totalProfit,
            averageProfitPerLiquidation: avg,
            blocksSinceLastLiquidation: blocksSince
        });
    }

    function _buildGlobalLiquidationView()
        internal
        pure
        returns (GlobalLiquidationView memory globalView)
    {
        // Global stats are aggregated off-chain; return zero placeholders on-chain.
        uint256 totalLiquidations = 0;
        uint256 totalProfit = 0;
        uint256 activeLiquidators = 0;
        uint256 lastUpdateBlock = 0;

        uint256 avg = totalLiquidations > 0
            ? totalProfit / totalLiquidations
            : 0;

        globalView = GlobalLiquidationView({
            totalLiquidations: totalLiquidations,
            totalProfitDistributed: totalProfit,
            totalLiquidators: activeLiquidators,
            averageProfitPerLiquidation: avg,
            lastLiquidationBlock: lastUpdateBlock,
            liquidationSuccessRate: 0
        });
    }

    function _defaultMeta()
        internal
        pure
        returns (uint256 blockNumber, bool isValid)
    {
        return (0, false);
    }

    function _checkUserAccess(address user) internal view {
        // Scheme U (SSOT):
        // - self read: allowed
        // - non-self: ops/admin only
        if (msg.sender == user) return;
        bool ok = ViewAccessLib.hasRole(
            _registryAddr,
            ActionKeys.ACTION_VIEW_USER_DATA,
            msg.sender
        ) ||
            ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            );
        if (!ok) revert MissingRole();
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the API version of this module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Pure function
     *
     * @return version API version
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
     * - Pure function
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap reserved for future upgrades.
    uint256[50] private __gap;
}
