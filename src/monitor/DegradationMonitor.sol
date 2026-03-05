// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ZeroAddress, NotAContract, UpgradeNotAuthorized } from "../errors/StandardErrors.sol";

// Sub-modules (core & storage now in same folder; others remain under Vault view)
import { DegradationCore } from "./DegradationCore.sol";
import { DegradationStorage } from "./DegradationStorage.sol";
import { ModuleHealthView } from "../Vault/view/modules/ModuleHealthView.sol";
import { ViewConstants } from "../Vault/view/ViewConstants.sol";
// DegradationAnalytics and DegradationAdmin implementations have been removed.
// Provide lightweight interfaces for backward compatibility.

/**
 * @title IDegradationAnalytics
 * @notice Lightweight interface for degradation trend analytics (backward compatibility).
 * @dev Implementations may be removed; used for legacy integrations.
 */
interface IDegradationAnalytics {
    /**
     * @notice Update per-module degradation count.
     * @dev Reverts if:
     *      - (implementation-defined)
     *
     * Security:
     * - Write access is implementation-defined
     *
     * @param module Module address to update.
     */
    function updateModuleDegradationCount(address module) external;
    /**
     * @notice Get system degradation trends.
     * @dev Reverts if:
     *      - (implementation-defined)
     *
     * Security:
     * - View-only
     *
     * @return totalEvents Total event count.
     * @return recentEvents Recent event count.
     * @return mostFrequentModule Most frequently degraded module.
     * @return averageFallbackValue Average fallback value.
     */
    function getSystemDegradationTrends() external view returns (uint256 totalEvents,uint256 recentEvents,address mostFrequentModule,uint256 averageFallbackValue);
}

/**
 * @title IDegradationAdmin
 * @notice Placeholder admin interface for future degradation management.
 * @dev Lightweight interface for backward compatibility.
 */
// solhint-disable-next-line no-empty-blocks
interface IDegradationAdmin {
    // Reserved for future admin operations
}

/**
 * @title DegradationMonitor
 * @notice Coordinator for degradation monitoring submodules.
 * @dev Responsibilities:
 *      - Coordinates core/storage/health/analytics submodules.
 *      - Provides unified degradation event recording.
 *      - Allows business modules (e.g., PriceOracle) to report degradations.
 *      - Manages upgrade windows and access control.
 *      - Emits standardized events for offchain monitoring.
 *
 * Security:
 * - Admin-only event recording (except whitelisted module reports).
 * - Health viewers can read stats.
 * - Upgrade window mechanism limits upgrade timing.
 */
