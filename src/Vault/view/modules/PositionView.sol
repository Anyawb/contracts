// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";

/// @title PositionView
/// @notice 用户抵押/债务视图模块 – 负责维护位置缓存并提供 0-gas 查询接口
/// @dev 拆分自原 UserView；不保存复杂业务状态，仅存轻量缓存
/// @custom:security-contact security@example.com
contract PositionView is Initializable, UUPSUpgradeable {
    // ============ Events ============
    event UserPositionCached(address indexed user, address indexed asset, uint256 collateral, uint256 debt, uint256 ts);

    // ============ Storage ============
    address private _registryAddr;

    // user => asset => collateral|debt
    mapping(address => mapping(address => uint256)) private _collateralCache;
    mapping(address => mapping(address => uint256)) private _debtCache;
    mapping(address => uint256)                         private _cacheTimestamps;

    // constants via ViewConstants
    uint256 private constant CACHE_DURATION  = ViewConstants.CACHE_DURATION;
    uint256 private constant MAX_BATCH_SIZE  = ViewConstants.MAX_BATCH_SIZE;

    // ============ Modifiers ============
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    function _requireRole(bytes32 actionKey, address user) internal view {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(actionKey, user);
    }

    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acm).hasRole(actionKey, user);
    }

    // === Access helpers ===
    modifier onlyUserOrStrictAdmin(address user) {
        require(msg.sender == user || _hasRole(ActionKeys.ACTION_ADMIN, msg.sender), "PositionView: unauthorized");
        _;
    }

    modifier onlyBatchOperator() {
        require(_hasRole(ActionKeys.ACTION_ADMIN, msg.sender) || _hasRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender), "PositionView: unauthorized batch");
        _;
    }

    // ============ Initializer ============
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
    ) external onlyValidRegistry {
        _collateralCache[user][asset] = collateral;
        _debtCache[user][asset]       = debt;
        _cacheTimestamps[user]        = block.timestamp;

        emit UserPositionCached(user, asset, collateral, debt, block.timestamp);
        DataPushLibrary._emitData(keccak256("USER_POSITION_UPDATE"), abi.encode(user, asset, collateral, debt));
    }

    // ============ Read APIs ============
    function getUserPosition(address user, address asset)
        external
        view
        onlyUserOrStrictAdmin(user)
        returns (uint256 collateral, uint256 debt)
    {
        (collateral, debt) = _getCachedOrLatestPosition(user, asset);
    }

    function batchGetUserPositions(address[] calldata users, address[] calldata assets)
        external
        view
        onlyBatchOperator
        returns (uint256[] memory collaterals, uint256[] memory debts)
    {
        require(users.length == assets.length, "PositionView: length mismatch");
        require(users.length > 0 && users.length <= MAX_BATCH_SIZE, "PositionView: invalid batch size");

        uint256 len = users.length;
        collaterals = new uint256[](len);
        debts       = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            (collaterals[i], debts[i]) = _getCachedOrLatestPosition(users[i], assets[i]);
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

    // ============ Internal ============
    function _isValid(uint256 ts) internal view returns (bool) {
        return ts > 0 && block.timestamp - ts <= CACHE_DURATION;
    }

    function _getCachedOrLatestPosition(address user, address asset) internal view returns (uint256 collateral, uint256 debt) {
        collateral = _collateralCache[user][asset];
        debt       = _debtCache[user][asset];
        if (!_isValid(_cacheTimestamps[user])) {
            (collateral, debt) = _fetchLatestPosition(user, asset);
        }
    }

    function _fetchLatestPosition(address user, address asset) internal view returns (uint256 collateral, uint256 debt) {
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        collateral = ICollateralManager(cm).getCollateral(user, asset);
        debt       = ILendingEngineBasic(le).getDebt(user, asset);
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        require(newImplementation != address(0), "PositionView: zero impl");
    }

    /// @notice 外部只读：获取 Registry 地址（向后兼容）
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 兼容旧版自动 getter
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }
}
