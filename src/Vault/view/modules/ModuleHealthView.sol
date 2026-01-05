// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ZeroAddress, MissingRole } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title ModuleHealthView
 * @notice 模块健康监控视图 - 轻量级模块健康检查系统
 * @dev 本合约是双架构设计中的健康监控组件，负责：
 *      1. 对注册模块执行低成本健康检查（代码大小验证）
 *      2. 将健康检查结果推送到HealthView进行统一管理
 *      3. 维护模块健康状态缓存，支持快速查询
 *      4. 提供向后兼容的接口，支持旧版系统集成
 *      5. 支持事件驱动架构，便于链下监控和AI分析
 * 
 * @custom:security 本合约实现了严格的权限控制：
 *      - 只有系统健康查看者可以执行健康检查
 *      - 所有操作都需要有效的Registry地址
 *      - 支持模块地址验证，防止无效检查
 * 
 * @custom:architecture 双架构设计中的健康监控层：
 *      - 轻量级检查：基于代码大小的低成本健康验证
 *      - 状态缓存：维护模块健康状态，支持快速查询
 *      - 事件驱动：发出标准化健康检查事件
 *      - 统一推送：将结果推送到HealthView进行集中管理
 *      - 向后兼容：保持与旧版ModuleHealthMonitor的接口兼容
 */
