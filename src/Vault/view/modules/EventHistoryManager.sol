// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @title EventHistoryManager（轻量级桩件）
/// @notice 2025-08 架构重构后，链上事件归档已迁移至链下。本合约仅保留一个 `HistoryRecorded` 事件，
///         供索引服务监听，并且不再持久化任何链上存储，以最低成本兼容旧模块（如 `UserView`）。
contract EventHistoryManager is Initializable, UUPSUpgradeable, ViewVersioned {
    // =========================  Events  =========================

    /// @notice 业务模块记录事件时触发，供链下索引消费
    event HistoryRecorded(bytes32 indexed eventType, address indexed user, address indexed asset, uint256 amount, bytes extraData, uint256 timestamp);

    // =========================  Storage  =========================

    address private _registryAddr;

    // =========================  Modifiers  =========================

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    modifier onlyAuthorizedModule() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_MANAGE_EVENT_HISTORY, msg.sender);
        _;
    }

    // =========================  Initialiser  =========================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice 初始化事件历史管理器
     * @param initialRegistryAddr Registry 合约地址
     * @dev 只能调用一次；若 `initialRegistryAddr` 为 0 地址则回滚
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // =========================  Public API  =========================

    /**
     * @notice 记录业务事件（仅供链下消费）
     * @param eventType 事件类型哈希
     * @param user      相关用户地址
     * @param asset     相关资产地址
     * @param amount    金额/数量
     * @param extraData 额外 ABI 编码数据
     */
    function recordEvent(bytes32 eventType, address user, address asset, uint256 amount, bytes calldata extraData) external onlyValidRegistry onlyAuthorizedModule {
        uint256 timestamp = block.timestamp;
        emit HistoryRecorded(eventType, user, asset, amount, extraData, timestamp);

        // 触发统一 DataPushed 事件，符合《Architecture-Guide》中的“统一 DataPush 接口”
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_HISTORY,
            abi.encode(eventType, user, asset, amount, extraData)
        );
    }

    // =========================  UUPS upgradeability  =========================

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}

    /**
     * @notice 获取 Registry 合约地址（新接口）
     * @dev 建议使用本函数而非已废弃的 `registryAddr()`
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
}
