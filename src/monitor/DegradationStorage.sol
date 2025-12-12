// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { Registry } from "../registry/Registry.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";

/**
 * @title DegradationStorage
 * @notice 降级事件存储管理器 - 提供基于环形缓冲区的事件存储和哈希去重优化
 * @dev 本合约是双架构设计中的存储组件，负责：
 *      1. 使用环形缓冲区存储降级事件，支持固定容量的事件历史
 *      2. 基于哈希的健康详情去重，节省存储空间
 *      3. 提供事件查询和统计功能
 *      4. 支持事件驱动架构，便于链下监控和AI分析
 *      5. 实现存储优化，减少Gas消耗
 * 
 * @custom:security 本合约实现了严格的权限控制：
 *      - 只有管理员可以添加事件和注册健康详情
 *      - 只有系统健康查看者可以查询事件和统计信息
 *      - 所有操作都需要有效的Registry地址
 * 
 * @custom:architecture 双架构设计中的存储层：
 *      - 环形缓冲区：固定容量的事件存储，自动覆盖最旧事件
 *      - 哈希去重：健康详情使用哈希映射，避免重复存储
 *      - 事件驱动：发出标准化事件，支持数据库收集
 *      - 存储优化：统计存储空间节省情况
 */
contract DegradationStorage is Initializable {
    // ============ Registry ==========
    /// @notice Registry合约地址，用于模块解析和权限验证
    address private _registryAddr;

    // ============ Structs ==========
    /**
     * @notice 降级事件数据结构
     * @dev 用于存储单次降级事件的完整信息
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

    // ============ Events ==========
    /**
     * @notice 环形缓冲区事件添加事件
     * @dev 当新事件添加到环形缓冲区时发出
     * @param globalIndex 全局事件索引
     * @param bufferPosition 缓冲区位置
     * @param module 模块地址
     * @param overwrite 是否覆盖了旧事件
     * @param timestamp 时间戳
     */
    event CircularBufferEventAdded(uint256 indexed globalIndex,uint256 indexed bufferPosition,address indexed module,bool overwrite,uint256 timestamp);
    
    /**
     * @notice 环形缓冲区统计事件
     * @dev 当缓冲区状态发生变化时发出
     * @param currentIndex 当前索引
     * @param actualCount 实际事件数量
     * @param maxCapacity 最大容量
     * @param timestamp 时间戳
     */
    event CircularBufferStats(uint256 currentIndex,uint256 actualCount,uint256 maxCapacity,uint256 timestamp);
    
    /**
     * @notice 存储优化统计事件
     * @dev 记录存储优化的效果
     * @param fieldType 字段类型
     * @param originalSize 原始大小
     * @param optimizedSize 优化后大小
     * @param spaceSaved 节省的空间
     * @param timestamp 时间戳
     */
    event StorageOptimizationStats(string fieldType,uint256 originalSize,uint256 optimizedSize,uint256 spaceSaved,uint256 timestamp);
    
    /**
     * @notice 健康详情注册事件
     * @dev 当新的健康详情被注册时发出
     * @param detailsHash 详情哈希
     * @param details 详情描述
     * @param module 模块地址
     * @param timestamp 时间戳
     */
    event HealthDetailsRegistered(bytes32 indexed detailsHash,string details,address indexed module,uint256 timestamp);

    // ============ Constants ==========
    /// @notice 最大降级事件数量（环形缓冲区容量）
    uint256 private constant MAX_DEGRADATION_EVENTS = 100;
    
    /// @notice 健康详情最大长度
    uint256 private constant MAX_DETAILS_LENGTH    = 128;
    
    /// @notice 健康详情最小长度
    uint256 private constant MIN_DETAILS_LENGTH    = 5;

    // ============ Pre-defined health detail hashes ==========
    /// @notice 预定义的健康详情哈希（与ModuleHealthView保持同步）
    bytes32 private constant DETAILS_HEALTHY        = keccak256("Module is healthy");
    bytes32 private constant DETAILS_ZERO_ADDRESS   = keccak256("Module address is zero");
    bytes32 private constant DETAILS_NO_CODE        = keccak256("Module has no code");
    bytes32 private constant DETAILS_FAILED_CHECK   = keccak256("Module failed health check");
    bytes32 private constant DETAILS_TIMEOUT        = keccak256("Health check timeout");
    bytes32 private constant DETAILS_CALL_FAILED    = keccak256("External call failed");
    bytes32 private constant DETAILS_NOT_RESPONDING = keccak256("Module not responding");

    // ============ Storage ==========
    /// @notice 环形缓冲区：索引 => 降级事件
    mapping(uint256 => DegradationEvent) private _circularEvents;
    
    /// @notice 当前事件索引（全局计数器）
    uint256 private _currentEventIndex;
    
    /// @notice 实际事件数量（不超过最大容量）
    uint256 private _actualEventCount;
    
    /// @notice 健康详情哈希到文本的映射（去重优化）
    mapping(bytes32 => string) private _detailsHashToText;

    // ============ Modifiers ==========
    /**
     * @notice 验证Registry地址有效性的修饰符
     * @dev 确保Registry地址不为零地址，防止无效调用
     */
    modifier onlyValidRegistry() { 
        if (_registryAddr==address(0)) revert ZeroAddress(); 
        _; 
    }
    
    /**
     * @notice 检查用户是否具有指定角色
     * @param actionKey 操作权限键
     * @param user 用户地址
     * @return 是否具有权限
     */
    function _hasRole(bytes32 actionKey,address user) internal view returns(bool){
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acm).hasRole(actionKey,user);
    }
    
    /**
     * @notice 系统健康查看者权限验证修饰符
     * @dev 只允许管理员或系统状态查看者访问
     */
    modifier onlySystemHealthViewer(){
        require(_hasRole(ActionKeys.ACTION_ADMIN,msg.sender)||_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS,msg.sender),"DegradationStorage: no permission"); 
        _; 
    }
    
    /**
     * @notice 管理员权限验证修饰符
     * @dev 只允许管理员执行关键操作
     */
    modifier onlyAdmin(){ 
        require(_hasRole(ActionKeys.ACTION_ADMIN,msg.sender),"DegradationStorage: admin only"); 
        _; 
    }

    // ============ Initializer ==========
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
     * @dev 设置Registry地址并初始化预定义的健康详情
     * @param initialRegistryAddr 初始Registry地址
     * @custom:security 确保Registry地址不为零地址
     */
    function initialize(address initialRegistryAddr) external initializer {
        if(initialRegistryAddr==address(0)) revert ZeroAddress();
        _registryAddr = initialRegistryAddr;
        _initializePredefinedHealthDetails();
    }

    /**
     * @notice 兼容接口：读取Registry地址
     * @return Registry合约地址
     */
    function registryAddr() external view returns(address){ 
        return _registryAddr; 
    }

    // ============ Ring-buffer logic ==========
    /**
     * @notice 添加事件到环形缓冲区
     * @dev 核心存储功能，使用环形缓冲区实现固定容量的事件存储
     * @param degradationEvent 要添加的降级事件
     * @custom:security 只有管理员可以添加事件
     * @custom:architecture 环形缓冲区实现：
     *      - 固定容量：最多存储MAX_DEGRADATION_EVENTS个事件
     *      - 自动覆盖：当缓冲区满时，自动覆盖最旧的事件
     *      - 索引管理：维护全局索引和实际数量
     */
    function addEventToCircularBuffer(DegradationEvent memory degradationEvent) external onlyValidRegistry onlyAdmin {
        uint256 pos = _currentEventIndex % MAX_DEGRADATION_EVENTS;
        bool overwrite = _actualEventCount >= MAX_DEGRADATION_EVENTS;
        _circularEvents[pos] = degradationEvent;
        _currentEventIndex++;
        if(_actualEventCount<MAX_DEGRADATION_EVENTS){ 
            _actualEventCount++; 
        }
        emit CircularBufferEventAdded(_currentEventIndex-1,pos,degradationEvent.module,overwrite,block.timestamp);
    }

    /**
     * @notice 从环形缓冲区获取事件
     * @dev 根据索引获取事件，支持从最新到最旧的查询
     * @param index 事件索引（0为最新事件）
     * @return 降级事件数据结构
     * @custom:security 只有系统健康查看者可以查询
     * @custom:architecture 环形缓冲区查询：
     *      - 索引0：最新事件
     *      - 索引1：第二新事件
     *      - 以此类推
     */
    function getEventFromCircularBuffer(uint256 index) external view onlyValidRegistry onlySystemHealthViewer returns(DegradationEvent memory){
        require(index < _actualEventCount, "DegradationStorage: index OOB");
        uint256 actualIndex;
        if(_currentEventIndex>index){ 
            actualIndex = (_currentEventIndex-1-index)%MAX_DEGRADATION_EVENTS; 
        }
        else { 
            actualIndex = (MAX_DEGRADATION_EVENTS+_currentEventIndex-1-index)%MAX_DEGRADATION_EVENTS; 
        }
        return _circularEvents[actualIndex];
    }

    /**
     * @notice 获取环形缓冲区统计信息
     * @dev 提供缓冲区的状态信息
     * @return currentIndex 当前索引
     * @return actualCount 实际事件数量
     * @return maxCapacity 最大容量
     * @return isFull 是否已满
     * @custom:security 只有系统健康查看者可以访问
     */
    function getCircularBufferStats() external view onlyValidRegistry onlySystemHealthViewer returns(uint256 currentIndex,uint256 actualCount,uint256 maxCapacity,bool isFull){
        return (_currentEventIndex,_actualEventCount,MAX_DEGRADATION_EVENTS,_actualEventCount>=MAX_DEGRADATION_EVENTS);
    }

    /**
     * @notice 清空环形缓冲区
     * @dev 管理员功能，用于清空所有事件数据
     * @custom:security 只有管理员可以调用
     */
    function clearCircularBuffer() external onlyValidRegistry onlyAdmin {
        _currentEventIndex=0; 
        _actualEventCount=0;
        emit CircularBufferStats(0,0,MAX_DEGRADATION_EVENTS,block.timestamp);
    }

    // ============ Health detail helpers ==========
    /**
     * @notice 初始化预定义的健康详情
     * @dev 内部函数，在初始化时设置预定义的健康详情哈希映射
     * @custom:architecture 存储优化：预定义详情避免重复存储
     */
    function _initializePredefinedHealthDetails() internal {
        _detailsHashToText[DETAILS_HEALTHY] = "Module is healthy";
        _detailsHashToText[DETAILS_ZERO_ADDRESS] = "Module address is zero";
        _detailsHashToText[DETAILS_NO_CODE] = "Module has no code";
        _detailsHashToText[DETAILS_FAILED_CHECK] = "Module failed health check";
        _detailsHashToText[DETAILS_TIMEOUT] = "Health check timeout";
        _detailsHashToText[DETAILS_CALL_FAILED] = "External call failed";
        _detailsHashToText[DETAILS_NOT_RESPONDING] = "Module not responding";
        emit StorageOptimizationStats("HealthDetails",7*32,7*32,0,block.timestamp);
    }

    /**
     * @notice 注册新的健康详情（如果不存在）
     * @dev 基于哈希的去重机制，避免重复存储相同的健康详情
     * @param detailsHash 详情哈希
     * @param details 详情描述
     * @param module 模块地址
     * @custom:security 只有管理员可以注册
     * @custom:architecture 存储优化：
     *      - 哈希去重：相同详情只存储一次
     *      - 空间节省：统计存储空间节省情况
     *      - 事件驱动：发出注册事件便于监控
     */
    function registerHealthDetailsIfNew(bytes32 detailsHash,string memory details,address module) external onlyValidRegistry onlyAdmin {
        if(bytes(_detailsHashToText[detailsHash]).length==0){
            _detailsHashToText[detailsHash]=details;
            emit HealthDetailsRegistered(detailsHash,details,module,block.timestamp);
            uint256 saved = bytes(details).length > 32 ? bytes(details).length - 32 : 0;
            emit StorageOptimizationStats("HealthDetails",bytes(details).length,32,saved,block.timestamp);
        }
    }

    /**
     * @notice 根据哈希获取健康详情
     * @dev 提供健康详情的查询功能
     * @param hash 详情哈希
     * @return 健康详情描述
     * @custom:security 只有系统健康查看者可以访问
     */
    function getHealthDetailsByHash(bytes32 hash) external view onlyValidRegistry onlySystemHealthViewer returns(string memory){ 
        return _detailsHashToText[hash]; 
    }

    // ============ Storage gap ============
    /// @notice 存储间隙，用于未来升级
    uint256[50] private __gap;
}
