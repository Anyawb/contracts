// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import {
    ArrayLengthMismatch,
    BatchTooLarge,
    EmptyArray,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/*━━━━━━━━━━━━━━━ Selector SSOT (B方案) ━━━━━━━━━━━━━━━*/
// Selectors are derived from the canonical module contracts in this repository (SSOT),
// rather than hardcoding hex values or duplicating minimal interfaces in this file.
import { HealthView } from "./HealthView.sol";
import { PositionView } from "./PositionView.sol";

interface IHealthViewLite {
    function getUserHealthFactorWithMeta(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber);
}

interface IPositionViewLite {
    function getUserPositionWithMeta(address user, address asset)
        external
        view
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version);
}

interface IStatisticsViewLite {
    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    function getGlobalStatisticsWithMeta()
        external
        view
        returns (GlobalStatistics memory g, bool isValid, uint256 blockNumber);
}

/// @title CacheOptimizedView
/// @notice Read-only facade that forwards queries to View modules and returns frontend-friendly aggregates.
/// @dev This module is upgradeable (UUPS) and stores only the Registry address. It does not persist business state;
///      all values are sourced from modules resolved via {Registry.getModuleOrRevert}
///      (e.g. PositionView/HealthView/StatisticsView).
///
///      IMPORTANT (Architecture-Guide / Workguide alignment):
///      - Some downstream modules (notably `HealthView`) may be **public read-only** by default to support
///        permissionless `eth_call` for frontends/keepers.
///      - This facade is a **user-dimensional view** and therefore enforces **Scheme U** on all `user/users[]`
///        reads (self-read allowed; non-self requires `ACTION_VIEW_USER_DATA` or `ACTION_ADMIN`; batch has
///        no self-bypass).
///      - If an integration requires permissionless reads, it SHOULD call the downstream module directly
///        (e.g. `HealthView.getUserHealthFactorWithMeta`) instead of routing through this facade.
contract CacheOptimizedView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @dev Function selectors for downstream `staticcall` payload encoding (derived from SSOT module contracts).
    bytes4 private constant _SEL_GET_USER_POSITION_WITH_META = PositionView.getUserPositionWithMeta.selector;
    bytes4 private constant _SEL_GET_USER_HEALTH_FACTOR_WITH_META = HealthView.getUserHealthFactorWithMeta.selector;

    address private _registryAddr;

    /// @dev Reverts when `newImplementation` is the zero address. Used by {_authorizeUpgrade}.
    error CacheOptimizedView__ZeroImplementation();

    struct UserPositionItem {
        address user;
        address asset;
        uint256 collateral;
        uint256 debt;
    }

    /// @notice Per-asset user position entry with PositionView cache metadata (best-effort).
    /// @dev `positionIsValid/positionUpdateBlock/positionVersion` are sourced from PositionView meta APIs when available;
    ///      missing fields may return default values (e.g. blockNumber==0) when older APIs are used.
    struct UserPositionItemMeta {
        address user;
        uint64 positionVersion;
        bool positionIsValid;
        address asset;
        uint256 collateral;
        uint256 debt;
        uint256 positionUpdateBlock;
    }

    struct UserSummary {
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 healthFactor;
        bool cacheValid;
    }

    struct SystemStats {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Scheme U: self read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserDim(address user) {
        if (msg.sender != user) {
            bool ok =
                ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                    || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
            if (!ok) revert MissingRole();
        }
        _;
    }

    /// @dev Scheme U batch: no self-bypass for `users[]` enumeration; requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserDimBatch() {
        bool ok =
            ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (!ok) revert MissingRole();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the module with the system Registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero (see {ZeroAddress})
     *      - `initialRegistryAddr` is not a contract (see {NotAContract})
     *
     * Security:
     * - Initializer can only be called once (see {Initializable}).
     * - Sets only the Registry pointer; does not modify any vault/business state.
     *
     * @param initialRegistryAddr The Registry contract address used to resolve module dependencies.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /**
     * @notice Returns the Registry address used for module resolution.
     * @dev Reverts if: none.
     *
     * Security:
     * - Read-only.
     *
     * @return registry The Registry contract address.
     */
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ User queries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns a user's health factor as reported by HealthView, plus cache validity and blockNumber.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (Scheme U; see {onlyUserDim})
     *      - Registry missing `ModuleKeys.KEY_HEALTH_VIEW` (reverts in {Registry.getModuleOrRevert})
     *      - HealthView call reverts (propagated)
     *
     * Notes:
     * - Even if `HealthView` is configured as public read-only, this facade enforces Scheme U because it is a
     *   user-dimensional view module.
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     * - Read-only; performs an external view call into HealthView.
     *
     * @param user The account to query.
     * @return healthFactor The health factor value (unit/precision defined by HealthView).
     * @return cacheValid True if HealthView indicates the value is valid (e.g. not stale/invalid).
     * @return blockNumber HealthView cache update blockNumber (block.number).
     */
    function getUserHealthFactor(address user)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 healthFactor, bool cacheValid, uint256 blockNumber)
    {
        (healthFactor, cacheValid, blockNumber) = _healthView().getUserHealthFactorWithMeta(user);
    }

    /**
     * @notice Returns health factors for multiple users, as reported by HealthView.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to enumerate `users[]` (Scheme U batch; see {onlyUserDimBatch})
     *      - `users` is empty (see {EmptyArray})
     *      - `users.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_HEALTH_VIEW` (reverts in {Registry.getModuleOrRevert})
     *      - HealthView call reverts (propagated)
     *
     * Notes:
     * - Batch reads are considered enumeration; this facade does not allow self-bypass for `users[]`.
     * - If an integration requires permissionless reads, call `HealthView.batchGetHealthFactorsWithMeta` (or
     *   equivalent canonical HealthView batch API) directly.
     *
     * Security:
     * - Scheme U batch read policy (no self-bypass; requires VIEW_USER_DATA or ADMIN).
     * - Read-only; performs per-user external view calls into HealthView.
     *
     * @param users The accounts to query. Length must be \(1..MAX_BATCH_SIZE\).
     * @return factors Health factors for each user, in the same order as `users`.
     * @return validFlags Cache-validity flags for each user, in the same order as `users`.
     * @return blockNumbers Cache update blockNumbers for each user, in the same order as `users`.
     */
    function batchGetUserHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyUserDimBatch
        returns (uint256[] memory factors, bool[] memory validFlags, uint256[] memory blockNumbers)
    {
        uint256 len = users.length;
        _validateBatchLength(len);

        IHealthViewLite hv = _healthView();
        factors = new uint256[](len);
        validFlags = new bool[](len);
        blockNumbers = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 hf, bool ok, uint256 blockNumber) = hv.getUserHealthFactorWithMeta(users[i]);
            factors[i] = hf;
            validFlags[i] = ok;
            blockNumbers[i] = blockNumber;
        }
    }

    /**
     * @notice Returns per-asset positions for multiple (user, asset) pairs, with cache metadata.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to enumerate `users[]` (Scheme U batch; see {onlyUserDimBatch})
     *      - `users` is empty (see {EmptyArray})
     *      - `users.length != assets.length` (see {ArrayLengthMismatch})
     *      - `users.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U batch read policy (no self-bypass; requires VIEW_USER_DATA or ADMIN).
     * - Best-effort metadata: uses `staticcall` to probe PositionView meta APIs.
     *
     * @param users The users to query. Must match `assets.length`.
     * @param assets The assets to query. Must match `users.length`.
     * @return positions Position entries (with metadata) in the same order as the input pairs.
     */
    function batchGetUserPositions(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        onlyUserDimBatch
        returns (UserPositionItemMeta[] memory positions)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len != assets.length) revert ArrayLengthMismatch(len, assets.length);
        _validateBatchLength(len);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        positions = new UserPositionItemMeta[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt, bool posValid, uint256 posTs, uint64 posVer) =
                _readUserPositionWithMeta(pvAddr, users[i], assets[i]);
            positions[i] = UserPositionItemMeta({
                user: users[i],
                asset: assets[i],
                collateral: collateral,
                debt: debt,
                positionIsValid: posValid,
                positionUpdateBlock: posTs,
                positionVersion: posVer
            });
        }
    }

    /**
     * @notice Returns per-asset positions for multiple (user, asset) pairs, including PositionView cache metadata.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to enumerate `users[]` (Scheme U batch; see {onlyUserDimBatch})
     *      - `users` is empty (see {EmptyArray})
     *      - `users.length != assets.length` (see {ArrayLengthMismatch})
     *      - `users.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U batch read policy (no self-bypass; requires VIEW_USER_DATA or ADMIN).
     * - Best-effort metadata: uses `staticcall` to probe multiple PositionView APIs. API mismatch/reverts are swallowed
     *   (ok==false) and metadata fields may fall back to default values.
     * - Callers SHOULD treat `positionUpdateBlock == 0` as "unknown/unavailable" and handle accordingly.
     *
     * @param users The users to query. Must match `assets.length`.
     * @param assets The assets to query. Must match `users.length`.
     * @return positions Position entries (with metadata) in the same order as the input pairs.
     */
    function batchGetUserPositionsWithMeta(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        onlyUserDimBatch
        returns (UserPositionItemMeta[] memory positions)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len != assets.length) revert ArrayLengthMismatch(len, assets.length);
        _validateBatchLength(len);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        positions = new UserPositionItemMeta[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt, bool posValid, uint256 posTs, uint64 posVer) =
                _readUserPositionWithMeta(pvAddr, users[i], assets[i]);
            positions[i] = UserPositionItemMeta({
                user: users[i],
                asset: assets[i],
                collateral: collateral,
                debt: debt,
                positionIsValid: posValid,
                positionUpdateBlock: posTs,
                positionVersion: posVer
            });
        }
    }

    /**
     * @notice Returns a user summary plus PositionView/HealthView cache metadata.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (Scheme U; see {onlyUserDim})
     *      - `trackedAssets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_HEALTH_VIEW` or `ModuleKeys.KEY_POSITION_VIEW`
     *        (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     * - Read-only; performs external view calls into HealthView and PositionView.
     *
     * @param user The user to summarize.
     * @param trackedAssets The assets to aggregate. Length must be \(\le MAX_BATCH_SIZE\).
     * @return summary Aggregated totals plus health factor and cache-valid flag.
     * @return positionValidFlags Per-asset validity flags as reported by PositionView (best-effort).
     * @return positionUpdateBlocks Per-asset update blockNumbers (best-effort; 0 may mean unknown).
     * @return positionVersions Per-asset cache/position versions (best-effort; 0 may mean unknown).
     * @return healthUpdateBlock HealthView blockNumber (or per HealthView semantics).
     */
    function getUserSummary(address user, address[] calldata trackedAssets)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            UserSummary memory summary,
            bool[] memory positionValidFlags,
            uint256[] memory positionUpdateBlocks,
            uint64[] memory positionVersions,
            uint256 healthUpdateBlock
        )
    {
        return _getUserSummaryWithMeta(user, trackedAssets);
    }

    /**
     * @notice Returns a user summary plus per-asset PositionView metadata and the HealthView blockNumber.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (Scheme U; see {onlyUserDim})
     *      - `trackedAssets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_HEALTH_VIEW` or `ModuleKeys.KEY_POSITION_VIEW`
     *        (reverts in {Registry.getModuleOrRevert})
     *      - HealthView call reverts (propagated)
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     * - Best-effort metadata: per-asset metadata is retrieved via `staticcall` probes into PositionView. Missing fields
     *   may return default values; callers SHOULD treat `positionUpdateBlocks[i] == 0` as "unknown/unavailable".
     *
     * @param user The user to summarize.
     * @param trackedAssets The assets to aggregate. Length must be \(\le MAX_BATCH_SIZE\). May be zero.
     * @return summary Aggregated totals plus health factor and cache-valid flag.
     * @return positionValidFlags Per-asset validity flags as reported by PositionView (best-effort).
     * @return positionUpdateBlocks Per-asset update blockNumbers (best-effort; 0 may mean unknown).
     * @return positionVersions Per-asset cache/position versions (best-effort; 0 may mean unknown).
     * @return healthUpdateBlock HealthView blockNumber (or per HealthView semantics).
     */
    function getUserSummaryWithMeta(address user, address[] calldata trackedAssets)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            UserSummary memory summary,
            bool[] memory positionValidFlags,
            uint256[] memory positionUpdateBlocks,
            uint64[] memory positionVersions,
            uint256 healthUpdateBlock
        )
    {
        return _getUserSummaryWithMeta(user, trackedAssets);
    }

    function _getUserSummaryWithMeta(address user, address[] calldata trackedAssets)
        internal
        view
        returns (
            UserSummary memory summary,
            bool[] memory positionValidFlags,
            uint256[] memory positionUpdateBlocks,
            uint64[] memory positionVersions,
            uint256 healthUpdateBlock
        )
    {
        uint256 len = trackedAssets.length;
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);

        (summary.healthFactor, summary.cacheValid, healthUpdateBlock) = _readHealthFactorWithMeta(user);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        positionValidFlags = new bool[](len);
        positionUpdateBlocks = new uint256[](len);
        positionVersions = new uint64[](len);

        uint256 totalCollateral;
        uint256 totalDebt;
        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt, bool posValid, uint256 posTs, uint64 posVer) =
                _readUserPositionWithMeta(pvAddr, user, trackedAssets[i]);
            totalCollateral += collateral;
            totalDebt += debt;
            positionValidFlags[i] = posValid;
            positionUpdateBlocks[i] = posTs;
            positionVersions[i] = posVer;
        }
        summary.totalCollateral = totalCollateral;
        summary.totalDebt = totalDebt;
    }

    /*━━━━━━━━━━━━━━━ System queries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns system-wide statistics as reported by StatisticsView.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_SYSTEM_DATA` (MissingRole)
     *      - Registry missing `ModuleKeys.KEY_STATS` (reverts in {Registry.getModuleOrRevert})
     *      - StatisticsView call reverts (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Read-only; performs an external view call into StatisticsView.
     *
     * @return stats System-wide statistics snapshot.
     */
    function getSystemStats()
        external
        view
        onlyValidRegistry
        returns (SystemStats memory stats)
    {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        (IStatisticsViewLite.GlobalStatistics memory g, , ) = _statisticsView().getGlobalStatisticsWithMeta();
        stats = SystemStats({
            totalUsers: g.totalUsers,
            activeUsers: g.activeUsers,
            totalCollateral: g.totalCollateral,
            totalDebt: g.totalDebt,
            lastUpdateBlock: g.lastUpdateBlock
        });
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _healthView() internal view returns (IHealthViewLite) {
        return IHealthViewLite(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
    }

    function _positionView() internal view returns (IPositionViewLite) {
        return IPositionViewLite(_getModule(ModuleKeys.KEY_POSITION_VIEW));
    }

    function _statisticsView() internal view returns (IStatisticsViewLite) {
        return IStatisticsViewLite(_getModule(ModuleKeys.KEY_STATS));
    }

    function _getModule(bytes32 key) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    function _requireRole(bytes32 actionKey, address user) internal view {
        if (!ViewAccessLib.hasRole(_registryAddr, actionKey, user)) revert MissingRole();
    }

    function _validateBatchLength(uint256 len) internal pure {
        if (len == 0) revert EmptyArray();
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
    }

    /**
     * @notice Authorizes a UUPS upgrade.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_ADMIN` (MissingRole)
     *      - `newImplementation` is zero (see {CacheOptimizedView__ZeroImplementation})
     *      - `newImplementation` is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrade authorization.
     *
     * @param newImplementation The new implementation contract address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert CacheOptimizedView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Meta passthrough helpers ━━━━━━━━━━━━━━━*/

    function _readUserPositionWithMeta(address pvAddr, address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        if (pvAddr == address(0)) return (0, 0, false, 0, 0);

        (bool ok, bytes memory data) =
            pvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_META, user, asset));
        if (ok && data.length >= 160) {
            return abi.decode(data, (uint256, uint256, bool, uint256, uint64));
        }
    }

    function _readHealthFactorWithMeta(address user)
        internal
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber)
    {
        address hvAddr = _getModule(ModuleKeys.KEY_HEALTH_VIEW);
        if (hvAddr == address(0)) return (0, false, 0);

        (bool ok, bytes memory data) =
            hvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR_WITH_META, user));
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256, bool, uint256));
        }
    }

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the API version exposed by this module.
     * @dev Reverts if: none.
     *
     * Security:
     * - Pure function; does not read state.
     *
     * @return version The API version.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version used by this module's return types.
     * @dev Reverts if: none.
     *
     * Security:
     * - Pure function; does not read state.
     *
     * @return version The schema version.
     */
    function schemaVersion() public pure override returns (uint256) {
        return 2;
    }

    /// @notice Storage gap reserved for future upgrades.
    uint256[50] private __gap;
}