contract DegradationMonitor is Initializable, UUPSUpgradeable {
    /*━━━━━━━━━━━━━━━ Registry / Sub-Module Addresses ━━━━━━━━━━━━━━━*/
    /// @notice Registry address used for module resolution and access control.
    address private _registryAddr;
    
    /// @notice Degradation core module address.
    address private _coreModuleAddr;
    
    /// @notice Degradation storage module address.
    address private _storageModuleAddr;
    
    /// @notice Health monitor module address.
    address private _healthModuleAddr;
    
    /// @notice Degradation analytics module address.
    address private _analyticsModuleAddr;
    
    /// @notice Degradation admin module address.
    address private _adminModuleAddr;

    /*━━━━━━━━━━━━━━━ Upgrade Admin + Window ━━━━━━━━━━━━━━━*/
    /// @notice Upgrade admin address.
    address private _upgradeAdmin;
    
    /// @notice Whether the upgrade window is enabled.
    bool private _upgradeEnabled;
    
    /// @notice Upgrade window end block.
    uint256 private _upgradeEnabledUntil;
    
    /// @notice Upgrade window duration in blocks (explicit blocks, Strategy A).
    /// @dev Must be configured at deployment (initializer) or by governance.
    uint256 private _upgradeWindowBlocks;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when coordinating a submodule operation.
     * @dev `details` is free-form and implementation-defined.
     * @param operation Operation type.
     * @param targetModule Target module address.
     * @param success Whether the operation succeeded.
     * @param details Operation details.
     */
    event ModuleCoordination(string operation,address indexed targetModule,bool success,string details);
    
    /**
     * @notice Emitted when a submodule address is updated.
     * @param moduleType Module type label.
     * @param oldModule Previous module address.
     * @param newModule New module address.
     */
    event SubModuleUpdated(string moduleType,address indexed oldModule,address indexed newModule);
    
    /**
     * @notice Emitted when the upgrade admin changes.
     * @param oldAdmin Previous upgrade admin.
     * @param newAdmin New upgrade admin.
     */
    event UpgradeAdminChanged(address indexed oldAdmin,address indexed newAdmin);
    
    /**
     * @notice Emitted when the upgrade window changes.
     * @param enabled Whether the window is enabled.
     * @param enabledUntil Window end block.
     * @param changedBy Caller that changed the window.
     */
    event UpgradeWindowChanged(bool enabled,uint256 enabledUntil,address indexed changedBy);

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    error UpgradeWindowNotOpen();
    error UpgradeWindowExpired();
    error InvalidUpgradeAdmin();
    error ZeroImplementationAddress();
    error ModuleNotInitialized(string moduleType);
    error ModuleCallFailed(string moduleType,string operation);
    error InvalidUpgradeWindowBlocks(uint256 provided);

    /*━━━━━━━━━━━━━━━ Modifiers & Helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Ensure the Registry address is valid.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - registry has no code (NotAContract)
     */
    modifier onlyValidRegistry(){ 
        if(_registryAddr==address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _; 
    }
    
    /**
     * @notice Require a role via AccessControlManager.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is missing in Registry
     *      - role is not granted to user (via ACM.requireRole)
     *
     * @param role Action key (see ActionKeys).
     * @param user Address to check.
     */
    function _requireRole(bytes32 role,address user) internal view {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(role,user);
    }
    
    /**
     * @notice Check whether a user has a role.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is missing in Registry
     *
     * @param role Action key (see ActionKeys).
     * @param user Address to check.
     * @return True if user has role, otherwise false.
     */
    function _hasRole(bytes32 role,address user) internal view returns(bool){
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acm).hasRole(role,user);
    }
    
    /**
     * @notice Restrict access to system health viewers or admins.
     * @dev Reverts if caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS.
     */
    modifier onlySystemHealthViewer(){ 
        require(_hasRole(ActionKeys.ACTION_ADMIN,msg.sender)||_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS,msg.sender),"DegradationMonitor: no permission"); 
        _; 
    }
    
    /**
     * @notice Restrict access to admins.
     * @dev Reverts if caller lacks ACTION_ADMIN (via ACM.requireRole).
     */
    modifier onlyAdmin(){ 
        _requireRole(ActionKeys.ACTION_ADMIN,msg.sender); 
        _; 
    }
    
    /**
     * @notice Restrict access to a Registry-resolved module.
     * @dev Used to allow business modules (e.g., PriceOracle) to report degradations without admin rights.
     * @param moduleKey Module key (see ModuleKeys).
     */
    modifier onlyRegisteredModule(bytes32 moduleKey){
        address module = Registry(_registryAddr).getModuleOrRevert(moduleKey);
        require(msg.sender == module, "DegradationMonitor: caller is not registered module");
        _;
    }

    /**
     * @notice Constructs the implementation and disables initializers.
     * @dev Prevents direct initialization of the implementation contract.
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(){ 
        _disableInitializers(); 
    }

    /**
     * @notice Initialize the monitor and submodule addresses.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr has no code (NotAContract)
     *      - initialUpgradeAdmin is zero (InvalidUpgradeAdmin)
     *
     * Security:
     * - initializer (callable once)
     *
     * @param initialRegistryAddr Initial Registry address.
     * @param initialUpgradeAdmin Initial upgrade admin address.
     * @param initialCore Initial core module address.
     * @param initialStorage Initial storage module address.
     * @param initialHealth Initial health module address.
     * @param initialAnalytics Initial analytics module address.
     * @param initialAdmin Initial admin module address.
     */
    function initialize(
        address initialRegistryAddr,
        address initialUpgradeAdmin,
        address initialCore,
        address initialStorage,
        address initialHealth,
        address initialAnalytics,
        address initialAdmin,
        uint256 initialUpgradeWindowBlocks
    ) external initializer {
        if(initialRegistryAddr==address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        if(initialUpgradeAdmin==address(0)) revert InvalidUpgradeAdmin();
        if (initialUpgradeWindowBlocks == 0) revert InvalidUpgradeWindowBlocks(initialUpgradeWindowBlocks);
        _registryAddr = initialRegistryAddr;
        _upgradeAdmin = initialUpgradeAdmin;
        _coreModuleAddr = initialCore; 
        _storageModuleAddr = initialStorage; 
        _healthModuleAddr = initialHealth; 
        _analyticsModuleAddr = initialAnalytics; 
        _adminModuleAddr = initialAdmin;
        _upgradeWindowBlocks = initialUpgradeWindowBlocks;
        __UUPSUpgradeable_init();
    }

    /*━━━━━━━━━━━━━━━ View Delegation ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get degradation statistics.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS
     *      - core module is not initialized (ModuleNotInitialized)
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @return stats Degradation statistics.
     */
    function getDegradationStats() external view onlyValidRegistry onlySystemHealthViewer returns (DegradationCore.DegradationStats memory stats){
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        return DegradationCore(_coreModuleAddr).getDegradationStats();
    }
    
    /**
     * @notice Backward-compatible wrapper for legacy SystemView.
     * @dev Reverts if:
     *      - core module is not initialized (ModuleNotInitialized)
     *
     * Security:
     * - View-only
     *
     * @return stats Degradation statistics.
     */
    function getGracefulDegradationStats() external view returns (DegradationCore.DegradationStats memory stats) {
        // No access control for legacy callers; core module is validated here.
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        return DegradationCore(_coreModuleAddr).getDegradationStats();
    }
    
    /**
     * @notice Admin entrypoint to record a degradation event.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *      - any required submodule is not initialized (ModuleNotInitialized)
     *      - core module record reverts (ModuleCallFailed)
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     * - Coordinates core, storage, and analytics submodules
     *
     * @param module Module address that degraded.
     * @param reason Reason string.
     * @param fallbackValue Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
     */
    function recordDegradationEvent(address module,string memory reason,uint256 fallbackValue,bool usedFallback) external onlyValidRegistry onlyAdmin {
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        if(_storageModuleAddr==address(0)) revert ModuleNotInitialized("Storage");
        
        // 1) Record in core module.
        try DegradationCore(_coreModuleAddr).adminRecordDegradation(module,reason,fallbackValue,usedFallback){ 
            emit ModuleCoordination("RecordEvent",_coreModuleAddr,true,"ok");
        } catch { 
            revert ModuleCallFailed("Core","adminRecordDegradation"); 
        }
        
        // 2) Store in storage module.
        DegradationStorage.DegradationEvent memory evt = DegradationStorage.DegradationEvent({
            module:module,
            reasonHash:keccak256(bytes(reason)),
            fallbackValue:fallbackValue,
            usedFallback:usedFallback,
            legacyBlockNumber:block.number,
            blockNumber:block.number
        });
        try DegradationStorage(_storageModuleAddr).addEventToCircularBuffer(evt){ 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,true,"ok");
        } catch { 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,false,"fail");
        }        
        
        // 3) Update analytics module.
        if (_analyticsModuleAddr != address(0) && _analyticsModuleAddr.code.length != 0) {
            try IDegradationAnalytics(_analyticsModuleAddr).updateModuleDegradationCount(module){ 
                emit ModuleCoordination("Analytics",_analyticsModuleAddr,true,"ok");
            } catch { 
                emit ModuleCoordination("Analytics",_analyticsModuleAddr,false,"fail");
            }
        } else {
            emit ModuleCoordination("Analytics",_analyticsModuleAddr,false,"unset");
        }
    }

    /**
     * @notice Record a degradation event from PriceOracle.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller is not the Registry-registered PriceOracle (onlyRegisteredModule)
     *      - any required submodule is not initialized (ModuleNotInitialized)
     *      - core module record reverts (ModuleCallFailed)
     *
     * Security:
     * - Restricted to ModuleKeys.KEY_PRICE_ORACLE
     *
     * @param reason Reason string.
     * @param fallbackValue Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
     */
    function recordDegradationEventFromPriceOracle(
        string calldata reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external onlyValidRegistry onlyRegisteredModule(ModuleKeys.KEY_PRICE_ORACLE) {
        if(_coreModuleAddr==address(0)) revert ModuleNotInitialized("Core");
        if(_storageModuleAddr==address(0)) revert ModuleNotInitialized("Storage");
        
        address module = msg.sender; // Guaranteed by onlyRegisteredModule (PriceOracle).
        
        // 1) Record in core module.
        try DegradationCore(_coreModuleAddr).adminRecordDegradation(module, reason, fallbackValue, usedFallback){ 
            emit ModuleCoordination("RecordEvent",_coreModuleAddr,true,"ok");
        } catch { 
            revert ModuleCallFailed("Core","adminRecordDegradation"); 
        }
        
        // 2) Store in storage module.
        DegradationStorage.DegradationEvent memory evt = DegradationStorage.DegradationEvent({
            module:module,
            reasonHash:keccak256(bytes(reason)),
            fallbackValue:fallbackValue,
            usedFallback:usedFallback,
            legacyBlockNumber:block.number,
            blockNumber:block.number
        });
        try DegradationStorage(_storageModuleAddr).addEventToCircularBuffer(evt){ 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,true,"ok");
        } catch { 
            emit ModuleCoordination("StoreEvent",_storageModuleAddr,false,"fail");
        }        
        
        // 3) Update analytics module.
        if (_analyticsModuleAddr != address(0) && _analyticsModuleAddr.code.length != 0) {
            try IDegradationAnalytics(_analyticsModuleAddr).updateModuleDegradationCount(module){ 
                emit ModuleCoordination("Analytics",_analyticsModuleAddr,true,"ok");
            } catch { 
                emit ModuleCoordination("Analytics",_analyticsModuleAddr,false,"fail");
            }
        } else {
            emit ModuleCoordination("Analytics",_analyticsModuleAddr,false,"unset");
        }
    }

    /**
     * @notice Get circular buffer stats from storage module.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS
     *      - storage module is not initialized (ModuleNotInitialized)
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @return capacity Total capacity.
     * @return actualCount Actual stored count.
     * @return headIndex Head index.
     * @return isFull Whether buffer is full.
     */
    function getCircularBufferStats() external view onlyValidRegistry onlySystemHealthViewer returns(uint256,uint256,uint256,bool){
        if(_storageModuleAddr==address(0)) revert ModuleNotInitialized("Storage");
        return DegradationStorage(_storageModuleAddr).getCircularBufferStats(); 
    }

    /*━━━━━━━━━━━━━━━ Compatibility Helpers (Legacy SystemView) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get system degradation history (legacy).
     * @dev Reverts if:
     *      - (none; best-effort, returns empty array on missing module or zero limit)
     *
     * Security:
     * - View-only
     *
     * @param limit Max records to return.
     * @return history Degradation event history.
     */
    function getSystemDegradationHistory(uint256 limit)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (DegradationStorage.DegradationEvent[] memory history)
    {
        if(_storageModuleAddr==address(0) || limit==0){ 
            return new DegradationStorage.DegradationEvent[](0); 
        }
        uint256 actualCount;
        try DegradationStorage(_storageModuleAddr).getCircularBufferStats() returns (uint256, uint256 ac, uint256, bool) {
            actualCount = ac;
        } catch {
            return new DegradationStorage.DegradationEvent[](0);
        }
        uint256 count = limit > actualCount ? actualCount : limit;
        history = new DegradationStorage.DegradationEvent[](count);
        for(uint256 i=0;i<count;i++){
            try DegradationStorage(_storageModuleAddr).getEventFromCircularBuffer(i) returns (DegradationStorage.DegradationEvent memory evt){ 
                history[i]=evt; 
            } catch { 
                // Ignore individual event retrieval failure.
                uint256 noop = 0;
                noop;
            }
        }
    }

    /**
     * @notice Check health status for a module.
     * @dev Reverts if:
     *      - (none; best-effort, returns false if health module is unset)
     *
     * Security:
     * - View-only
     *
     * @param module Module address to check.
     * @return isHealthy True if healthy, otherwise false.
     * @return details Human-readable details.
     */
    function checkModuleHealth(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns(bool isHealthy,string memory details)
    {
        if(_healthModuleAddr==address(0)) return (false,"Health monitor not set");
        try ModuleHealthView(_healthModuleAddr).checkModuleHealth(module) returns (bool ok, string memory d) {
            return (ok, d);
        } catch {
            return (false, "Health check failed");
        }
    }

    /**
     * @notice Get system degradation trends.
     * @dev Reverts if:
     *      - (none; best-effort fallback when analytics is unset)
     *
     * Security:
     * - View-only
     *
     * @return totalEvents Total event count.
     * @return recentEvents Recent event count.
     * @return mostFrequentModule Most frequently degraded module.
     * @return averageFallbackValue Average fallback value.
     */
    function getSystemDegradationTrends()
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns(uint256 totalEvents,uint256 recentEvents,address mostFrequentModule,uint256 averageFallbackValue)
    {
        // If an analytics module is configured, use it (O(1) read).
        if (_analyticsModuleAddr != address(0) && _analyticsModuleAddr.code.length != 0) {
            return IDegradationAnalytics(_analyticsModuleAddr).getSystemDegradationTrends();
        }

        // Scheme A fallback (no analytics module):
        // - totalEvents / averageFallbackValue: prefer DegradationCore aggregated stats (lifetime) if available.
        // - recentEvents / mostFrequentModule: compute from DegradationStorage ring-buffer (window, up to 100 events).
        uint256 coreTotal = 0;
        uint256 coreAvgFallback = 0;
        if (_coreModuleAddr != address(0) && _coreModuleAddr.code.length != 0) {
            try DegradationCore(_coreModuleAddr).getDegradationStats() returns (DegradationCore.DegradationStats memory s) {
                coreTotal = s.totalDegradations;
                coreAvgFallback = s.averageFallbackValue;
            } catch {
                // ignore
            }
        }

        // Storage window scan (bounded).
        if (_storageModuleAddr == address(0) || _storageModuleAddr.code.length == 0) {
            // No storage available: return core-derived values only.
            return (coreTotal, 0, address(0), coreAvgFallback);
        }

        uint256 actualCount;
        try DegradationStorage(_storageModuleAddr).getCircularBufferStats() returns (uint256, uint256 ac, uint256, bool) {
            actualCount = ac;
        } catch {
            return (coreTotal, 0, address(0), coreAvgFallback);
        }
        if (actualCount == 0) {
            return (coreTotal, 0, address(0), coreAvgFallback);
        }

        // Recent window: use view-layer cache duration as the standard "recent" horizon (block-based, chain-agnostic).
        uint256 recentWindowBlocks = ViewConstants.CACHE_DURATION_BLOCKS;
        uint256 minRecentBlock = block.number > recentWindowBlocks ? (block.number - recentWindowBlocks) : 0;

        address[] memory modules = new address[](actualCount);
        uint256[] memory counts = new uint256[](actualCount);
        uint256 unique = 0;
        uint256 maxCount = 0;
        address maxModule = address(0);
        uint256 sumFallback = 0;

        for (uint256 i = 0; i < actualCount; i++) {
            DegradationStorage.DegradationEvent memory evt;
            try DegradationStorage(_storageModuleAddr).getEventFromCircularBuffer(i) returns (DegradationStorage.DegradationEvent memory e) {
                evt = e;
            } catch {
                continue;
            }

            sumFallback += evt.fallbackValue;
            if (evt.blockNumber >= minRecentBlock) {
                recentEvents += 1;
            }

            // Count frequency per module (bounded by ring-buffer size: <= 100).
            bool found = false;
            for (uint256 j = 0; j < unique; j++) {
                if (modules[j] == evt.module) {
                    uint256 c = counts[j] + 1;
                    counts[j] = c;
                    found = true;
                    if (c > maxCount) {
                        maxCount = c;
                        maxModule = evt.module;
                    }
                    break;
                }
            }
            if (!found) {
                modules[unique] = evt.module;
                counts[unique] = 1;
                unique += 1;
                if (maxCount == 0) {
                    maxCount = 1;
                    maxModule = evt.module;
                }
            }
        }

        // totalEvents: prefer lifetime from core; fallback to storage window count.
        totalEvents = coreTotal != 0 ? coreTotal : actualCount;
        mostFrequentModule = maxModule;
        // averageFallbackValue: prefer lifetime avg from core if available; otherwise use window avg.
        averageFallbackValue = coreAvgFallback != 0 ? coreAvgFallback : (sumFallback / actualCount);
    }

    /**
     * @notice Get module health status details.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS
     *      - health module is not initialized (ModuleNotInitialized)
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @param module Module address to check.
     * @return status Module health status struct.
     */
    function getModuleHealthStatus(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealthView.ModuleHealthStatus memory)
    {
        if (_healthModuleAddr == address(0)) revert ModuleNotInitialized("Health");
        (ModuleHealthView.ModuleHealthStatus memory status,,) =
            ModuleHealthView(_healthModuleAddr).getModuleHealthStatus(module);
        return status;
    }

    /*━━━━━━━━━━━━━━━ Sub-Module Management ━━━━━━━━━━━━━━━*/
    /**
     * @notice Update a submodule address by type.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *      - newAddr is zero (revert string "zero")
     *      - moduleType is invalid (revert string "invalid moduleType")
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     *
     * @param moduleType Module type label (Core/Storage/Health/Analytics/Admin).
     * @param newAddr New module address.
     */
    function updateSubModule(string memory moduleType,address newAddr) external onlyValidRegistry onlyAdmin {
        bytes32 h = keccak256(bytes(moduleType));
        address old;
        if(h==keccak256("Core")){ 
            require(newAddr!=address(0),"zero");
            old=_coreModuleAddr; 
            _coreModuleAddr=newAddr; 
        }
        else if(h==keccak256("Storage")){ 
            require(newAddr!=address(0),"zero");
            old=_storageModuleAddr; 
            _storageModuleAddr=newAddr; 
        }
        else if(h==keccak256("Health")){ 
            require(newAddr!=address(0),"zero");
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

    /*━━━━━━━━━━━━━━━ Upgrade Control ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get the upgrade admin address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return upgradeAdmin Upgrade admin address.
     */
    function getUpgradeAdmin() external view returns(address upgradeAdmin){ 
        return _upgradeAdmin; 
    }
    
    /**
     * @notice Set the upgrade admin address.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - newAdmin is zero (InvalidUpgradeAdmin)
     *      - caller is not current upgrade admin or ACTION_ADMIN (UpgradeNotAuthorized)
     *
     * Security:
     * - Role-gated: upgrade admin or ACTION_ADMIN
     *
     * @param newAdmin New upgrade admin address.
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
     * @notice Enable the upgrade window.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     */
    function enableUpgradeWindow() external onlyValidRegistry onlyAdmin { 
        _upgradeEnabled=true; 
        if (_upgradeWindowBlocks == 0) revert InvalidUpgradeWindowBlocks(_upgradeWindowBlocks);
        _upgradeEnabledUntil=block.number+_upgradeWindowBlocks; 
        emit UpgradeWindowChanged(true,_upgradeEnabledUntil,msg.sender);
    }    
    
    /**
     * @notice Disable the upgrade window.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     */
    function disableUpgradeWindow() external onlyValidRegistry onlyAdmin { 
        _upgradeEnabled=false; 
        _upgradeEnabledUntil=0; 
        emit UpgradeWindowChanged(false,0,msg.sender);
    }    
    
    /**
     * @notice Get upgrade window status.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return enabled Whether the window is enabled.
     * @return enabledUntil Window end block.
     * @return isActive True if enabled and not expired.
     */
    function getUpgradeWindowStatus() external view returns(bool enabled,uint256 enabledUntil,bool isActive){ 
        return (_upgradeEnabled,_upgradeEnabledUntil, _upgradeEnabled && block.number<=_upgradeEnabledUntil); 
    }

    /**
     * @notice Returns the configured upgrade window duration (blocks).
     */
    function getUpgradeWindowBlocks() external view returns (uint256 upgradeWindowBlocks) {
        return _upgradeWindowBlocks;
    }

    /**
     * @notice Updates the upgrade window duration (blocks).
     * @dev Strategy A: explicit blocks configuration; no seconds→blocks conversion in Solidity.
     */
    function setUpgradeWindowBlocks(uint256 newUpgradeWindowBlocks) external onlyValidRegistry onlyAdmin {
        if (newUpgradeWindowBlocks == 0) revert InvalidUpgradeWindowBlocks(newUpgradeWindowBlocks);
        _upgradeWindowBlocks = newUpgradeWindowBlocks;
    }

    /**
     * @notice Authorize UUPS upgrade.
     * @dev Reverts if:
     *      - caller is not upgrade admin (UpgradeNotAuthorized)
     *      - upgrade window is not open (UpgradeWindowNotOpen)
     *      - upgrade window expired (UpgradeWindowExpired)
     *      - newImpl is zero (ZeroImplementationAddress)
     *      - newImpl has no code (NotAContract)
     *
     * Security:
     * - Upgrade admin + time-window gating
     *
     * @param newImpl New implementation address.
     */
    function _authorizeUpgrade(address newImpl) internal view override {
        if(msg.sender!=_upgradeAdmin) revert UpgradeNotAuthorized(msg.sender,_upgradeAdmin);
        if(!_upgradeEnabled) revert UpgradeWindowNotOpen();
        if(block.number>_upgradeEnabledUntil) revert UpgradeWindowExpired();
        if(newImpl==address(0)) revert ZeroImplementationAddress();
        uint256 size; 
        assembly{ 
            size := extcodesize(newImpl) 
        } 
        if(size==0) revert NotAContract(newImpl);
    }
    
    /*━━━━━━━━━━━━━━━ Compatibility Interfaces ━━━━━━━━━━━━━━━*/
    /**
     * @notice Compatibility getter for Registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return registry Registry address.
     */
    function registryAddr() external view returns(address registry){ 
        return _registryAddr; 
    }
    
    /**
     * @notice Compatibility getter for core module address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return core Core module address.
     */
    function coreModuleAddr() external view returns(address core){ 
        return _coreModuleAddr; 
    }
    
    /**
     * @notice Compatibility getter for storage module address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return storageAddr Storage module address.
     */
    function storageModuleAddr() external view returns(address storageAddr){ 
        return _storageModuleAddr; 
    }
    
    /**
     * @notice Compatibility getter for health module address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return health Health module address.
     */
    function healthModuleAddr() external view returns(address health){ 
        return _healthModuleAddr; 
    }
    
    /**
     * @notice Compatibility getter for analytics module address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return analytics Analytics module address.
     */
    function analyticsModuleAddr() external view returns(address analytics){ 
        return _analyticsModuleAddr; 
    }
    
    /**
     * @notice Compatibility getter for admin module address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return adminAddr Admin module address.
     */
    function adminModuleAddr() external view returns(address adminAddr){ 
        return _adminModuleAddr; 
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    /// @notice Reserved storage gap for upgrades.
    uint256[50] private __gap;
}
