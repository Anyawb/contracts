// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../registry/Registry.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { NotAContract, ZeroAddress } from "../errors/StandardErrors.sol";

/**
 * @title DegradationStorage
 * @notice Degradation event storage with ring-buffer history and hash-based deduplication.
 * @dev Responsibilities:
 *      - Stores degradation events in a fixed-size circular buffer.
 *      - Deduplicates health detail strings via hash mapping.
 *      - Provides event queries and buffer stats for monitoring.
 *      - Emits standardized events for offchain analytics.
 *
 * Security:
 * - Admin-only writes; health viewers can read.
 * - All entrypoints require a valid Registry reference.
 */
contract DegradationStorage is Initializable, UUPSUpgradeable {
    /*━━━━━━━━━━━━━━━ Registry ━━━━━━━━━━━━━━━*/
    /// @notice Registry address used for module resolution and access control.
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Degradation event record.
     * @dev Stored in the circular buffer.
     * @param module Module address that degraded.
     * @param reasonHash Hash of the degradation reason.
     * @param fallbackValue Fallback value used.
     * @param usedFallback Whether a fallback strategy was used.
     * @param legacyBlockNumber Event block number (block.number, legacy field name).
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

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when an event is added to the circular buffer.
     * @param globalIndex Global event index.
     * @param bufferPosition Buffer slot index.
     * @param module Module address.
     * @param overwrite Whether an older event was overwritten.
     * @param blockNumber Block number (block.number).
     */
    event CircularBufferEventAdded(uint256 indexed globalIndex,uint256 indexed bufferPosition,address indexed module,bool overwrite,uint256 blockNumber);
    
    /**
     * @notice Emitted when buffer statistics are updated.
     * @param currentIndex Current global index.
     * @param actualCount Actual event count.
     * @param maxCapacity Max buffer capacity.
     * @param blockNumber Block number (block.number).
     */
    event CircularBufferStats(uint256 currentIndex,uint256 actualCount,uint256 maxCapacity,uint256 blockNumber);
    
    /**
     * @notice Emitted for storage optimization accounting.
     * @param fieldType Field category label.
     * @param originalSize Original size.
     * @param optimizedSize Optimized size.
     * @param spaceSaved Estimated storage saved.
     * @param blockNumber Block number (block.number).
     */
    event StorageOptimizationStats(string fieldType,uint256 originalSize,uint256 optimizedSize,uint256 spaceSaved,uint256 blockNumber);
    
    /**
     * @notice Emitted when health details are registered.
     * @param detailsHash Details hash.
     * @param details Human-readable details.
     * @param module Module address.
     * @param blockNumber Block number (block.number).
     */
    event HealthDetailsRegistered(bytes32 indexed detailsHash,string details,address indexed module,uint256 blockNumber);

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @notice Max number of degradation events (buffer capacity).
    uint256 private constant MAX_DEGRADATION_EVENTS = 100;
    
    /// @notice Max health details length.
    uint256 private constant MAX_DETAILS_LENGTH    = 128;
    
    /// @notice Min health details length.
    uint256 private constant MIN_DETAILS_LENGTH    = 5;

    /*━━━━━━━━━━━━━━━ Predefined Health Detail Hashes ━━━━━━━━━━━━━━━*/
    /// @notice Predefined health detail hashes (kept in sync with ModuleHealthView).
    bytes32 private constant DETAILS_HEALTHY        = keccak256("Module is healthy");
    bytes32 private constant DETAILS_ZERO_ADDRESS   = keccak256("Module address is zero");
    bytes32 private constant DETAILS_NO_CODE        = keccak256("Module has no code");
    bytes32 private constant DETAILS_FAILED_CHECK   = keccak256("Module failed health check");
    bytes32 private constant DETAILS_TIMEOUT        = keccak256("Health check timeout");
    bytes32 private constant DETAILS_CALL_FAILED    = keccak256("External call failed");
    bytes32 private constant DETAILS_NOT_RESPONDING = keccak256("Module not responding");

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @notice Circular buffer: index => degradation event.
    mapping(uint256 => DegradationEvent) private _circularEvents;
    
    /// @notice Current global event index.
    uint256 private _currentEventIndex;
    
    /// @notice Actual event count (capped by capacity).
    uint256 private _actualEventCount;
    
    /// @notice Hash-to-text mapping for health details (dedup).
    mapping(bytes32 => string) private _detailsHashToText;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
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
     * @notice Check whether a user has a role.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is missing in Registry
     *
     * @param actionKey Action key (see ActionKeys).
     * @param user Address to check.
     * @return True if user has role, otherwise false.
     */
    function _hasRole(bytes32 actionKey,address user) internal view returns(bool){
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acm).hasRole(actionKey,user);
    }
    
    /**
     * @notice Restrict access to system health viewers or admins.
     * @dev Reverts if caller lacks ACTION_ADMIN and ACTION_VIEW_SYSTEM_STATUS.
     */
    modifier onlySystemHealthViewer(){
        // Allow the Registry-registered DegradationMonitor to read storage without granting it viewer roles.
        // Rationale: DegradationMonitor is the coordinator and should be able to query its own submodules.
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon != address(0) && msg.sender == mon) {
            _;
            return;
        }
        require(_hasRole(ActionKeys.ACTION_ADMIN,msg.sender)||_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS,msg.sender),"DegradationStorage: no permission"); 
        _; 
    }
    
    /**
     * @notice Restrict access to admins.
     * @dev Reverts if caller lacks ACTION_ADMIN.
     */
    modifier onlyAdmin(){ 
        require(_hasRole(ActionKeys.ACTION_ADMIN,msg.sender),"DegradationStorage: admin only"); 
        _; 
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /**
     * @notice Constructs the implementation and disables initializers.
     * @dev Prevents direct initialization of the implementation contract.
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(){ 
        _disableInitializers(); 
    }

    /**
     * @notice Initialize the storage module.
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
        if(initialRegistryAddr==address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _initializePredefinedHealthDetails();
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorize UUPS upgrade.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *      - caller lacks ACTION_UPGRADE_MODULE
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation has no code (NotAContract)
     *
     * Security:
     * - Role-gated (ACTION_ADMIN + ACTION_UPGRADE_MODULE)
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
        IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
            .requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

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

    /*━━━━━━━━━━━━━━━ Ring-Buffer Logic ━━━━━━━━━━━━━━━*/
    /**
     * @notice Add an event to the circular buffer.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN AND caller is not Registry[KEY_DEGRADATION_MONITOR]
     *
     * Security:
     * - Role-gated (ACTION_ADMIN) OR DegradationMonitor single-entry (Registry[KEY_DEGRADATION_MONITOR])
     * - Rationale: DegradationMonitor is the write-path coordinator; Storage should accept writes from the
     *   registry-bound monitor without requiring the monitor contract itself to hold ACTION_ADMIN.
     *
     * @param degradationEvent Event to store.
     */
    function addEventToCircularBuffer(DegradationEvent memory degradationEvent) external onlyValidRegistry {
        // Allow DegradationMonitor (Registry-bound) as single-entry coordinator.
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0) || msg.sender != mon) {
            // Fallback: allow direct admin writes (legacy / maintenance).
            IAccessControlManager(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL))
                .requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        }
        uint256 pos = _currentEventIndex % MAX_DEGRADATION_EVENTS;
        bool overwrite = _actualEventCount >= MAX_DEGRADATION_EVENTS;
        _circularEvents[pos] = degradationEvent;
        _currentEventIndex++;
        if(_actualEventCount<MAX_DEGRADATION_EVENTS){ 
            _actualEventCount++; 
        }
        emit CircularBufferEventAdded(_currentEventIndex-1,pos,degradationEvent.module,overwrite,block.number);
    }

    /**
     * @notice Get an event from the circular buffer.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN or ACTION_VIEW_SYSTEM_STATUS
     *      - index is out of bounds (revert string)
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @param index Event index (0 = most recent).
     * @return evt Degradation event record.
     */
    function getEventFromCircularBuffer(uint256 index) external view onlyValidRegistry onlySystemHealthViewer returns(DegradationEvent memory evt){
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
     * @notice Get circular buffer statistics.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN or ACTION_VIEW_SYSTEM_STATUS
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @return currentIndex Current global index.
     * @return actualCount Actual event count.
     * @return maxCapacity Max capacity.
     * @return isFull Whether the buffer is full.
     */
    function getCircularBufferStats() external view onlyValidRegistry onlySystemHealthViewer returns(uint256 currentIndex,uint256 actualCount,uint256 maxCapacity,bool isFull){
        return (_currentEventIndex,_actualEventCount,MAX_DEGRADATION_EVENTS,_actualEventCount>=MAX_DEGRADATION_EVENTS);
    }

    /**
     * @notice Clear the circular buffer.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     */
    function clearCircularBuffer() external onlyValidRegistry onlyAdmin {
        _currentEventIndex=0; 
        _actualEventCount=0;
        emit CircularBufferStats(0,0,MAX_DEGRADATION_EVENTS,block.number);
    }

    /*━━━━━━━━━━━━━━━ Health Detail Helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Initialize predefined health details.
     * @dev Internal helper called during initialization.
     */
    function _initializePredefinedHealthDetails() internal {
        _detailsHashToText[DETAILS_HEALTHY] = "Module is healthy";
        _detailsHashToText[DETAILS_ZERO_ADDRESS] = "Module address is zero";
        _detailsHashToText[DETAILS_NO_CODE] = "Module has no code";
        _detailsHashToText[DETAILS_FAILED_CHECK] = "Module failed health check";
        _detailsHashToText[DETAILS_TIMEOUT] = "Health check timeout";
        _detailsHashToText[DETAILS_CALL_FAILED] = "External call failed";
        _detailsHashToText[DETAILS_NOT_RESPONDING] = "Module not responding";
        emit StorageOptimizationStats("HealthDetails",7*32,7*32,0,block.number);
    }

    /**
     * @notice Register new health details if not already stored.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN
     *
     * Security:
     * - Role-gated (ACTION_ADMIN)
     * - Deduplicates by detailsHash
     *
     * @param detailsHash Details hash.
     * @param details Human-readable details.
     * @param module Module address.
     */
    function registerHealthDetailsIfNew(bytes32 detailsHash,string memory details,address module) external onlyValidRegistry onlyAdmin {
        if(bytes(_detailsHashToText[detailsHash]).length==0){
            _detailsHashToText[detailsHash]=details;
            emit HealthDetailsRegistered(detailsHash,details,module,block.number);
            uint256 saved = bytes(details).length > 32 ? bytes(details).length - 32 : 0;
            emit StorageOptimizationStats("HealthDetails",bytes(details).length,32,saved,block.number);
        }
    }

    /**
     * @notice Get health details by hash.
     * @dev Reverts if:
     *      - registry is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_ADMIN or ACTION_VIEW_SYSTEM_STATUS
     *
     * Security:
     * - View-only
     * - Access gated by onlySystemHealthViewer
     *
     * @param hash Details hash.
     * @return details Details string (empty if not registered).
     */
    function getHealthDetailsByHash(bytes32 hash) external view onlyValidRegistry onlySystemHealthViewer returns(string memory details){ 
        return _detailsHashToText[hash]; 
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    /// @notice Reserved storage gap for upgrades.
    uint256[50] private __gap;
}
