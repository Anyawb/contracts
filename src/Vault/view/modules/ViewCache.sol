// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { AccessControlLibrary } from "../../../libraries/AccessControlLibrary.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

// 常量迁移至 DataPushTypes

/**
 * @title ViewCache
 * @notice 视图缓存模块（系统级快照）
 * @dev 用户维度缓存已迁移至 `UserView`；本合约仅负责系统级批量缓存，所有写操作触发 `CacheUpdated` 事件。
 */
contract ViewCache is Initializable, UUPSUpgradeable, ViewVersioned {
    // =========================  Events  =========================

    /// @notice Emitted whenever a system snapshot is successfully written.
    event CacheUpdated(address indexed asset, address indexed updater, uint256 timestamp);

    // =========================  Errors  =========================

    error ViewCache__ZeroAddress();
    error ViewCache__InvalidCacheData();
    error ViewCache__EmptyArray();
    error ViewCache__BatchTooLarge(uint256 length, uint256 max);
    error ViewCache__ZeroImplementation();

    // =========================  Structs  =========================

    struct SystemStatusCache {
        uint256 totalCollateral;   // Aggregated collateral amount
        uint256 totalDebt;         // Aggregated debt amount
        uint256 utilizationRate;   // Utilisation rate (WAD)
        uint256 timestamp;         // Snapshot timestamp
        bool    isValid;           // Explicit validity flag
    }

    // =========================  Constants  =========================

    // 统一常量
    uint256 private constant CACHE_DURATION = ViewConstants.CACHE_DURATION;
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    // =========================  Storage  =========================

    /// @notice Registry contract address
    address private _registryAddr;

    /// @notice Per-asset snapshot cache
    mapping(address => SystemStatusCache) private _systemStatusCache;

    /// @notice Last write timestamp for each asset (redundant to the struct but handy for off-chain tooling)
    mapping(address => uint256) private _systemCacheTimestamps;

    // =========================  Modifiers  =========================

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ViewCache__ZeroAddress();
        _;
    }

    // =========================  Initialiser  =========================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param initialRegistryAddr 协议 Registry 合约地址
    ///
    /// @notice 初始化合约
    /// @dev 仅在首次部署时调用，一旦初始化后不可再次执行。
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ViewCache__ZeroAddress();

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /// @notice Registry 地址（推荐）
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /// @notice Registry 地址（兼容旧命名）
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    // =========================  Write APIs  =========================

    /// @notice 写入或覆盖指定资产的系统快照
    /// @param asset 资产地址
    /// @param totalCollateral 总抵押数量
    /// @param totalDebt 总债务数量
    /// @param utilizationRate 利用率（WAD）
    /// @dev 仅持有 Registry 中 ACTION_VIEW_SYSTEM_DATA 权限的账户可调用。
    function setSystemStatus(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 utilizationRate
    ) external onlyValidRegistry {
        AccessControlLibrary.requireRole(
            _registryAddr,
            ActionKeys.ACTION_VIEW_SYSTEM_DATA,
            msg.sender,
            msg.sender
        );

        if (asset == address(0)) revert ViewCache__InvalidCacheData();

        _systemStatusCache[asset] = SystemStatusCache({
            totalCollateral: totalCollateral,
            totalDebt: totalDebt,
            utilizationRate: utilizationRate,
            timestamp: block.timestamp,
            isValid: true
        });
        _systemCacheTimestamps[asset] = block.timestamp;

        emit CacheUpdated(asset, msg.sender, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_SYSTEM_STATUS,
            abi.encode(asset, totalCollateral, totalDebt, utilizationRate, block.timestamp)
        );
    }

    /// @notice 清理指定资产的缓存
    /// @param asset 资产地址
    /// @dev 仅管理员 (ACTION_ADMIN) 可调用。
    function clearSystemCache(address asset) external onlyValidRegistry {
        AccessControlLibrary.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender, msg.sender);

        delete _systemStatusCache[asset];
        delete _systemCacheTimestamps[asset];

        emit CacheUpdated(asset, msg.sender, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_SYSTEM_STATUS,
            abi.encode(asset, uint256(0), uint256(0), uint256(0), block.timestamp)
        );
    }

    // =========================  Read APIs  =========================

    /// @notice 获取系统快照及其有效性
    /// @param asset 资产地址
    /// @return status 系统快照结构体
    /// @return isValid 快照是否有效
    function getSystemStatus(
        address asset
    ) external view returns (SystemStatusCache memory status, bool isValid) {
        status  = _systemStatusCache[asset];
        isValid = _isCacheValid(status.timestamp) && status.isValid;
    }

    /// @notice 批量获取系统快照
    /// @param assets 资产地址数组
    /// @return statuses 系统快照数组
    /// @return validFlags 是否有效数组
    /// @dev 当 `assets.length` 超过 MAX_BATCH_SIZE 时回退，避免过高 gas 消耗。
    function batchGetSystemStatus(
        address[] calldata assets
    ) external view returns (SystemStatusCache[] memory statuses, bool[] memory validFlags) {
        uint256 length = assets.length;
        if (length == 0) revert ViewCache__EmptyArray();
        if (length > MAX_BATCH_SIZE) revert ViewCache__BatchTooLarge(length, MAX_BATCH_SIZE);

        statuses   = new SystemStatusCache[](length);
        validFlags = new bool[](length);

        for (uint256 i; i < length; ++i) {
            SystemStatusCache memory cache = _systemStatusCache[assets[i]];
            statuses[i]   = cache;
            validFlags[i] = _isCacheValid(cache.timestamp) && cache.isValid;
        }
    }

    // =========================  Internal helpers  =========================

    function _isCacheValid(uint256 timestamp) internal view returns (bool) {
        return timestamp > 0 && block.timestamp - timestamp <= CACHE_DURATION;
    }

    // =========================  UUPS upgradeability  =========================

    /// @notice 升级授权（UUPS）
    /// @dev 仅管理员 (ACTION_ADMIN) 可通过。
    function _authorizeUpgrade(address newImplementation) internal override onlyValidRegistry {
        AccessControlLibrary.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender, msg.sender);
        if (newImplementation == address(0)) revert ViewCache__ZeroImplementation();
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }
} 