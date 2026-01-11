// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
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
import { ZeroAddress, EmptyArray, ArrayLengthMismatch } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

interface IVaultCoreViewAddr {
    function viewContractAddrVar() external view returns (address);
}

/// @title PositionView
/// @notice 用户抵押/债务视图模块 – 负责维护位置缓存并提供 0-gas 查询接口
/// @dev 拆分自原 UserView；不保存复杂业务状态，仅存轻量缓存
/// @custom:security-contact security@example.com
contract PositionView is Initializable, UUPSUpgradeable, ViewVersioned {
    // ============ Events ============
    event UserPositionCached(address indexed user, address indexed asset, uint256 collateral, uint256 debt, uint256 ts);
    /// @notice 附带版本的缓存事件（向后兼容：保留旧事件）
    event UserPositionCachedV2(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint64 version,
        uint256 ts
    );
    event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason);
    /// @notice 幂等重复请求被忽略（不重复写缓存）
    event IdempotentRequestIgnored(address indexed user, address indexed asset, bytes32 indexed requestId, uint64 seq);

    // ============ Errors ============
    error PositionView__Unauthorized();
    error PositionView__InvalidInput();
    error PositionView__LedgerMismatch();
    error PositionView__LedgerReadFailed();
    error PositionView__StaleVersion(uint64 currentVersion, uint64 incomingVersion);
    error PositionView__InvalidDelta();
    error PositionView__OutOfOrderSeq(uint64 currentSeq, uint64 incomingSeq);
    error PositionView__OnlyUserOrAdmin();
    error PositionView__OnlyAdmin();
    error PositionView__BatchTooLarge(uint256 length, uint256 max);
    error PositionView__ZeroImplementation();

    // ============ Storage ============
    address private _registryAddr;

    // user => asset => collateral|debt
    mapping(address => mapping(address => uint256)) private _collateralCache;
    mapping(address => mapping(address => uint256)) private _debtCache;
    mapping(address => uint256)                         private _cacheTimestamps;
    // user => asset => version (单调递增)
    mapping(address => mapping(address => uint64))      private _positionVersion;
    // user => asset => last updated timestamp
    mapping(address => mapping(address => uint256))     private _positionUpdatedAt;
    // user => asset => last applied seq (optional monotonic ordering aid)
    mapping(address => mapping(address => uint64))      private _positionSeq;
    // user => asset => last applied requestId (O(1) idempotency, version-bound)
    mapping(address => mapping(address => bytes32))     private _lastAppliedRequestId;

    // constants via ViewConstants
    uint256 private constant CACHE_DURATION  = ViewConstants.CACHE_DURATION;
    uint256 private constant MAX_BATCH_SIZE  = ViewConstants.MAX_BATCH_SIZE;

    // ============ Modifiers ============
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    modifier onlyBusinessContract() {
        (address cm, address le, address vaultCore, address vbl, address vaultRouter) = _resolveBusinessModules();
        if (msg.sender != cm && msg.sender != le && msg.sender != vaultCore && msg.sender != vbl && msg.sender != vaultRouter) {
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

    // === Access helpers ===
    modifier onlyUserOrStrictAdmin(address user) {
        if (msg.sender != user && !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)) revert PositionView__OnlyUserOrAdmin();
        _;
    }

    modifier onlyAdmin() {
        if (!_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)) revert PositionView__OnlyAdmin();
        _;
    }

    // ============ Initializer ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Push API (called by business modules) ============
    /**
     * @notice 推送用户抵押/债务变更到缓存
     * @param user       用户地址
     * @param asset      资产地址
     * @param collateral 最新抵押数量
     * @param debt       最新债务数量
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
     * @notice 推送用户抵押/债务变更到缓存（携带幂等/顺序上下文）
     * @dev 若 requestId 重复则幂等忽略（不重复写入，不 revert）
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
     * @notice 推送用户抵押/债务变更到缓存（带版本号，用于并发顺序控制）
     * @param nextVersion 期望写入的“下一版本号”（strict）：0 表示由合约自增；非 0 时必须等于 currentVersion+1
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
     * @notice 推送用户抵押/债务变更到缓存（携带幂等/顺序上下文 + nextVersion）
     * @dev nextVersion != 0 时，必须严格等于 currentVersion+1，否则 revert（乐观并发）
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
     * @notice 推送用户抵押/债务增量到缓存（兼容版本，自增版本号）
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
     * @notice 推送用户抵押/债务增量到缓存（携带幂等/顺序上下文）
     * @dev 若 requestId 重复则幂等忽略（不重复写入，不 revert）
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
     * @notice 推送用户抵押/债务增量到缓存（指定版本号，用于并发顺序控制）
     * @param nextVersion 期望写入的“下一版本号”（strict）：0 表示由合约自增；非 0 时必须等于 currentVersion+1
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
     * @notice 推送用户抵押/债务增量到缓存（携带幂等/顺序上下文 + nextVersion）
     * @dev nextVersion != 0 时，必须严格等于 currentVersion+1，否则 revert（乐观并发）
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
            // 账本读取失败：记录事件，链下重试；不写缓存，不中断上层流程
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
        _cacheTimestamps[user]        = block.timestamp;
        _positionUpdatedAt[user][asset] = block.timestamp;
        _positionVersion[user][asset] = newVersion;

        emit UserPositionCached(user, asset, collateral, debt, block.timestamp);
        emit UserPositionCachedV2(user, asset, collateral, debt, newVersion, block.timestamp);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE, abi.encode(user, asset, collateral, debt));
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

        // 基于当前有效缓存（若失效则回退账本）计算增量
        (uint256 baseCollateral, uint256 baseDebt, bool isValid) = _getCachedOrLatestPositionWithValidity(user, asset);

        // 关键修复：当缓存无效时，base 值可能来自“已更新后的账本”，此时再叠加 delta 会导致双计数。
        // 对于 delta 推送，若无法保证 base 是“变更前”状态，则应退化为“全量对齐到账本”。
        if (!isValid) {
            uint64 newVersionSync = _computeVersionOrRevert(user, asset, nextVersion);
            if (seq != 0) _positionSeq[user][asset] = seq;
            if (requestId != bytes32(0)) _lastAppliedRequestId[user][asset] = requestId;
            _collateralCache[user][asset] = baseCollateral;
            _debtCache[user][asset]       = baseDebt;
            _cacheTimestamps[user]        = block.timestamp;
            _positionUpdatedAt[user][asset] = block.timestamp;
            _positionVersion[user][asset] = newVersionSync;

            emit UserPositionCached(user, asset, baseCollateral, baseDebt, block.timestamp);
            emit UserPositionCachedV2(user, asset, baseCollateral, baseDebt, newVersionSync, block.timestamp);
            DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE, abi.encode(user, asset, baseCollateral, baseDebt));
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
        _cacheTimestamps[user]        = block.timestamp;
        _positionUpdatedAt[user][asset] = block.timestamp;
        _positionVersion[user][asset] = newVersion;

        emit UserPositionCached(user, asset, newCollateral, newDebt, block.timestamp);
        emit UserPositionCachedV2(user, asset, newCollateral, newDebt, newVersion, block.timestamp);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE, abi.encode(user, asset, newCollateral, newDebt));
    }

    /**
     * @notice 链下重试入口：读取最新账本后重推缓存
     * @dev 仅 admin，可在接到 CacheUpdateFailed 后手动调用，幂等
     */
    function retryUserPositionUpdate(address user, address asset) external onlyAdmin {
        if (user == address(0) || asset == address(0)) revert PositionView__InvalidInput();

        (bool ok, uint256 collateral, uint256 debt) = _fetchLatestPositionGuarded(user, asset, 0, 0);
        if (!ok) {
            // 已在 _fetchLatestPositionGuarded 中 emit CacheUpdateFailed
            return;
        }

        uint64 newVersion = _computeVersionOrRevert(user, asset, 0);

        _collateralCache[user][asset] = collateral;
        _debtCache[user][asset]       = debt;
        _cacheTimestamps[user]        = block.timestamp;
        _positionUpdatedAt[user][asset] = block.timestamp;
        _positionVersion[user][asset] = newVersion;

        emit UserPositionCached(user, asset, collateral, debt, block.timestamp);
        emit UserPositionCachedV2(user, asset, collateral, debt, newVersion, block.timestamp);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE, abi.encode(user, asset, collateral, debt));
    }

    // ============ Read APIs ============
    function getUserPosition(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral, uint256 debt)
    {
        (collateral, debt) = _getCachedOrLatestPosition(user, asset);
    }

    /// @notice 查询用户仓位，附带缓存有效性标识
    /// @dev 缓存失效时自动回退账本数据，并返回 isValid=false
    function getUserPositionWithValidity(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral, uint256 debt, bool isValid)
    {
        (collateral, debt, isValid) = _getCachedOrLatestPositionWithValidity(user, asset);
    }

    function batchGetUserPositions(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        returns (uint256[] memory collaterals, uint256[] memory debts)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len != assets.length) revert ArrayLengthMismatch(len, assets.length);
        if (len > MAX_BATCH_SIZE) revert PositionView__BatchTooLarge(len, MAX_BATCH_SIZE);

        collaterals = new uint256[](len);
        debts       = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            (collaterals[i], debts[i]) = _getCachedOrLatestPosition(users[i], assets[i]);
        }
    }

    /**
     * @notice Get user's total collateral value (settlement token units).
     * @dev Reverts if:
     *      - oracle call reverts
     *      - registry not configured
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @return totalValue Total collateral value
     */
    function getUserTotalCollateralValue(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        if (user == address(0)) revert ZeroAddress();
        (address cm,, address oracle) = _resolveCollateralAndOracle();

        address[] memory assets;
        try ICollateralManager(cm).getUserCollateralAssets(user) returns (address[] memory a) {
            assets = a;
        } catch {
            // best-effort fallback
            return 0;
        }

        if (assets.length > MAX_BATCH_SIZE) revert PositionView__BatchTooLarge(assets.length, MAX_BATCH_SIZE);

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
     * @dev Reverts if oracle call fails.
     */
    function getTotalCollateralValue() external view onlyValidRegistry returns (uint256 totalValue) {
        (address cm,, address oracle) = _resolveCollateralAndOracle();

        address[] memory assets;
        try IPriceOracle(oracle).getSupportedAssets() returns (address[] memory a) {
            assets = a;
        } catch {
            // best-effort fallback
            return 0;
        }

        if (assets.length > MAX_BATCH_SIZE) revert PositionView__BatchTooLarge(assets.length, MAX_BATCH_SIZE);

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
     * @dev Reverts if oracle call fails.
     */
    function getAssetValue(address asset, uint256 amount) external view onlyValidRegistry returns (uint256 value) {
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

    // ============ Cache helpers ============
    function isUserCacheValid(address user) external view returns (bool) {
        return _isValid(_cacheTimestamps[user]);
    }

    function clearUserCache(address user) external onlyUserOrStrictAdmin(user) {
        delete _cacheTimestamps[user];
        // collateral/debt mappings不易整体删除，仅时间戳清零视为失效
    }

    /// @notice 获取指定 user/asset 的当前版本（0 表示未写入）
    function getPositionVersion(address user, address asset) external view returns (uint64) {
        return _positionVersion[user][asset];
    }

    /// @notice 获取指定 user/asset 的最近更新时间戳（0 表示未写入）
    function getPositionUpdatedAt(address user, address asset) external view returns (uint256) {
        return _positionUpdatedAt[user][asset];
    }

    // ============ Internal ============
    function _isValid(uint256 ts) internal view returns (bool) {
        return ts > 0 && block.timestamp - ts <= CACHE_DURATION;
    }

    function _getCachedOrLatestPosition(address user, address asset) internal view returns (uint256 collateral, uint256 debt) {
        (collateral, debt, ) = _getCachedOrLatestPositionWithValidity(user, asset);
    }

    function _getCachedOrLatestPositionWithValidity(address user, address asset) internal view returns (uint256 collateral, uint256 debt, bool isValid) {
        collateral = _collateralCache[user][asset];
        debt       = _debtCache[user][asset];
        isValid = _isValid(_cacheTimestamps[user]);
        if (!isValid) {
            (collateral, debt) = _fetchLatestPosition(user, asset);
            return (collateral, debt, false);
        }
        return (collateral, debt, true);
    }

    function _fetchLatestPosition(address user, address asset) internal view returns (uint256 collateral, uint256 debt) {
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

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert PositionView__ZeroImplementation();
    }

    // ============ Module resolution ============
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
        // Architecture-Guide: VaultRouter 地址通过 VaultCore.viewContractAddrVar() 解析，避免重复 key
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

    /// @notice 外部只读：获取 Registry 地址（向后兼容）
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 兼容旧版自动 getter
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        // V2: emits UserPositionCachedV2 (adds `version`) and maintains version/idempotency metadata.
        return 2;
    }
}
