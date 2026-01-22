// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import {
    ArrayLengthMismatch,
    BatchTooLarge,
    EmptyArray,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { CacheEvents } from "../../CacheEvents.sol";

interface IVaultCoreViewAddr {
    function viewContractAddrVar() external view returns (address);
}

/**
 * @title PositionView
 * @notice User position cache module for collateral/debt queries (0-gas reads via view calls).
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller is not an authorized business module for push entrypoints (PositionView__Unauthorized)
 *      - caller lacks required view role (via ViewAccessLib / ACM)
 *      - pushed values do not match the ledger (PositionView__LedgerMismatch)
 *      - optimistic concurrency/version rules are violated
 *        (PositionView__StaleVersion / PositionView__OutOfOrderSeq)
 *      - admin-only entrypoints are called by non-admins
 *        (PositionView__OnlyAdmin / PositionView__OnlyUserOrAdmin)
 *
 * Security:
 * - Cache writes are restricted to configured business modules + ACTION_VIEW_PUSH role checks.
 * - Read entrypoints are role-gated via ViewAccessLib to prevent unauthorized data access (per architecture).
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 *
 * @custom:security-contact security@example.com
 */
contract PositionView is Initializable, UUPSUpgradeable, ViewVersioned, CacheEvents {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a user's position is cached (legacy event).
     * @param user Target user address
     * @param asset Asset address
     * @param collateral Cached collateral amount (asset decimals)
     * @param debt Cached debt amount (asset decimals)
     * @param ts Cache update timestamp (seconds since epoch)
     */
    event UserPositionCached(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint256 ts
    );

    /**
     * @notice Emitted when a user's position is cached, including a monotonic version.
     * @dev Backward compatibility: the legacy `UserPositionCached` event is also emitted.
     * @param user Target user address
     * @param asset Asset address
     * @param collateral Cached collateral amount (asset decimals)
     * @param debt Cached debt amount (asset decimals)
     * @param version Position version (monotonic per (user, asset))
     * @param ts Cache update timestamp (seconds since epoch)
     */
    event UserPositionCachedV2(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint64 version,
        uint256 ts
    );
    // NOTE: CacheUpdateFailed is declared in CacheEvents (SSOT) and is inherited here.

    /**
     * @notice Emitted when an idempotent replay is detected and ignored.
     * @dev This event is emitted instead of writing cache state again.
     * @param user Target user address
     * @param asset Asset address
     * @param requestId Idempotency key (bytes32)
     * @param seq Monotonic sequence number (if provided)
     */
    event IdempotentRequestIgnored(address indexed user, address indexed asset, bytes32 indexed requestId, uint64 seq);

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Caller is not an authorized business module for the requested action.
    error PositionView__Unauthorized();

    /// @notice One or more inputs are invalid (e.g., zero address where prohibited).
    error PositionView__InvalidInput();

    /// @notice Pushed values do not match the ledger values.
    error PositionView__LedgerMismatch();

    /// @notice Latest ledger read failed (best-effort paths may emit CacheUpdateFailed instead).
    error PositionView__LedgerReadFailed();

    /// @notice Incoming version is stale or violates monotonic ordering.
    error PositionView__StaleVersion(uint64 currentVersion, uint64 incomingVersion);

    /// @notice Delta update would underflow (negative resulting collateral/debt).
    error PositionView__InvalidDelta();

    /// @notice Sequence number is out of order (must be strictly increasing).
    error PositionView__OutOfOrderSeq(uint64 currentSeq, uint64 incomingSeq);

    /// @notice Caller must be the target user or an admin.
    error PositionView__OnlyUserOrAdmin();

    /// @notice Caller must be an admin.
    error PositionView__OnlyAdmin();

    /// @notice UUPS upgrade implementation address cannot be zero.
    error PositionView__ZeroImplementation();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    // user => asset => collateral|debt
    mapping(address => mapping(address => uint256)) private _collateralCache;
    mapping(address => mapping(address => uint256)) private _debtCache;
    mapping(address => uint256)                         private _cacheTimestamps;
    // user => asset => version (单调递增)
    mapping(address => mapping(address => uint64))      private _positionVersion;
    // user => asset => last updated timestamp
    mapping(address => mapping(address => uint256))     private _positionUpdatedAt;
    // user-level manual invalidation barrier (clearing cache should invalidate all (user,asset) cached entries)
    mapping(address => uint256)                         private _userInvalidatedAt;
    // user => asset => last applied seq (optional monotonic ordering aid)
    mapping(address => mapping(address => uint64))      private _positionSeq;
    // user => asset => last applied requestId (O(1) idempotency, version-bound)
    mapping(address => mapping(address => bytes32))     private _lastAppliedRequestId;

    // constants via ViewConstants
    uint256 private constant _CACHE_DURATION = ViewConstants.CACHE_DURATION;
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyUserViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        _;
    }

    modifier onlyRiskViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        _;
    }

    modifier onlyBusinessContract() {
        (address cm, address le, address vaultCore, address vbl, address vaultRouter) = _resolveBusinessModules();
        if (
            msg.sender != cm
            && msg.sender != le
            && msg.sender != vaultCore
            && msg.sender != vbl
            && msg.sender != vaultRouter
        ) {
            revert PositionView__Unauthorized();
        }
        _;
    }

    function _requireRole(bytes32 actionKey, address user) internal view {
        ViewAccessLib.requireRole(_registryAddr, actionKey, user);
    }

    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, actionKey, user);
    }

    /*━━━━━━━━━━━━━━━ Access helpers ━━━━━━━━━━━━━━━*/
    modifier onlyUserOrStrictAdmin(address user) {
        if (msg.sender != user && !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert PositionView__OnlyUserOrAdmin();
        }
        _;
    }

    modifier onlyAdmin() {
        if (!_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)) revert PositionView__OnlyAdmin();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the PositionView (UUPS).
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

    /*━━━━━━━━━━━━━━━ Push APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Push a full user position update into the cache.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not an authorized business module (PositionView__Unauthorized via onlyBusinessContract)
     *      - caller lacks ACTION_VIEW_PUSH role (via ViewAccessLib)
     *      - user or asset is zero (PositionView__InvalidInput)
     *      - pushed values do not match the ledger (PositionView__LedgerMismatch)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     * - Emits DataPushed via DataPushLibrary for off-chain consumers
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateral Latest collateral amount (asset decimals)
     * @param debt Latest debt amount (asset decimals)
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdate(user, asset, collateral, debt, bytes32(0), 0, 0);
    }

    /**
     * @notice Push a full user position update into the cache with idempotency/ordering metadata.
     * @dev Reverts if:
     *      - (same as the 4-arg overload)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     * - Idempotent replay: if requestId matches the last applied requestId for the target (user, asset),
     *   the call is ignored (no state write, no revert), and `IdempotentRequestIgnored` is emitted.
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateral Latest collateral amount (asset decimals)
     * @param debt Latest debt amount (asset decimals)
     * @param requestId Idempotency key (bytes32)
     * @param seq Monotonic sequence number (0 to disable)
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, 0);
    }

    /**
     * @notice Push a full user position update into the cache with an optional strict next version.
     * @dev Reverts if:
     *      - (same as the 4-arg overload)
     *      - nextVersion is stale / violates strict monotonicity (PositionView__StaleVersion)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateral Latest collateral amount (asset decimals)
     * @param debt Latest debt amount (asset decimals)
     * @param nextVersion Expected next version (0 = auto-increment; otherwise must equal currentVersion + 1)
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        uint64 nextVersion
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdate(user, asset, collateral, debt, bytes32(0), 0, nextVersion);
    }

    /**
     * @notice Push a full user position update into the cache with idempotency/ordering and strict next version.
     * @dev Reverts if:
     *      - (same as the 4-arg overload)
     *      - seq is out of order (PositionView__OutOfOrderSeq)
     *      - nextVersion is stale / violates strict monotonicity (PositionView__StaleVersion)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateral Latest collateral amount (asset decimals)
     * @param debt Latest debt amount (asset decimals)
     * @param requestId Idempotency key (bytes32)
     * @param seq Monotonic sequence number (0 to disable)
     * @param nextVersion Expected next version (0 = auto-increment; otherwise must equal currentVersion + 1)
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
    }

    /**
     * @notice Push a delta update (collateral/debt) into the cache (legacy auto-increment version).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not an authorized business module (PositionView__Unauthorized via onlyBusinessContract)
     *      - caller lacks ACTION_VIEW_PUSH role (via ViewAccessLib)
     *      - user or asset is zero (PositionView__InvalidInput)
     *      - delta would underflow (PositionView__InvalidDelta)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     * - Emits DataPushed via DataPushLibrary for off-chain consumers
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateralDelta Signed collateral delta (asset decimals)
     * @param debtDelta Signed debt delta (asset decimals)
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, bytes32(0), 0, 0);
    }

    /**
     * @notice Push a delta update into the cache with idempotency/ordering metadata.
     * @dev Reverts if:
     *      - (same as the 4-arg delta overload)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     * - Idempotent replay: if requestId matches the last applied requestId for the target (user, asset),
     *   the call is ignored (no state write, no revert), and `IdempotentRequestIgnored` is emitted.
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateralDelta Signed collateral delta (asset decimals)
     * @param debtDelta Signed debt delta (asset decimals)
     * @param requestId Idempotency key (bytes32)
     * @param seq Monotonic sequence number (0 to disable)
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, requestId, seq, 0);
    }

    /**
     * @notice Push a delta update into the cache with an optional strict next version.
     * @dev Reverts if:
     *      - (same as the 4-arg delta overload)
     *      - nextVersion is stale / violates strict monotonicity (PositionView__StaleVersion)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateralDelta Signed collateral delta (asset decimals)
     * @param debtDelta Signed debt delta (asset decimals)
     * @param nextVersion Expected next version (0 = auto-increment; otherwise must equal currentVersion + 1)
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, bytes32(0), 0, nextVersion);
    }

    /**
     * @notice Push a delta update into the cache with idempotency/ordering and strict next version.
     * @dev Reverts if:
     *      - (same as the 4-arg delta overload)
     *      - seq is out of order (PositionView__OutOfOrderSeq)
     *      - nextVersion is stale / violates strict monotonicity (PositionView__StaleVersion)
     *
     * Security:
     * - onlyBusinessContract + ACTION_VIEW_PUSH role-gated
     *
     * @param user Target user address
     * @param asset Asset address
     * @param collateralDelta Signed collateral delta (asset decimals)
     * @param debtDelta Signed debt delta (asset decimals)
     * @param requestId Idempotency key (bytes32)
     * @param seq Monotonic sequence number (0 to disable)
     * @param nextVersion Expected next version (0 = auto-increment; otherwise must equal currentVersion + 1)
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyValidRegistry onlyBusinessContract {
        _pushUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, requestId, seq, nextVersion);
    }

    function _pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        if (user == address(0) || asset == address(0)) revert PositionView__InvalidInput();

        // O(1) idempotency (version-bound):
        // If a tx is replayed after success, currentVersion == applied nextVersion.
        // If requestId matches the last applied requestId, ignore as idempotent replay.
        if (requestId != bytes32(0) && nextVersion != 0) {
            uint64 currentVersion = _positionVersion[user][asset];
            if (nextVersion == currentVersion && requestId == _lastAppliedRequestId[user][asset]) {
                emit IdempotentRequestIgnored(user, asset, requestId, seq);
                return;
            }
        }

        // Optional strict ordering guard (monotonic seq). Skipped for idempotent replays above.
        if (seq != 0) {
            uint64 currentSeq = _positionSeq[user][asset];
            if (seq <= currentSeq) revert PositionView__OutOfOrderSeq(currentSeq, seq);
        }

        uint64 newVersion = _computeVersionOrRevert(user, asset, nextVersion);

        (bool ok, uint256 ledgerCollateral, uint256 ledgerDebt) = _fetchLatestPositionGuarded(
            user,
            asset,
            collateral,
            debt
        );
        if (!ok) {
            // Ledger read failed: CacheUpdateFailed was emitted; skip cache write.
            return;
        }
        if (ledgerCollateral != collateral || ledgerDebt != debt) {
            revert PositionView__LedgerMismatch();
        }

        // Persist ordering/idempotency markers only after we are sure we will write cache successfully.
        if (seq != 0) _positionSeq[user][asset] = seq;
        if (requestId != bytes32(0)) _lastAppliedRequestId[user][asset] = requestId;

        _collateralCache[user][asset] = collateral;
        _debtCache[user][asset]       = debt;
        // solhint-disable-next-line not-rely-on-time
        _cacheTimestamps[user]        = block.timestamp;
        // solhint-disable-next-line not-rely-on-time
        _positionUpdatedAt[user][asset] = block.timestamp;
        _positionVersion[user][asset] = newVersion;

        // solhint-disable-next-line not-rely-on-time
        emit UserPositionCached(user, asset, collateral, debt, block.timestamp);
        // solhint-disable-next-line not-rely-on-time
        emit UserPositionCachedV2(user, asset, collateral, debt, newVersion, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE,
            abi.encode(user, asset, collateral, debt)
        );
    }

    function _pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        if (user == address(0) || asset == address(0)) revert PositionView__InvalidInput();

        // O(1) idempotency (version-bound) — see _pushUserPositionUpdate.
        if (requestId != bytes32(0) && nextVersion != 0) {
            uint64 currentVersion = _positionVersion[user][asset];
            if (nextVersion == currentVersion && requestId == _lastAppliedRequestId[user][asset]) {
                emit IdempotentRequestIgnored(user, asset, requestId, seq);
                return;
            }
        }

        if (seq != 0) {
            uint64 currentSeq = _positionSeq[user][asset];
            if (seq <= currentSeq) revert PositionView__OutOfOrderSeq(currentSeq, seq);
        }

        // Compute delta based on valid cache; if invalid, fall back to ledger.
        (uint256 baseCollateral, uint256 baseDebt, bool isValid) = _getCachedOrLatestPositionWithValidity(user, asset);

        // Critical safety: when cache is invalid, base values may come from the *post-update* ledger.
        // Adding delta on top would double-count. In this case, degrade to a full ledger sync.
        if (!isValid) {
            uint64 newVersionSync = _computeVersionOrRevert(user, asset, nextVersion);
            if (seq != 0) _positionSeq[user][asset] = seq;
            if (requestId != bytes32(0)) _lastAppliedRequestId[user][asset] = requestId;
            _collateralCache[user][asset] = baseCollateral;
            _debtCache[user][asset]       = baseDebt;
            // solhint-disable-next-line not-rely-on-time
            _cacheTimestamps[user]        = block.timestamp;
            // solhint-disable-next-line not-rely-on-time
            _positionUpdatedAt[user][asset] = block.timestamp;
            _positionVersion[user][asset] = newVersionSync;

            // solhint-disable-next-line not-rely-on-time
            emit UserPositionCached(user, asset, baseCollateral, baseDebt, block.timestamp);
            // solhint-disable-next-line not-rely-on-time
            emit UserPositionCachedV2(user, asset, baseCollateral, baseDebt, newVersionSync, block.timestamp);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE,
                abi.encode(user, asset, baseCollateral, baseDebt)
            );
            return;
        }

        int256 newCollateralSigned = int256(baseCollateral) + collateralDelta;
        int256 newDebtSigned = int256(baseDebt) + debtDelta;
        if (newCollateralSigned < 0 || newDebtSigned < 0) revert PositionView__InvalidDelta();

        uint256 newCollateral = uint256(newCollateralSigned);
        uint256 newDebt = uint256(newDebtSigned);

        uint64 newVersion = _computeVersionOrRevert(user, asset, nextVersion);

        if (seq != 0) _positionSeq[user][asset] = seq;
        if (requestId != bytes32(0)) _lastAppliedRequestId[user][asset] = requestId;

        _collateralCache[user][asset] = newCollateral;
        _debtCache[user][asset]       = newDebt;
        // solhint-disable-next-line not-rely-on-time
        _cacheTimestamps[user]        = block.timestamp;
        // solhint-disable-next-line not-rely-on-time
        _positionUpdatedAt[user][asset] = block.timestamp;
        _positionVersion[user][asset] = newVersion;

        // solhint-disable-next-line not-rely-on-time
        emit UserPositionCached(user, asset, newCollateral, newDebt, block.timestamp);
        // solhint-disable-next-line not-rely-on-time
        emit UserPositionCachedV2(user, asset, newCollateral, newDebt, newVersion, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE,
            abi.encode(user, asset, newCollateral, newDebt)
        );
    }

    /**
     * @notice Retry a cache sync from the ledger after a prior `CacheUpdateFailed`.
     * @dev Reverts if:
     *      - caller is not an admin (PositionView__OnlyAdmin)
     *      - user or asset is zero (PositionView__InvalidInput)
     *
     * Security:
     * - Admin-only
     * - Best-effort: if the ledger read fails again, emits `CacheUpdateFailed` and returns without writing.
     *
     * @param user Target user address
     * @param asset Asset address
     */
    function retryUserPositionUpdate(address user, address asset) external onlyAdmin {
        if (user == address(0) || asset == address(0)) revert PositionView__InvalidInput();

        (bool ok, uint256 collateral, uint256 debt) = _fetchLatestPositionGuarded(user, asset, 0, 0);
        if (!ok) {
            // CacheUpdateFailed was emitted in _fetchLatestPositionGuarded.
            return;
        }

        uint64 newVersion = _computeVersionOrRevert(user, asset, 0);

        _collateralCache[user][asset] = collateral;
        _debtCache[user][asset]       = debt;
        // solhint-disable-next-line not-rely-on-time
        _cacheTimestamps[user]        = block.timestamp;
        // solhint-disable-next-line not-rely-on-time
        _positionUpdatedAt[user][asset] = block.timestamp;
        _positionVersion[user][asset] = newVersion;

        // solhint-disable-next-line not-rely-on-time
        emit UserPositionCached(user, asset, collateral, debt, block.timestamp);
        // solhint-disable-next-line not-rely-on-time
        emit UserPositionCachedV2(user, asset, collateral, debt, newVersion, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE,
            abi.encode(user, asset, collateral, debt)
        );
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get a user's collateral/debt position for an asset.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_USER_DATA permission (via onlyUserViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_USER_DATA
     * - Best-effort fallback: if the cache is invalid, values are read directly from the ledger.
     *
     * @param user Target user address
     * @param asset Asset address
     * @return collateral Collateral amount (asset decimals)
     * @return debt Debt amount (asset decimals)
     */
    function getUserPosition(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserViewer
        returns (uint256 collateral, uint256 debt)
    {
        (collateral, debt) = _getCachedOrLatestPosition(user, asset);
    }

    /**
     * @notice Get a user's collateral/debt position for an asset, with cache validity.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_USER_DATA permission (via onlyUserViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_USER_DATA
     *
     * @param user Target user address
     * @param asset Asset address
     * @return collateral Collateral amount (asset decimals)
     * @return debt Debt amount (asset decimals)
     * @return isValid Whether the cache is valid for (user, asset)
     */
    function getUserPositionWithValidity(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserViewer
        returns (uint256 collateral, uint256 debt, bool isValid)
    {
        (collateral, debt, isValid) = _getCachedOrLatestPositionWithValidity(user, asset);
    }

    /**
     * @notice Get a user's position with cache validity, timestamp, and version (B-class unified output).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_USER_DATA permission (via onlyUserViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_USER_DATA
     *
     * @param user Target user address
     * @param asset Asset address
     * @return collateral Collateral amount (asset decimals)
     * @return debt Debt amount (asset decimals)
     * @return isValid Whether the cache is valid for (user, asset)
     * @return timestamp Last cache write timestamp for (user, asset) (seconds since epoch)
     * @return version Position version for (user, asset) (0 if never written)
     */
    function getUserPositionWithMeta(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserViewer
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 timestamp, uint64 version)
    {
        (collateral, debt, isValid) = _getCachedOrLatestPositionWithValidity(user, asset);
        timestamp = _positionUpdatedAt[user][asset];
        version = _positionVersion[user][asset];
    }

    /**
     * @notice Batch query user positions (best-effort per pair).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_USER_DATA permission (via onlyUserViewer / ViewAccessLib)
     *      - users is empty (EmptyArray)
     *      - users.length != assets.length (ArrayLengthMismatch)
     *      - batch size exceeds _MAX_BATCH_SIZE (BatchTooLarge)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_USER_DATA
     *
     * @param users User addresses
     * @param assets Asset addresses
     * @return collaterals Collateral amounts (asset decimals)
     * @return debts Debt amounts (asset decimals)
     */
    function batchGetUserPositions(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        onlyUserViewer
        returns (uint256[] memory collaterals, uint256[] memory debts)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len != assets.length) revert ArrayLengthMismatch(len, assets.length);
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);

        collaterals = new uint256[](len);
        debts       = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            (collaterals[i], debts[i]) = _getCachedOrLatestPosition(users[i], assets[i]);
        }
    }

    /**
     * @notice Get user's total collateral value (settlement token units).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     * - Best-effort: returns 0 if dependent modules are unavailable or external calls fail.
     *
     * @param user Target user address
     * @return totalValue Total collateral value (settlement token decimals, as defined by the oracle)
     */
    function getUserTotalCollateralValue(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256 totalValue)
    {
        if (user == address(0)) revert ZeroAddress();
        (address cm,, address oracle) = _resolveCollateralAndOracle();

        address[] memory assets;
        try ICollateralManager(cm).getUserCollateralAssets(user) returns (address[] memory a) {
            assets = a;
        } catch {
            // best-effort fallback
            return 0;
        }

        if (assets.length > _MAX_BATCH_SIZE) revert BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            if (asset == address(0)) continue;

            uint256 amount;
            try ICollateralManager(cm).getCollateral(user, asset) returns (uint256 a) {
                amount = a;
            } catch {
                continue;
            }
            if (amount == 0) continue;

            try IPriceOracle(oracle).getPrice(asset) returns (uint256 price, uint256 /*timestamp*/, uint256 decimals) {
                if (price == 0) continue;
                // 10**decimals must not overflow uint256
                if (decimals > 77) continue;
                uint256 scale = 10 ** decimals;
                if (scale == 0) continue;
                totalValue += Math.mulDiv(amount, price, scale);
            } catch {
                // best-effort: skip this asset
                continue;
            }
        }
    }

    /**
     * @notice Get system total collateral value (settlement token units).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     * - Best-effort: returns 0 if dependent modules are unavailable or external calls fail.
     *
     * @return totalValue Total collateral value (settlement token decimals, as defined by the oracle)
     */
    function getTotalCollateralValue() external view onlyValidRegistry onlyRiskViewer returns (uint256 totalValue) {
        (address cm,, address oracle) = _resolveCollateralAndOracle();

        address[] memory assets;
        try IPriceOracle(oracle).getSupportedAssets() returns (address[] memory a) {
            assets = a;
        } catch {
            // best-effort fallback
            return 0;
        }

        if (assets.length > _MAX_BATCH_SIZE) revert BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            if (asset == address(0)) continue;

            uint256 totalAmount;
            try ICollateralManager(cm).getTotalCollateralByAsset(asset) returns (uint256 a) {
                totalAmount = a;
            } catch {
                continue;
            }
            if (totalAmount == 0) continue;

            try IPriceOracle(oracle).getPrice(asset) returns (uint256 price, uint256 /*timestamp*/, uint256 decimals) {
                if (price == 0) continue;
                if (decimals > 77) continue;
                uint256 scale = 10 ** decimals;
                if (scale == 0) continue;
                totalValue += Math.mulDiv(totalAmount, price, scale);
            } catch {
                continue;
            }
        }
    }

    /**
     * @notice Get value of an asset amount (settlement token units).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     * - Best-effort: returns 0 if the oracle call fails.
     *
     * @param asset Asset address
     * @param amount Asset amount (asset decimals)
     * @return value Value in settlement token units (oracle-defined decimals)
     */
    function getAssetValue(address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256 value)
    {
        if (asset == address(0) || amount == 0) return 0;
        (, , address oracle) = _resolveCollateralAndOracle();

        try IPriceOracle(oracle).getPrice(asset) returns (uint256 price, uint256 /*timestamp*/, uint256 decimals) {
            if (price == 0) return 0;
            if (decimals > 77) return 0;
            uint256 scale = 10 ** decimals;
            if (scale == 0) return 0;
            return Math.mulDiv(amount, price, scale);
        } catch {
            return 0;
        }
    }

    /*━━━━━━━━━━━━━━━ Cache helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Check whether a user's cache is valid (legacy user-level timestamp check).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return isValid Whether the user-level cache marker is valid
     */
    function isUserCacheValid(address user) external view returns (bool isValid) {
        uint256 ts = _cacheTimestamps[user];
        if (ts == 0) return false;
        if (ts <= _userInvalidatedAt[user]) return false;
        // solhint-disable-next-line not-rely-on-time
        return block.timestamp - ts <= _CACHE_DURATION;
    }

    /**
     * @notice Invalidate all cached entries for a user without iterating mappings.
     * @dev Reverts if:
     *      - caller is not the target user or an admin (PositionView__OnlyUserOrAdmin)
     *
     * Security:
     * - User-or-admin gated
     *
     * @param user Target user address
     */
    function clearUserCache(address user) external onlyUserOrStrictAdmin(user) {
        // Invalidate all cached entries for this user without iterating mappings.
        // We keep per-(user,asset) cached values in storage, but mark them invalid via a user-level barrier.
        // solhint-disable-next-line not-rely-on-time
        _userInvalidatedAt[user] = block.timestamp;
        delete _cacheTimestamps[user];
    }

    /**
     * @notice Get the current position version for (user, asset).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @param asset Asset address
     * @return version Position version (0 if never written)
     */
    function getPositionVersion(address user, address asset) external view returns (uint64 version) {
        return _positionVersion[user][asset];
    }

    /**
     * @notice Get the last cache write timestamp for (user, asset).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @param asset Asset address
     * @return timestamp Last update timestamp (seconds since epoch; 0 if never written)
     */
    function getPositionUpdatedAt(address user, address asset) external view returns (uint256 timestamp) {
        return _positionUpdatedAt[user][asset];
    }

    /*━━━━━━━━━━━━━━━ Internal ━━━━━━━━━━━━━━━*/
    function _isValidPosition(address user, address asset) internal view returns (bool) {
        uint256 ts = _positionUpdatedAt[user][asset];
        if (ts == 0) return false;
        // if user cleared cache after this position was written, treat as invalid
        if (ts <= _userInvalidatedAt[user]) return false;
        // solhint-disable-next-line not-rely-on-time
        return block.timestamp - ts <= _CACHE_DURATION;
    }

    function _getCachedOrLatestPosition(address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt)
    {
        (collateral, debt, ) = _getCachedOrLatestPositionWithValidity(user, asset);
    }

    function _getCachedOrLatestPositionWithValidity(address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt, bool isValid)
    {
        collateral = _collateralCache[user][asset];
        debt       = _debtCache[user][asset];
        // MUST (ARCH): validity is per (user, asset), not user-global.
        isValid = _isValidPosition(user, asset);
        if (!isValid) {
            (collateral, debt) = _fetchLatestPosition(user, asset);
            return (collateral, debt, false);
        }
        return (collateral, debt, true);
    }

    function _fetchLatestPosition(address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt)
    {
        (address cm, address le) = _resolveLedgerModules();
        collateral = ICollateralManager(cm).getCollateral(user, asset);
        debt       = ILendingEngineBasic(le).getDebt(user, asset);
    }

    function _fetchLatestPositionGuarded(
        address user,
        address asset,
        uint256 expectedCollateral,
        uint256 expectedDebt
    ) internal returns (bool ok, uint256 collateral, uint256 debt) {
        (address cm, address le) = _resolveLedgerModules();

        try ICollateralManager(cm).getCollateral(user, asset) returns (uint256 ledgerCollateral) {
            try ILendingEngineBasic(le).getDebt(user, asset) returns (uint256 ledgerDebt) {
                return (true, ledgerCollateral, ledgerDebt);
            } catch (bytes memory reason) {
                emit CacheUpdateFailed(user, asset, address(this), expectedCollateral, expectedDebt, reason);
                return (false, 0, 0);
            }
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, asset, address(this), expectedCollateral, expectedDebt, reason);
            return (false, 0, 0);
        }
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade (internal, called by upgradeTo/upgradeToAndCall).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN role (MissingRole via ACM)
     *      - newImplementation is zero (PositionView__ZeroImplementation)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - onlyValidRegistry modifier
     * - ACTION_ADMIN role-gated via ACM
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert PositionView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Module resolution ━━━━━━━━━━━━━━━*/
    function _resolveLedgerModules() internal view returns (address cm, address le) {
        Registry registry = Registry(_registryAddr);
        cm = registry.getModuleOrRevert(ModuleKeys.KEY_CM);
        le = registry.getModuleOrRevert(ModuleKeys.KEY_LE);
    }

    function _resolveBusinessModules()
        internal
        view
        returns (address cm, address le, address vaultCore, address vbl, address vaultRouter)
    {
        Registry registry = Registry(_registryAddr);
        cm        = registry.getModuleOrRevert(ModuleKeys.KEY_CM);
        le        = registry.getModuleOrRevert(ModuleKeys.KEY_LE);
        vaultCore = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        vbl       = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        // Architecture-Guide: resolve VaultRouter via VaultCore.viewContractAddrVar() to avoid multi-source keys.
        vaultRouter = IVaultCoreViewAddr(vaultCore).viewContractAddrVar();
    }

    function _getPriceOracleAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
    }

    function _resolveCollateralAndOracle() internal view returns (address cm, address le, address oracle) {
        Registry registry = Registry(_registryAddr);
        cm = registry.getModuleOrRevert(ModuleKeys.KEY_CM);
        le = registry.getModuleOrRevert(ModuleKeys.KEY_LE);
        oracle = registry.getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
    }

    function _computeVersionOrRevert(
        address user,
        address asset,
        uint64 nextVersion
    ) internal view returns (uint64 newVersion) {
        uint64 current = _positionVersion[user][asset];
        if (nextVersion == 0) {
            newVersion = current + 1;
        } else {
            newVersion = nextVersion;
        }
        // Strict optimistic concurrency:
        // - nextVersion==0: legacy auto-increment mode
        // - nextVersion!=0: must match current+1 (CAS-style next version)
        if (nextVersion != 0 && newVersion != current + 1) revert PositionView__StaleVersion(current, newVersion);
        if (nextVersion == 0 && newVersion <= current) revert PositionView__StaleVersion(current, newVersion);
    }

    // NOTE: requestId idempotency is intentionally version-bound and O(1):
    // we only keep the last applied requestId per (user, asset).

    /**
     * @notice Get Registry contract address (legacy getter for backward compatibility).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function getRegistry() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /**
     * @notice Get Registry contract address (legacy getter for backward compatibility).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function registryAddr() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the API semantic version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return apiVersion_ API semantic version
     */
    function apiVersion() public pure override returns (uint256 apiVersion_) {
        return 1;
    }

    /**
     * @notice Get the output/schema version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return schemaVersion_ Schema version
     */
    function schemaVersion() public pure override returns (uint256 schemaVersion_) {
        // V2: emits UserPositionCachedV2 (adds `version`) and maintains version/idempotency metadata.
        return 2;
    }
}
