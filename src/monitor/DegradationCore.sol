// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

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
 * @notice System degradation monitor core for event logging and statistics.
 * @dev Responsibilities:
 *      - Records degradation events (e.g., oracle failures, abnormal prices).
 *      - Maintains aggregated statistics (counts, last time, last reason).
 *      - Emits standardized events for offchain monitoring and analytics.
 *      - Supports graceful-degradation observability.
 *
 * Security:
 * - Admin-only writes; health viewers can read.
 * - All entrypoints require a valid Registry reference.
 */
contract DegradationCore is Initializable, UUPSUpgradeable {
    error DegradationCoreNoPermission();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @notice Registry address used for module resolution and access control.
    address private _registryAddr;

    /**
     * @notice System degradation statistics.
     * @dev Stored as a summary for fast queries.
     * @param totalDegradations Total degradation count.
     * @param lastDegradationBlock Last degradation block number (block.number).
     * @param lastDegradedModule Last degraded module address.
     * @param lastDegradationReasonHash Hash of the last degradation reason.
     * @param fallbackValueUsed Last fallback value used.
     * @param totalFallbackValue Cumulative fallback value sum.
     * @param averageFallbackValue Average fallback value.
     */
    struct DegradationStats {
        uint256 totalDegradations;
        uint256 lastDegradationBlock;
        address lastDegradedModule;
        bytes32 lastDegradationReasonHash;
        uint256 fallbackValueUsed;
        uint256 totalFallbackValue;
        uint256 averageFallbackValue;
    }

    /**
     * @notice Degradation event record.
     * @dev Used for internal bookkeeping; events are emitted separately.
     * @param module Module address that degraded.
     * @param reasonHash Hash of the degradation reason.
     * @param fallbackValue Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
    * @param legacyBlockNumber Event block number (block.number).
     * @param blockNumber Event block number.
     */
    struct DegradationEvent {
        address module;
        bytes32 reasonHash;
        uint256 fallbackValue;
        bool    usedFallback;
        uint256 legacyBlockNumber;
        uint256 blockNumber;
    }

    /// @notice Cached system degradation statistics.
    DegradationStats private _stats;

    /// @notice Mapping from reason hash to human-readable text.
    mapping(bytes32 => string) private _reasonHashToText;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when a degradation event is detected.
     * @dev Intended for offchain monitoring and analytics.
     * @param module Module address that degraded.
     * @param reason Human-readable reason.
     * @param fallbackValue Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
     * @param blockNumber Event block number (block.number).
     */
    event DegradationDetected(address indexed module, string reason, uint256 fallbackValue, bool usedFallback, uint256 blockNumber);
    
    /**
     * @notice Emitted when degradation statistics are updated.
     * @dev Supports real-time monitoring.
     * @param total Total degradation count.
     * @param lastBlock Last degradation block number.
     * @param lastModule Last degraded module address.
     * @param blockNumber Update block number.
     */
    event DegradationStatsUpdated(uint256 total,uint256 lastBlock,address lastModule,uint256 blockNumber);
    
    /**
     * @notice Emitted when a new degradation reason is registered.
     * @param reasonHash Reason hash.
     * @param reason Human-readable reason.
     * @param blockNumber Registration block number.
     */
    event DegradationReasonRegistered(bytes32 indexed reasonHash,string reason,uint256 blockNumber);

    /*━━━━━━━━━━━━━━━ Modifiers / Helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Ensure the Registry address is valid.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - registry has no code (NotAContract)
     */
    modifier onlyValidRegistry() { 
        if (_registryAddr==address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _; 
    }
    
    /**
     * @notice Restrict access to system health viewers or admins.
     * @dev Reverts if caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS.
     */
    modifier onlySystemHealthViewer() {
        // Allow the Registry-registered DegradationMonitor to read core stats without granting it viewer roles.
        // Rationale: DegradationMonitor is the coordinator and should be able to query its own submodules.
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon != address(0) && msg.sender == mon) {
            _;
            return;
        }
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        bool isAllowed =
            IAccessControlManager(acm).hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
                || IAccessControlManager(acm).hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender);
        if (!isAllowed) revert DegradationCoreNoPermission();
        _; 
    }
    
    /**
     * @notice Restrict access to admins.
     * @dev Reverts if caller lacks ACTION_ADMIN (via ACM.requireRole).
     */
    modifier onlyAdmin() {
        IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
            .requireRole(ActionKeys.ACTION_ADMIN,msg.sender); 
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
     * @notice Initialize the module.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr has no code (NotAContract)
     *
     * Security:
     * - initializer (callable once)
     *
     * @param initialRegistryAddr Initial Registry address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr=initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorize UUPS upgrade to a new implementation.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN (via ACM.requireRole)
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation has no code (NotAContract)
     *
     * Security:
     * - Role-gated (ACTION_ADMIN + ACTION_UPGRADE_MODULE)
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
        // onlyAdmin already ensures ACTION_ADMIN; additionally require upgrade role for stricter control.
        IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
            .requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ External View ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get system degradation statistics.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS (MissingRole)
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @return stats Degradation statistics.
     */
    function getDegradationStats() external view onlyValidRegistry onlySystemHealthViewer returns (DegradationStats memory stats){
        return _stats;
    }
    
    /**
     * @notice Get a degradation reason string by hash.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS (MissingRole)
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @param reasonHash Reason hash.
     * @return reason Reason string (empty if not registered).
     */
    function getReasonText(bytes32 reasonHash) external view onlyValidRegistry onlySystemHealthViewer returns (string memory reason){
        return _reasonHashToText[reasonHash];
    }

    /*━━━━━━━━━━━━━━━ Internal Logic ━━━━━━━━━━━━━━━*/
    /**
     * @notice Register a degradation reason if new.
     * @dev Emits {DegradationReasonRegistered} on first registration.
     * @param hash Reason hash.
     * @param reason Reason string.
     */
    function _registerReason(bytes32 hash,string memory reason) internal {
        if(bytes(_reasonHashToText[hash]).length==0){ 
            _reasonHashToText[hash]=reason; 
            emit DegradationReasonRegistered(hash,reason,block.number);
        } 
    }

    /**
     * @notice Record a degradation event and update statistics.
     * @dev Emits {DegradationDetected} and {DegradationStatsUpdated}.
     * @param module Module address that degraded.
     * @param reason Reason string.
     * @param fallbackVal Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
     */
    function _recordEvent(address module,string memory reason,uint256 fallbackVal,bool usedFallback) internal {
        bytes32 hash=keccak256(bytes(reason));
        _registerReason(hash,reason);
        
        // Update aggregated stats.
        _stats.totalDegradations++; 
        _stats.lastDegradationBlock=block.number; 
        _stats.lastDegradedModule=module; 
        _stats.lastDegradationReasonHash=hash; 
        _stats.fallbackValueUsed=fallbackVal; 
        _stats.totalFallbackValue+=fallbackVal;
        _stats.averageFallbackValue=_stats.totalDegradations>0? _stats.totalFallbackValue/_stats.totalDegradations:0;
        
        // Emit events for offchain monitoring.
        emit DegradationDetected(module,reason,fallbackVal,usedFallback,block.number);
        emit DegradationStatsUpdated(_stats.totalDegradations,_stats.lastDegradationBlock,module,block.number);
    }

    /*━━━━━━━━━━━━━━━ Administrative ━━━━━━━━━━━━━━━*/
    /**
     * @notice Admin entrypoint to record a degradation event.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN (via ACM.requireRole) AND caller is not Registry[KEY_DEGRADATION_MONITOR]
     *
     * Security:
     * - Role-gated (ACTION_ADMIN) OR DegradationMonitor single-entry (Registry[KEY_DEGRADATION_MONITOR])
     * - Rationale: DegradationMonitor is the write-path coordinator; Core should accept writes from the
     *   registry-bound monitor without requiring the monitor contract itself to hold ACTION_ADMIN.
     *
     * @param module Module address that degraded.
     * @param reason Reason string.
     * @param fallbackVal Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
     */
    function adminRecordDegradation(address module,string calldata reason,uint256 fallbackVal,bool usedFallback) external onlyValidRegistry {
        // Allow DegradationMonitor (Registry-bound) as single-entry coordinator.
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0) || msg.sender != mon) {
            // Fallback: allow direct admin writes (legacy / maintenance).
            IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
                .requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        }
        _recordEvent(module,reason,fallbackVal,usedFallback);
    }
}
