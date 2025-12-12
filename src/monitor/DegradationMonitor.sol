// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ZeroAddress, NotAContract, UpgradeNotAuthorized } from "../errors/StandardErrors.sol";

// Sub-modules (core & storage now in same folder; others remain under Vault view)
import "./DegradationCore.sol";
import "./DegradationStorage.sol";
import "../Vault/view/modules/ModuleHealthView.sol";
// DegradationAnalytics and DegradationAdmin implementations have been removed.
// Provide lightweight interfaces for backward compatibility.

/**
 * @title IDegradationAnalytics
 * @notice 降级分析接口 - 提供降级趋势分析功能
 * @dev 轻量级接口，用于向后兼容
 */
interface IDegradationAnalytics {
    function updateModuleDegradationCount(address module) external;
    function getSystemDegradationTrends() external view returns (uint256 totalEvents,uint256 recentEvents,address mostFrequentModule,uint256 averageFallbackValue);
}

/**
 * @title IDegradationAdmin
 * @notice 降级管理接口 - 预留未来管理操作
 * @dev 轻量级接口，用于向后兼容
 */
interface IDegradationAdmin {
    // Reserved for future admin operations
}

/**
 * @title DegradationMonitor
 * @notice 降级监控协调器 - 协调降级监控子模块的统一入口
 * @dev 本合约是双架构设计中的监控协调组件，负责：
 *      1. 协调降级核心模块、存储模块、健康监控模块等子模块
 *      2. 提供统一的降级事件记录接口
 *      3. 支持业务模块（如PriceOracle）直接上报降级事件
 *      4. 提供升级窗口管理和权限控制
 *      5. 支持事件驱动架构，便于链下监控和AI分析
 * 
 * @custom:security 本合约实现了严格的权限控制：
 *      - 只有管理员可以记录降级事件
 *      - 只有系统健康查看者可以查询统计数据
 *      - 支持升级窗口机制，防止意外升级
 *      - 业务模块可以直接上报降级事件（如PriceOracle）
 * 
 * @custom:architecture 双架构设计中的监控协调层：
 *      - 事件驱动：协调各子模块发出标准化事件
 *      - 模块协调：统一管理降级监控的各个子模块
 *      - 权限分层：管理员写入，查看者读取，业务模块上报
 *      - 升级控制：支持安全的合约升级机制
 */