contract ModuleHealthView is Initializable, UUPSUpgradeable, ViewVersioned {
    // ============ Storage ============
    /// @notice Registry合约地址，用于模块解析和权限验证
    address private _registryAddr;

    // ============ Pre-defined health detail hashes ============
    /// @notice 预定义的健康详情哈希（与DegradationStorage保持同步）
    bytes32 private constant DETAILS_HEALTHY_HASH       = keccak256("Module is healthy");
    bytes32 private constant DETAILS_NO_CODE_HASH       = keccak256("Module has no code");

    // ============ Legacy-compatible data structs ============
    /**
     * @notice 模块健康状态快照（与旧版ModuleHealthMonitor保持兼容）
     * @dev 用于向后兼容，保持与旧版系统的数据结构一致
     * @param module 模块地址
     * @param isHealthy 模块是否健康
     * @param detailsHash 健康详情哈希
     * @param lastCheckTime 最后检查时间
     * @param consecutiveFailures 连续失败次数
     * @param totalChecks 总检查次数
     * @param successRate 成功率百分比（0-100）
     */
    struct ModuleHealthStatus {
        address module;
        bool    isHealthy;
        bytes32 detailsHash;
        uint256 lastCheckTime;
        uint256 consecutiveFailures;
        uint256 totalChecks;
        uint256 successRate; // percentage (0–100)
    }

    /// @notice 最新健康状态缓存：模块地址 => 健康状态
    mapping(address => ModuleHealthStatus) private _moduleHealth;

    // ============ Initialization ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice 初始化函数
     * @dev 设置Registry地址，启用合约功能
     * @param initialRegistryAddr 初始Registry地址
     * @custom:security 确保Registry地址不为零地址
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Modifiers ============
    /**
     * @notice 验证Registry地址有效性的修饰符
     * @dev 确保Registry地址不为零地址，防止无效调用
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /**
     * @notice 系统健康查看者权限验证修饰符
     * @dev 只允许管理员或系统状态查看者访问
     *      遵循双架构设计中的权限分层原则
     */
    modifier onlySystemHealthViewer() {
        if (
            !_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender) &&
            !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    // ============ Events ============
    /**
     * @notice 模块健康检查事件
     * @dev 事件驱动架构核心事件，支持链下监控和AI分析（区块时间请用日志本身的区块时间）
     * @param module 被检查的模块地址
     * @param isHealthy 模块是否健康
     * @param failures 连续失败次数
     */
    event ModuleHealthChecked(address indexed module, bool isHealthy, uint32 failures);

    // ============ External functions ============
    /**
     * @notice 执行轻量级健康检查并推送到HealthView
     * @dev 核心健康检查功能，基于代码大小进行低成本验证
     * @param module 要检查的模块地址
     * @return isHealthy 模块是否健康（非零代码大小）
     * @custom:security 只有系统健康查看者可以执行检查
     * @custom:architecture 健康检查流程：
     *      1. 验证模块地址有效性
     *      2. 检查代码大小（基础健康指标）
     *      3. 推送结果到HealthView
     *      4. 更新本地缓存
     *      5. 发出事件（事件驱动架构）
     */
    function checkAndPushModuleHealth(address module) external onlyValidRegistry onlySystemHealthViewer returns (bool isHealthy) {
        if (module == address(0)) revert ZeroAddress();

        bytes32 details;

        // 基础检查：合约地址 & 代码大小
        uint256 size;
        assembly { 
            size := extcodesize(module) 
        }
        if (size == 0) {
            isHealthy = false;
            details   = DETAILS_NO_CODE_HASH;
        } else {
            // Future: add interface ping / custom checks here
            isHealthy = true;
            details   = DETAILS_HEALTHY_HASH;
        }

        // 连续失败计数示例：健康=0，异常=1，可根据业务逻辑扩展
        uint32 failures = isHealthy ? 0 : 1;

        // 将结构化详情哈希推送至 HealthView
        address hvAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW);
        IHealthViewPush(hvAddr).pushModuleHealth(module, isHealthy, details, failures);

        emit ModuleHealthChecked(module, isHealthy, failures);

        // ----- 缓存健康结果 -----
        ModuleHealthStatus storage s = _moduleHealth[module];
        s.module = module;
        s.isHealthy = isHealthy;
        s.detailsHash = details;
        s.lastCheckTime = block.timestamp;
        s.consecutiveFailures = failures;
        s.totalChecks += 1;
        s.successRate = s.totalChecks == 0 ? 0 : ((s.successRate * (s.totalChecks - 1) + (isHealthy ? 100 : 0)) / s.totalChecks);
    }

    /**
     * @notice 兼容接口：读取Registry地址
     * @return Registry合约地址
     */
    function registryAddr() external view returns(address){ 
        return _registryAddr; 
    }

    /// @notice 推荐的新 getter
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // ============ Legacy-compatible getters ============
    /**
     * @notice 获取缓存的模块健康状态（向后兼容接口）
     * @dev 与旧版ModuleHealthMonitor保持接口兼容
     * @param module 要查询的模块地址
     * @return healthStatus 模块健康状态结构体
     * @custom:security 只有系统健康查看者可以访问
     */
    function getModuleHealthStatus(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealthStatus memory healthStatus)
    {
        healthStatus = _moduleHealth[module];
    }

    /**
     * @notice 执行轻量级健康检查但不改变状态（向后兼容）
     * @dev 纯查询函数，不更新缓存状态，与旧版接口兼容
     * @param module 要检查的模块地址
     * @return isHealthy 模块是否健康
     * @return details 健康详情描述
     * @custom:security 只有系统健康查看者可以访问
     * @custom:architecture 轻量级检查：
     *      - 不更新缓存状态
     *      - 不推送结果到HealthView
     *      - 仅返回当前检查结果
     */
    function checkModuleHealth(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (bool isHealthy, string memory details)
    {
        if (module == address(0)) {
            return (false, "Module address is zero");
        }

        uint256 size;
        assembly {
            size := extcodesize(module)
        }

        if (size == 0) {
            return (false, "Module has no code");
        }

        return (true, "Module is healthy");
    }

    // ============ Internal helpers ============
    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, actionKey, user);
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    uint256[50] private __gap;
}

/**
 * @title IHealthViewPush
 * @notice 轻量级接口，用于调用HealthView.pushModuleHealth
 * @dev 避免循环依赖，提供模块化的健康状态推送接口
 */
interface IHealthViewPush {
    /**
     * @notice 推送模块健康状态到HealthView
     * @param module 模块地址
     * @param ok 是否健康
     * @param detailsHash 健康详情哈希
     * @param failures 连续失败次数
     */
    function pushModuleHealth(address module, bool ok, bytes32 detailsHash, uint32 failures) external;
}
