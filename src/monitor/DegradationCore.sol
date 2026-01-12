// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ViewConstants } from "../Vault/view/ViewConstants.sol";
import { 
    ZeroAddress,
    NotAContract
} from "../errors/StandardErrors.sol";

/**
 * @title DegradationCore
 * @notice 系统降级监控核心模块 - 提供系统级降级统计和事件记录功能
 * @dev 本合约是双架构设计中的系统监控组件，负责：
 *      1. 记录系统降级事件（如预言机失效、价格异常等）
 *      2. 维护降级统计数据（总次数、最后时间、降级原因等）
 *      3. 提供事件驱动架构支持，便于链下监控和AI分析
 *      4. 支持优雅降级策略的统计和监控
 * 
 * @custom:security 本合约实现了严格的权限控制：
 *      - 只有管理员可以记录降级事件
 *      - 只有系统健康查看者可以查询统计数据
 *      - 所有操作都需要有效的Registry地址
 * 
 * @custom:architecture 双架构设计中的监控层：
 *      - 事件驱动：发出标准化降级事件，支持数据库收集
 *      - 统计缓存：维护系统级降级统计，支持快速查询
 *      - 权限分层：管理员写入，查看者读取，确保数据安全
 */
contract DegradationCore is Initializable, UUPSUpgradeable {
    // ============ Storage ============
    /// @notice Registry合约地址，用于模块解析和权限验证
    address private _registryAddr;

    /**
     * @notice 系统降级统计数据结构
     * @dev 用于维护系统级降级统计信息，支持快速查询和监控
     * @param totalDegradations 总降级次数
     * @param lastDegradationTime 最后一次降级时间戳
     * @param lastDegradedModule 最后降级的模块地址
     * @param lastDegradationReasonHash 最后降级原因哈希
     * @param fallbackValueUsed 当前使用的降级值
     * @param totalFallbackValue 累计降级值总和
     * @param averageFallbackValue 平均降级值
     */
    struct DegradationStats {
        uint256 totalDegradations;
        uint256 lastDegradationTime;
        address lastDegradedModule;
        bytes32 lastDegradationReasonHash;
        uint256 fallbackValueUsed;
        uint256 totalFallbackValue;
        uint256 averageFallbackValue;
    }

    /**
     * @notice 降级事件数据结构
     * @dev 用于记录单次降级事件的详细信息
     * @param module 发生降级的模块地址
     * @param reasonHash 降级原因哈希
     * @param fallbackValue 降级时使用的备用值
     * @param usedFallback 是否使用了降级策略
     * @param timestamp 事件时间戳
     * @param blockNumber 事件区块号
     */
    struct DegradationEvent {
        address module;
        bytes32 reasonHash;
        uint256 fallbackValue;
        bool    usedFallback;
        uint256 timestamp;
        uint256 blockNumber;
    }

    /// @notice 系统降级统计数据缓存
    DegradationStats private _stats;

    /// @notice 降级原因哈希到文本的映射，用于可读性
    mapping(bytes32 => string) private _reasonHashToText;

    // ============ Events ============
    /**
     * @notice 降级检测事件
     * @dev 事件驱动架构核心事件，支持链下监控和AI分析
     * @param module 发生降级的模块地址
     * @param reason 降级原因描述
     * @param fallbackValue 降级时使用的备用值
     * @param usedFallback 是否使用了降级策略
     * @param timestamp 事件时间戳
     */
    event DegradationDetected(address indexed module, string reason, uint256 fallbackValue, bool usedFallback, uint256 timestamp);
    
    /**
     * @notice 降级统计更新事件
     * @dev 当统计数据发生变化时发出，支持实时监控
     * @param total 总降级次数
     * @param lastTime 最后降级时间
     * @param lastModule 最后降级模块
     * @param timestamp 更新时间戳
     */
    event DegradationStatsUpdated(uint256 total,uint256 lastTime,address lastModule,uint256 timestamp);
    
    /**
     * @notice 降级原因注册事件
     * @dev 当新的降级原因被注册时发出
     * @param reasonHash 原因哈希
     * @param reason 原因描述
     * @param timestamp 注册时间戳
     */
    event DegradationReasonRegistered(bytes32 indexed reasonHash,string reason,uint256 timestamp);

    // ============ Modifiers / helpers ============
    /**
     * @notice 验证Registry地址有效性的修饰符
     * @dev 确保Registry地址不为零地址，防止无效调用
     */
    modifier onlyValidRegistry() { 
        if (_registryAddr==address(0)) revert ZeroAddress(); 
        _; 
    }
    
    /**
     * @notice 系统健康查看者权限验证修饰符
     * @dev 只允许管理员或系统状态查看者访问
     *      遵循双架构设计中的权限分层原则
     */
    modifier onlySystemHealthViewer() {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(
            IAccessControlManager(acm).hasRole(ActionKeys.ACTION_ADMIN,msg.sender) ||
            IAccessControlManager(acm).hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS,msg.sender),
            "DegradationCore: no permission"
        ); 
        _; 
    }
    
    /**
     * @notice 管理员权限验证修饰符
     * @dev 只允许管理员执行关键操作，确保系统安全
     */
    modifier onlyAdmin() {
        IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
            .requireRole(ActionKeys.ACTION_ADMIN,msg.sender); 
        _; 
    }

    /**
     * @notice 构造函数，禁用初始化器
     * @dev 防止合约被直接部署，必须通过代理模式使用
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(){ 
        _disableInitializers(); 
    }

    /**
     * @notice 初始化函数
     * @dev 设置Registry地址，启用合约功能
     * @param initialRegistryAddr 初始Registry地址
     * @custom:security 确保Registry地址不为零地址
     */
    function initialize(address initialRegistryAddr) external initializer {
        require(initialRegistryAddr!=address(0),"DegradationCore: zero reg");
        __UUPSUpgradeable_init();
        _registryAddr=initialRegistryAddr;
    }

    /* ============ UUPS ============ */
    /**
     * @notice Authorize UUPS upgrade to a new implementation.
     * @dev Role-gated via AccessControlManager.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
        // onlyAdmin already ensures ACTION_ADMIN; additionally require upgrade role for stricter control.
        IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
            .requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    // ============ External view ============
    /**
     * @notice 获取系统降级统计数据
     * @dev 提供系统级降级统计的快速查询，支持监控和告警
     * @return 降级统计数据结构
     * @custom:security 只有系统健康查看者可以访问
     */
    function getDegradationStats() external view onlyValidRegistry onlySystemHealthViewer returns (DegradationStats memory){
        return _stats;
    }
    
    /**
     * @notice 根据哈希获取降级原因文本
     * @dev 提供降级原因的可读性查询
     * @param reasonHash 原因哈希
     * @return 原因描述文本
     * @custom:security 只有系统健康查看者可以访问
     */
    function getReasonText(bytes32 reasonHash) external view onlyValidRegistry onlySystemHealthViewer returns (string memory){
        return _reasonHashToText[reasonHash];
    }

    /**
     * @notice 兼容接口：读取Registry地址
     * @dev 提供Registry地址的查询接口，支持外部集成
     * @return Registry合约地址
     */
    function registryAddr() external view returns (address) { 
        return _registryAddr; 
    }

    // ============ Internal logic ============
    /**
     * @notice 注册降级原因
     * @dev 内部函数，用于注册新的降级原因并发出事件
     * @param hash 原因哈希
     * @param reason 原因描述
     * @custom:architecture 支持事件驱动架构，便于链下分析
     */
    function _registerReason(bytes32 hash,string memory reason) internal {
        if(bytes(_reasonHashToText[hash]).length==0){ 
            _reasonHashToText[hash]=reason; 
            emit DegradationReasonRegistered(hash,reason,block.timestamp);
        } 
    }

    /**
     * @notice 记录降级事件
     * @dev 核心内部函数，用于记录降级事件并更新统计数据
     * @param module 发生降级的模块地址
     * @param reason 降级原因描述
     * @param fallbackVal 降级时使用的备用值
     * @param usedFallback 是否使用了降级策略
     * @custom:architecture 事件驱动架构核心实现：
     *      - 更新统计数据缓存
     *      - 发出标准化事件
     *      - 支持链下监控和AI分析
     */
    function _recordEvent(address module,string memory reason,uint256 fallbackVal,bool usedFallback) internal {
        bytes32 hash=keccak256(bytes(reason));
        _registerReason(hash,reason);
        
        // 更新统计数据
        _stats.totalDegradations++; 
        _stats.lastDegradationTime=block.timestamp; 
        _stats.lastDegradedModule=module; 
        _stats.lastDegradationReasonHash=hash; 
        _stats.fallbackValueUsed=fallbackVal; 
        _stats.totalFallbackValue+=fallbackVal;
        _stats.averageFallbackValue=_stats.totalDegradations>0? _stats.totalFallbackValue/_stats.totalDegradations:0;
        
        // 发出事件（事件驱动架构）
        emit DegradationDetected(module,reason,fallbackVal,usedFallback,block.timestamp);
        emit DegradationStatsUpdated(_stats.totalDegradations,_stats.lastDegradationTime,module,block.timestamp);
    }

    // ============ Administrative ============
    /**
     * @notice 管理员记录降级事件
     * @dev 管理员接口，用于手动记录系统降级事件
     * @param module 发生降级的模块地址
     * @param reason 降级原因描述
     * @param fallbackVal 降级时使用的备用值
     * @param usedFallback 是否使用了降级策略
     * @custom:security 只有管理员可以调用，确保数据安全
     * @custom:architecture 支持手动监控和测试场景
     */
    function adminRecordDegradation(address module,string calldata reason,uint256 fallbackVal,bool usedFallback) external onlyValidRegistry onlyAdmin {
        _recordEvent(module,reason,fallbackVal,usedFallback);
    }
}