contract DegradationMonitor is Initializable, UUPSUpgradeable {
    // ============ Registry / Sub-module addresses ============
    /// @notice Registry合约地址，用于模块解析和权限验证
    address private _registryAddr;
    
    /// @notice 降级核心模块地址
    address private _coreModuleAddr;
    
    /// @notice 降级存储模块地址
    address private _storageModuleAddr;
    
    /// @notice 健康监控模块地址
    address private _healthModuleAddr;
    
    /// @notice 降级分析模块地址
    address private _analyticsModuleAddr;
    
    /// @notice 降级管理模块地址
    address private _adminModuleAddr;

    // ============ Upgrade admin + window ============
    /// @notice 升级管理员地址
    address private _upgradeAdmin;
    
    /// @notice 升级窗口是否启用
    bool private _upgradeEnabled;
    
    /// @notice 升级窗口启用截止时间
    uint256 private _upgradeEnabledUntil;
    
    /// @notice 升级窗口持续时间（24小时）
    uint256 private constant UPGRADE_WINDOW = 24 hours;

    // ============ Events ============
    /**
     * @notice 模块协调事件
     * @dev 记录子模块操作的成功或失败状态（时间请使用区块时间）
     * @param operation 操作类型
     * @param targetModule 目标模块地址
     * @param success 操作是否成功
     * @param details 操作详情
     */
    event ModuleCoordination(string operation,address indexed targetModule,bool success,string details);
    
    /**
     * @notice 子模块更新事件
     * @dev 当子模块地址更新时发出（时间请使用区块时间）
     * @param moduleType 模块类型
     * @param oldModule 旧模块地址
     * @param newModule 新模块地址
     */
    event SubModuleUpdated(string moduleType,address indexed oldModule,address indexed newModule);
    
    /**
     * @notice 升级管理员变更事件
     * @dev 当升级管理员地址变更时发出（时间请使用区块时间）
     * @param oldAdmin 旧管理员地址
     * @param newAdmin 新管理员地址
     */
    event UpgradeAdminChanged(address indexed oldAdmin,address indexed newAdmin);
    
    /**
     * @notice 升级窗口变更事件
     * @dev 当升级窗口状态变更时发出（时间请使用区块时间）
     * @param enabled 是否启用
     * @param enabledUntil 启用截止时间
     * @param changedBy 变更者地址
     */
    event UpgradeWindowChanged(bool enabled,uint256 enabledUntil,address indexed changedBy);

    // ============ Errors ============
    error UpgradeWindowNotOpen();
    error UpgradeWindowExpired();
    error InvalidUpgradeAdmin();
    error ZeroImplementationAddress();
    error ModuleNotInitialized(string moduleType);
    error ModuleCallFailed(string moduleType,string operation);

    // ============ Modifiers & helpers ============
    /**
     * @notice 验证Registry地址有效性的修饰符
     * @dev 确保Registry地址不为零地址，防止无效调用
     */
    modifier onlyValidRegistry(){ 
        if(_registryAddr==address(0)) revert ZeroAddress(); 
        _; 
    }
    
    /**
     * @notice 权限验证内部函数
     * @param role 权限角色
     * @param user 用户地址
     */
    function _requireRole(bytes32 role,address user) internal view {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(role,user);
    }
    
    /**
     * @notice 检查用户是否具有指定角色
     * @param role 权限角色
     * @param user 用户地址
     * @return 是否具有权限
     */
    function _hasRole(bytes32 role,address user) internal view returns(bool){
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acm).hasRole(role,user);
    }
    
    /**
     * @notice 系统健康查看者权限验证修饰符
     * @dev 只允许管理员或系统状态查看者访问
     */
    modifier onlySystemHealthViewer(){ 
        require(_hasRole(ActionKeys.ACTION_ADMIN,msg.sender)||_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS,msg.sender),"DegradationMonitor: no permission"); 
        _; 
    }
    
    /**
     * @notice 管理员权限验证修饰符
     * @dev 只允许管理员执行关键操作
     */
    modifier onlyAdmin(){ 
        _requireRole(ActionKeys.ACTION_ADMIN,msg.sender); 
        _; 
    }
    
    /**
     * @notice 仅允许注册表中的指定模块调用
     * @dev 用于允许业务模块（如 PriceOracle）上报降级事件，无需管理员权限
     * @param moduleKey 模块键值
     */
    modifier onlyRegisteredModule(bytes32 moduleKey){
        address module = Registry(_registryAddr).getModuleOrRevert(moduleKey);
        require(msg.sender == module, "DegradationMonitor: caller is not registered module");
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
     * @dev 设置Registry地址、升级管理员和所有子模块地址
     * @param initialRegistryAddr 初始Registry地址
     * @param initialUpgradeAdmin 初始升级管理员地址
     * @param initialCore 初始核心模块地址
     * @param initialStorage 初始存储模块地址
     * @param initialHealth 初始健康监控模块地址
     * @param initialAnalytics 初始分析模块地址
     * @param initialAdmin 初始管理模块地址
     * @custom:security 确保Registry和升级管理员地址不为零地址
     */
    function initialize(address initialRegistryAddr,address initialUpgradeAdmin,address initialCore,address initialStorage,address initialHealth,address initialAnalytics,address initialAdmin) external initializer {
        if(initialRegistryAddr==address(0)) revert ZeroAddress();
        if(initialUpgradeAdmin==address(0)) revert InvalidUpgradeAdmin();
        _registryAddr = initialRegistryAddr;
        _upgradeAdmin = initialUpgradeAdmin;
        _coreModuleAddr = initialCore; 
        _storageModuleAddr = initialStorage; 
        _healthModuleAddr = initialHealth; 
        _analyticsModuleAddr = initialAnalytics; 
        _adminModuleAddr = initialAdmin;
        __UUPSUpgradeable_init();
    }

    // ============ View delegation ============
    /**
     * @notice 获取降级统计数据
     * @dev 委托调用到核心模块获取统计数据
     * @return 降级统计数据结构
     * @custom:security 只有系统健康查看者可以访问
     */
    function getDegradationStats() external view onlyValidRegistry onlySystemHealthViewer returns (DegradationCore.DegradationStats memory){
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        return DegradationCore(_coreModuleAddr).getDegradationStats();
    }
    
    /**
     * @notice 向后兼容包装器，用于旧版SystemView引用
     * @dev GracefulDegradationMonitor 已弃用，新接口为 getDegradationStats
     * @return 降级统计数据结构
     */
    function getGracefulDegradationStats() external view returns (DegradationCore.DegradationStats memory) {
        // 无需权限检查，仅向后兼容；内部调用已验证模块地址
        return DegradationCore(_coreModuleAddr).getDegradationStats();
    }
    
    /**
     * @notice 管理员记录降级事件
     * @dev 管理员接口，协调各子模块记录降级事件
     * @param module 发生降级的模块地址
     * @param reason 降级原因描述
     * @param fallbackValue 降级时使用的备用值
     * @param usedFallback 是否使用了降级策略
     * @custom:security 只有管理员可以调用
     * @custom:architecture 事件驱动架构：协调核心、存储、分析三个子模块
     */
    function recordDegradationEvent(address module,string memory reason,uint256 fallbackValue,bool usedFallback) external onlyValidRegistry onlyAdmin {
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        if(_storageModuleAddr==address(0)) revert ModuleNotInitialized("Storage");
        if(_analyticsModuleAddr==address(0)) revert ModuleNotInitialized("Analytics");
        
        // 1. 记录到核心模块
        try DegradationCore(_coreModuleAddr).adminRecordDegradation(module,reason,fallbackValue,usedFallback){ 
            emit ModuleCoordination("RecordEvent",_coreModuleAddr,true,"ok");
        } catch { 
            revert ModuleCallFailed("Core","adminRecordDegradation"); 
        }
        
        // 2. 存储到存储模块
        DegradationStorage.DegradationEvent memory evt = DegradationStorage.DegradationEvent({
            module:module,
            reasonHash:keccak256(bytes(reason)),
            fallbackValue:fallbackValue,
            usedFallback:usedFallback,
            timestamp:block.timestamp,
            blockNumber:block.number
        });
        try DegradationStorage(_storageModuleAddr).addEventToCircularBuffer(evt){ 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,true,"ok");
        } catch { 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,false,"fail");
        }        
        
        // 3. 更新分析模块
        try IDegradationAnalytics(_analyticsModuleAddr).updateModuleDegradationCount(module){ 
            emit ModuleCoordination("Analytics",_analyticsModuleAddr,true,"ok");
        } catch { 
            emit ModuleCoordination("Analytics",_analyticsModuleAddr,false,"fail");
        }    
    }

    /**
     * @notice 业务模块直接上报降级事件（例如 PriceOracle）
     * @dev 调用者必须是注册表登记的相应模块地址（本函数限定为 PriceOracle）
     * @param reason 降级原因描述
     * @param fallbackValue 降级时使用的备用值
     * @param usedFallback 是否使用了降级策略
     * @custom:security 只有注册的PriceOracle模块可以调用
     * @custom:architecture 事件驱动架构：支持业务模块直接上报，无需管理员权限
     */
    function recordDegradationEventFromPriceOracle(
        string calldata reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external onlyValidRegistry onlyRegisteredModule(ModuleKeys.KEY_PRICE_ORACLE) {
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        if(_storageModuleAddr==address(0)) revert ModuleNotInitialized("Storage");
        if(_analyticsModuleAddr==address(0)) revert ModuleNotInitialized("Analytics");
        
        address module = msg.sender; // 已由修饰器保证为注册的 PriceOracle
        
        // 1. 记录到核心模块
        try DegradationCore(_coreModuleAddr).adminRecordDegradation(module, reason, fallbackValue, usedFallback){ 
            emit ModuleCoordination("RecordEvent",_coreModuleAddr,true,"ok");
        } catch { 
            revert ModuleCallFailed("Core","adminRecordDegradation"); 
        }
        
        // 2. 存储到存储模块
        DegradationStorage.DegradationEvent memory evt = DegradationStorage.DegradationEvent({
            module:module,
            reasonHash:keccak256(bytes(reason)),
            fallbackValue:fallbackValue,
            usedFallback:usedFallback,
            timestamp:block.timestamp,
            blockNumber:block.number
        });
        try DegradationStorage(_storageModuleAddr).addEventToCircularBuffer(evt){ 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,true,"ok");
        } catch { 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,false,"fail");
        }        
        
        // 3. 更新分析模块
        try IDegradationAnalytics(_analyticsModuleAddr).updateModuleDegradationCount(module){ 
            emit ModuleCoordination("Analytics",_analyticsModuleAddr,true,"ok");
        } catch { 
            emit ModuleCoordination("Analytics",_analyticsModuleAddr,false,"fail");
        }    
    }

    /**
     * @notice 获取循环缓冲区统计信息
     * @dev 委托调用到存储模块获取缓冲区统计
     * @return 缓冲区统计信息（总容量、实际数量、是否满、是否为空）
     * @custom:security 只有系统健康查看者可以访问
     */
    function getCircularBufferStats() external view onlyValidRegistry onlySystemHealthViewer returns(uint256,uint256,uint256,bool){
        if(_storageModuleAddr==address(0)) revert ModuleNotInitialized("Storage");
        return DegradationStorage(_storageModuleAddr).getCircularBufferStats(); 
    }

    // ============ Compatibility helpers for legacy SystemView ============
    /**
     * @notice 获取系统降级历史记录
     * @dev 向后兼容接口，用于旧版SystemView
     * @param limit 获取记录数量限制
     * @return history 降级事件历史记录数组
     */
    function getSystemDegradationHistory(uint256 limit) external view returns (DegradationStorage.DegradationEvent[] memory history){
        if(_storageModuleAddr==address(0) || limit==0){ 
            return new DegradationStorage.DegradationEvent[](0); 
        }
        ( ,uint256 actualCount,,) = DegradationStorage(_storageModuleAddr).getCircularBufferStats();
        uint256 count = limit > actualCount ? actualCount : limit;
        history = new DegradationStorage.DegradationEvent[](count);
        for(uint256 i=0;i<count;i++){
            try DegradationStorage(_storageModuleAddr).getEventFromCircularBuffer(i) returns (DegradationStorage.DegradationEvent memory evt){ 
                history[i]=evt; 
            } catch { 
                // 忽略单个事件获取失败
            }
        }
    }

    /**
     * @notice 检查模块健康状态
     * @dev 委托调用到健康监控模块
     * @param module 要检查的模块地址
     * @return isHealthy 模块是否健康
     * @return details 健康状态详情
     */
    function checkModuleHealth(address module) external view returns(bool isHealthy,string memory details){
        if(_healthModuleAddr==address(0)) return (false,"Health monitor not set");
        return ModuleHealthView(_healthModuleAddr).checkModuleHealth(module);
    }

    /**
     * @notice 获取系统降级趋势
     * @dev 委托调用到分析模块
     * @return totalEvents 总事件数
     * @return recentEvents 最近事件数
     * @return mostFrequentModule 最频繁降级的模块
     * @return averageFallbackValue 平均降级值
     */
    function getSystemDegradationTrends() external view returns(uint256 totalEvents,uint256 recentEvents,address mostFrequentModule,uint256 averageFallbackValue){
        if(_analyticsModuleAddr==address(0)) return (0,0,address(0),0);
        return IDegradationAnalytics(_analyticsModuleAddr).getSystemDegradationTrends();
    }

    /**
     * @notice 获取模块健康状态详情
     * @dev 委托调用到健康监控模块
     * @param module 要检查的模块地址
     * @return 模块健康状态结构体
     * @custom:security 只有系统健康查看者可以访问
     */
    function getModuleHealthStatus(address module) external view onlyValidRegistry onlySystemHealthViewer returns (ModuleHealthView.ModuleHealthStatus memory){
        if(_healthModuleAddr==address(0)) revert ModuleNotInitialized("Health");
        return ModuleHealthView(_healthModuleAddr).getModuleHealthStatus(module);
    }

    // ============ Sub-module management ============
    /**
     * @notice 更新子模块地址
     * @dev 管理员功能，用于更新各个子模块的地址
     * @param moduleType 模块类型（Core/Storage/Health/Analytics/Admin）
     * @param newAddr 新模块地址
     * @custom:security 只有管理员可以调用
     */
    function updateSubModule(string memory moduleType,address newAddr) external onlyValidRegistry onlyAdmin {
        require(newAddr!=address(0),"zero");
        bytes32 h = keccak256(bytes(moduleType));
        address old;
        if(h==keccak256("Core")){ 
            old=_coreModuleAddr; 
            _coreModuleAddr=newAddr; 
        }
        else if(h==keccak256("Storage")){ 
            old=_storageModuleAddr; 
            _storageModuleAddr=newAddr; 
        }
        else if(h==keccak256("Health")){ 
            old=_healthModuleAddr; 
            _healthModuleAddr=newAddr; 
        }
        else if(h==keccak256("Analytics")){ 
            old=_analyticsModuleAddr; 
            _analyticsModuleAddr=newAddr; 
        }
        else if(h==keccak256("Admin")){ 
            old=_adminModuleAddr; 
            _adminModuleAddr=newAddr; 
        }
        else revert("invalid moduleType");
        emit SubModuleUpdated(moduleType,old,newAddr);
    }

    // ============ Upgrade control ============
    /**
     * @notice 获取升级管理员地址
     * @return 升级管理员地址
     */
    function getUpgradeAdmin() external view returns(address){ 
        return _upgradeAdmin; 
    }
    
    /**
     * @notice 设置升级管理员地址
     * @param newAdmin 新升级管理员地址
     * @custom:security 只有当前升级管理员或系统管理员可以调用
     */
    function setUpgradeAdmin(address newAdmin) external onlyValidRegistry { 
        if(newAdmin==address(0)) revert InvalidUpgradeAdmin(); 
        if(msg.sender!=_upgradeAdmin && !_hasRole(ActionKeys.ACTION_ADMIN,msg.sender)) 
            revert UpgradeNotAuthorized(msg.sender,_upgradeAdmin); 
        address old=_upgradeAdmin; 
        _upgradeAdmin=newAdmin; 
        emit UpgradeAdminChanged(old,newAdmin);
    }    
    
    /**
     * @notice 启用升级窗口
     * @dev 启用24小时的升级窗口期
     * @custom:security 只有管理员可以调用
     */
    function enableUpgradeWindow() external onlyValidRegistry onlyAdmin { 
        _upgradeEnabled=true; 
        _upgradeEnabledUntil=block.timestamp+UPGRADE_WINDOW; 
        emit UpgradeWindowChanged(true,_upgradeEnabledUntil,msg.sender);
    }    
    
    /**
     * @notice 禁用升级窗口
     * @dev 立即禁用升级窗口
     * @custom:security 只有管理员可以调用
     */
    function disableUpgradeWindow() external onlyValidRegistry onlyAdmin { 
        _upgradeEnabled=false; 
        _upgradeEnabledUntil=0; 
        emit UpgradeWindowChanged(false,0,msg.sender);
    }    
    
    /**
     * @notice 获取升级窗口状态
     * @return 升级窗口是否启用
     * @return 升级窗口启用截止时间
     * @return 升级窗口是否有效（启用且未过期）
     */
    function getUpgradeWindowStatus() external view returns(bool,uint256,bool){ 
        return (_upgradeEnabled,_upgradeEnabledUntil, _upgradeEnabled && block.timestamp<=_upgradeEnabledUntil); 
    }

    /**
     * @notice 升级授权函数
     * @param newImpl 新实现地址
     * @dev 验证升级权限和窗口状态
     * @custom:security 严格的升级权限控制
     */
    function _authorizeUpgrade(address newImpl) internal view override {
        if(msg.sender!=_upgradeAdmin) revert UpgradeNotAuthorized(msg.sender,_upgradeAdmin);
        if(!_upgradeEnabled) revert UpgradeWindowNotOpen();
        if(block.timestamp>_upgradeEnabledUntil) revert UpgradeWindowExpired();
        if(newImpl==address(0)) revert ZeroImplementationAddress();
        uint256 size; 
        assembly{ 
            size := extcodesize(newImpl) 
        } 
        if(size==0) revert NotAContract(newImpl);
    }
    
    // ============ Compatibility interfaces ============
    /**
     * @notice 兼容接口：读取Registry地址
     * @return Registry合约地址
     */
    function registryAddr() external view returns(address){ 
        return _registryAddr; 
    }
    
    /**
     * @notice 兼容接口：读取核心模块地址
     * @return 核心模块地址
     */
    function coreModuleAddr() external view returns(address){ 
        return _coreModuleAddr; 
    }
    
    /**
     * @notice 兼容接口：读取存储模块地址
     * @return 存储模块地址
     */
    function storageModuleAddr() external view returns(address){ 
        return _storageModuleAddr; 
    }
    
    /**
     * @notice 兼容接口：读取健康监控模块地址
     * @return 健康监控模块地址
     */
    function healthModuleAddr() external view returns(address){ 
        return _healthModuleAddr; 
    }
    
    /**
     * @notice 兼容接口：读取分析模块地址
     * @return 分析模块地址
     */
    function analyticsModuleAddr() external view returns(address){ 
        return _analyticsModuleAddr; 
    }
    
    /**
     * @notice 兼容接口：读取管理模块地址
     * @return 管理模块地址
     */
    function adminModuleAddr() external view returns(address){ 
        return _adminModuleAddr; 
    }

    // ============ Storage gap ============
    /// @notice 存储间隙，用于未来升级
    uint256[50] private __gap;
}
