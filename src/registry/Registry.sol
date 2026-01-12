// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IRegistry} from "../interfaces/IRegistry.sol";
import {IRegistryStorageMigrator} from "../interfaces/IRegistryStorageMigrator.sol";
import {
    IndexOutOfBounds,
    ModuleAlreadyExists,
    ModuleCapExceeded,
    ModuleUpgradeNotFound,
    ModuleUpgradeNotReady,
    NotAContract
} from "../errors/StandardErrors.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {RegistryStorage} from "./RegistryStorageLibrary.sol";
import {RegistryEvents} from "./RegistryEventsLibrary.sol";
import {RegistryQuery} from "./RegistryQueryLibrary.sol";
import {RegistryCompatQuery} from "./RegistryCompatQueryLibrary.sol";
import {RegistryCore} from "./RegistryCore.sol";
import {RegistryUpgradeManager} from "./RegistryUpgradeManager.sol";
import {RegistryAdmin} from "./RegistryAdmin.sol";

/// @title Registry
/// @notice Lightweight module address registry entrypoint.
/// @dev Serves as a unified entrypoint and delegates to specialized modules.
/// @dev Keeps backward compatibility while reducing contract size.
/// @dev Only routes + enforces permissions; contains no protocol business logic.
contract Registry is 
    IRegistry,
    Initializable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable
{
    // ============ Custom Errors ============
    /// @notice Caller is not authorized to upgrade.
    error NotUpgradeAdmin(address caller);
    /// @notice Provided delay is above the maximum.
    error DelayTooLong(uint256 provided, uint256 max);
    /// @notice Provided delay is invalid (e.g. zero).
    error InvalidDelayValue(uint256 delay);
    /// @notice Module is not configured (compat path).
    error ModuleNotSet(string moduleName);
    /// @notice Caller is not the pending admin.
    error NotPendingAdmin(address caller, address pendingAdmin);
    /// @notice Pending admin is invalid.
    error InvalidPendingAdmin(address pendingAdmin);
    /// @notice Caller is not authorized as emergency admin.
    error EmergencyAdminNotAuthorized(address caller, address emergencyAdmin);
    /// @notice Zero address is not allowed.
    error ZeroAddress();
    /// @notice Upgrade admin is invalid (zero address).
    error InvalidUpgradeAdmin(address newAdmin);
    /// @notice Invalid parameter (tests/compat only).
    error InvalidParameter(string reason);
    /// @notice Array lengths mismatch in batch operation.
    error MismatchedArrayLengths(uint256 keysLength, uint256 addressesLength);
    /// @notice Migrator must be a contract (no EOA / no empty code).
    error MigratorNotContract(address migrator);
    /// @notice Storage version mismatch.
    error StorageVersionMismatch(uint256 expected, uint256 actual);
    /// @notice Invalid migration target (must be strictly increasing).
    error InvalidMigrationTarget(uint256 fromVersion, uint256 toVersion);
    /// @notice Migrator execution failed.
    error MigratorFailed(address migrator, bytes reason);

    // ============ Constants ============
    /// @notice Maximum delay window (7 days).
    uint256 private constant _MAX_DELAY = 7 days;
    /// @notice Upgrade history ring size cap (must match RegistryQueryLibrary).
    uint256 private constant _MAX_UPGRADE_HISTORY = 100;
    /// @notice Batch size cap (tests/safety).
    uint256 private constant _MAX_BATCH_SIZE = 50;

    // ============ Upgrade Admin ============
    /// @notice Upgrade admin address.
    address private _upgradeAdmin;
    /// @notice Emergency admin address.
    address private _emergencyAdmin;

    // ============ Module contract addresses ============
    /// @notice Core module (private storage reference).
    RegistryCore private _registryCore;
    /// @notice Upgrade manager module (private storage reference).
    RegistryUpgradeManager private _upgradeManager;
    /// @notice Governance/admin module (private storage reference).
    RegistryAdmin private _registryAdmin;
    /// @notice Dynamic module key registry address.
    address private _dynamicModuleKeyRegistry;

    // ============ Constructor ============
    /// @notice Constructor disables initializers.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice Initialize the Registry contract.
    /// @param _minDelay Minimum delay window (seconds).
    /// @dev Initializes core state variables and privilege settings.
    /// @param upgradeAdmin_ Upgrade admin address.
    /// @param emergencyAdmin_ Emergency admin address.
    function initialize(uint256 _minDelay, address upgradeAdmin_, address emergencyAdmin_, address initialOwner)
        external
        initializer
    {
        if (_minDelay > _MAX_DELAY) revert DelayTooLong(_minDelay, _MAX_DELAY);
        if (upgradeAdmin_ == address(0)) revert ZeroAddress();
        if (emergencyAdmin_ == address(0)) revert ZeroAddress();
        if (initialOwner == address(0)) revert ZeroAddress();
        
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        
        RegistryStorage.initializeStorageVersion();
        
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        // Governance/admin (compat) should follow the explicit initial owner, not the initializer caller.
        layout.admin = initialOwner;
        layout.pendingAdmin = address(0);
        layout.minDelay = uint64(_minDelay);
        
        _upgradeAdmin = upgradeAdmin_;
        _emergencyAdmin = emergencyAdmin_;
        
        emit RegistryEvents.RegistryInitialized(
            msg.sender,
            _minDelay,
            upgradeAdmin_
        );
    }

    // ============ UUPS Upgrade Authorization ============
    /// @notice UUPS upgrade authorization.
    /// @param newImplementation New implementation address.
    /// @dev Only upgradeAdmin, emergencyAdmin, or owner can upgrade.
    function _authorizeUpgrade(address newImplementation) internal override {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
        if (msg.sender == _upgradeAdmin || msg.sender == _emergencyAdmin || msg.sender == owner()) {
            emit RegistryEvents.ModuleUpgradeAuthorized(
                msg.sender,
                newImplementation
            );
            return;
        }
        revert NotUpgradeAdmin(msg.sender);
    }

    // ============ Module wiring ============
    /// @notice Set the core module address.
    /// @param registryCoreAddr Core module address.
    /// @dev Only owner can set module addresses.
    function setRegistryCore(address registryCoreAddr) external onlyOwner {
        if (registryCoreAddr == address(0)) revert ZeroAddress();
        if (registryCoreAddr.code.length == 0) revert NotAContract(registryCoreAddr);
        
        // Optional: validate required interfaces if needed.
        
        _registryCore = RegistryCore(registryCoreAddr);
        emit RegistryEvents.ModuleChanged(bytes32("RegistryCore"), address(0), registryCoreAddr);
    }

    /// @notice Set the upgrade manager module address.
    /// @param upgradeManagerAddr Upgrade manager module address.
    /// @dev Only owner can set module addresses.
    function setUpgradeManager(address upgradeManagerAddr) external onlyOwner {
        if (upgradeManagerAddr == address(0)) revert ZeroAddress();
        if (upgradeManagerAddr.code.length == 0) revert NotAContract(upgradeManagerAddr);
        
        // Optional: validate required interfaces if needed.
        
        _upgradeManager = RegistryUpgradeManager(upgradeManagerAddr);
        emit RegistryEvents.ModuleChanged(bytes32("RegistryUpgradeManager"), address(0), upgradeManagerAddr);
        // Best-effort init to bind the Registry address (ignore failure/already-initialized).
        bool initialized = false;
        try _upgradeManager.initialize(address(this), owner()) {
            initialized = true;
        } catch (bytes memory) {
            initialized = false;
        }
        if (!initialized) {
            // no-op (best-effort init)
            initialized = initialized;
        }
    }

    /// @notice Set the governance/admin module address.
    /// @param registryAdminAddr Governance/admin module address.
    /// @dev Only owner can set module addresses.
    function setRegistryAdmin(address registryAdminAddr) external onlyOwner {
        if (registryAdminAddr == address(0)) revert ZeroAddress();
        if (registryAdminAddr.code.length == 0) revert NotAContract(registryAdminAddr);
        
        // Optional: validate required interfaces if needed.
        
        _registryAdmin = RegistryAdmin(registryAdminAddr);
        emit RegistryEvents.ModuleChanged(bytes32("RegistryAdmin"), address(0), registryAdminAddr);
    }

    /// @notice Set the dynamic module key registry address.
    /// @param dynamicModuleKeyRegistryAddr Dynamic module key registry address.
    /// @dev Only owner can set module addresses.
    function setDynamicModuleKeyRegistry(address dynamicModuleKeyRegistryAddr) external onlyOwner {
        if (dynamicModuleKeyRegistryAddr != address(0) && dynamicModuleKeyRegistryAddr.code.length == 0) {
            revert NotAContract(dynamicModuleKeyRegistryAddr);
        }
        
        address oldAddr = _dynamicModuleKeyRegistry;
        _dynamicModuleKeyRegistry = dynamicModuleKeyRegistryAddr;
        emit RegistryEvents.ModuleChanged(bytes32("DynamicModuleKeyRegistry"), oldAddr, dynamicModuleKeyRegistryAddr);
    }

    // ============ Interface overrides ============
    /// @notice Get owner address (IRegistry override).
    /// @return Owner address.
    function owner() public view override(IRegistry, OwnableUpgradeable) returns (address) {
        return super.owner();
    }

    /// @notice Transfer ownership (IRegistry override).
    /// @param newOwner New owner address.
    function transferOwnership(address newOwner) public override(IRegistry, OwnableUpgradeable) onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newOwner == address(0)) revert ZeroAddress();
        RegistryStorage.Layout storage layout = RegistryStorage.layout();

        address oldAdmin = owner();
        address oldPending = layout.pendingAdmin;

        super.transferOwnership(newOwner);
        layout.admin = newOwner;

        if (oldPending != address(0)) {
            layout.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, newOwner);
    }

    /// @notice Renounce ownership (governance admin).
    /// @dev Keeps RegistryStorage.admin/pendingAdmin consistent with Ownable owner.
    function renounceOwnership() public override(OwnableUpgradeable) onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();

        address oldAdmin = owner();
        address oldPending = layout.pendingAdmin;

        super.renounceOwnership();
        layout.admin = address(0);

        if (oldPending != address(0)) {
            layout.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, address(0));
    }

    // ============ Read-only queries (via RegistryQuery) ============
    /// @notice Get module address.
    /// @param key Module key.
    /// @return Module address (zero if not set).
    function getModule(bytes32 key) external view override returns (address) {
        return RegistryQuery.getModule(key);
    }

    /// @notice Get module address or revert if not registered.
    /// @param key Module key.
    /// @return Module address.
    function getModuleOrRevert(bytes32 key) external view override returns (address) {
        return RegistryQuery.getModuleOrRevert(key);
    }

    /// @notice Check whether a module is registered.
    /// @param key Module key.
    /// @return True if registered.
    function isModuleRegistered(bytes32 key) external view override returns (bool) {
        return RegistryQuery.isModuleRegistered(key);
    }

    /// @notice Get current minimum delay window.
    /// @return Minimum delay window (seconds).
    function minDelay() external view override returns (uint256) {
        return RegistryStorage.layout().minDelay;
    }

    // ============ Upgrade admin management ============
    /// @notice Set upgrade admin.
    /// @param newAdmin New upgrade admin address.
    /// @dev Only owner can set.
    function setUpgradeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert InvalidUpgradeAdmin(newAdmin);
        address oldAdmin = _upgradeAdmin;
        _upgradeAdmin = newAdmin;
        emit RegistryEvents.UpgradeAdminChanged(oldAdmin, newAdmin);
    }

    /// @notice Set emergency admin.
    /// @param newAdmin New emergency admin address.
    /// @dev Only owner can set.
    function setEmergencyAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = _emergencyAdmin;
        _emergencyAdmin = newAdmin;
        emit RegistryEvents.EmergencyAdminChanged(oldAdmin, newAdmin);
    }

    /// @notice Get upgrade admin address.
    /// @return Upgrade admin address.
    function getUpgradeAdmin() external view returns (address) {
        return _upgradeAdmin;
    }

    /// @notice Get emergency admin address.
    /// @return Emergency admin address.
    function getEmergencyAdmin() external view returns (address) {
        return _emergencyAdmin;
    }

    /// @notice Get dynamic module key registry address.
    /// @return Dynamic module key registry address.
    function getDynamicModuleKeyRegistry() external view returns (address) {
        return _dynamicModuleKeyRegistry;
    }

    // ============ Governance (compat) ============
    /// @notice Get governance admin address.
    /// @return Governance admin address.
    function getAdmin() external view override returns (address) {
        return owner();
    }

    /// @notice Get pending admin address.
    /// @return Pending admin address.
    function getPendingAdmin() external view override returns (address) {
        return RegistryStorage.layout().pendingAdmin;
    }

    /// @notice Check paused status.
    /// @return True if paused.
    function isPaused() external view override returns (bool) {
        return paused();
    }

    /// @notice Set governance admin (ownership).
    /// @param newAdmin New governance admin address.
    /// @dev Only owner can set.
    function setAdmin(address newAdmin) external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = owner();
        _transferOwnership(newAdmin);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address oldPending = layout.pendingAdmin;
        layout.admin = newAdmin;
        if (oldPending != address(0)) {
            layout.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, newAdmin);
    }

    /// @notice Set pending admin address.
    /// @param newPendingAdmin New pending admin address.
    /// @dev Only owner can set.
    function setPendingAdmin(address newPendingAdmin) external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address oldPending = layout.pendingAdmin;
        layout.pendingAdmin = newPendingAdmin;
        emit RegistryEvents.PendingAdminChanged(oldPending, newPendingAdmin);
    }

    /// @notice Accept governance admin transfer.
    /// @dev Only pending admin can call.
    function acceptAdmin() external override {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        if (msg.sender != layout.pendingAdmin) revert NotPendingAdmin(msg.sender, layout.pendingAdmin);
        if (layout.pendingAdmin == address(0)) revert InvalidPendingAdmin(layout.pendingAdmin);
        
        address oldAdmin = owner();
        address oldPending = layout.pendingAdmin;
        _transferOwnership(msg.sender);
        layout.admin = msg.sender;
        layout.pendingAdmin = address(0);
        emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        emit RegistryEvents.AdminChanged(oldAdmin, msg.sender);
    }

    /// @notice Pause the Registry.
    /// @dev Only owner or emergency admin can pause.
    function pause() external override {
        if (msg.sender != owner() && msg.sender != _emergencyAdmin) {
            revert EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _pause();
        RegistryStorage.layout().paused = 1;
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.PAUSE),
            msg.sender,
            // Timestamp is emitted for off-chain auditing; not used for business decisions.
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    /// @notice Unpause the Registry.
    /// @dev Only owner can unpause.
    function unpause() external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _unpause();
        RegistryStorage.layout().paused = 0;
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.UNPAUSE),
            msg.sender,
            // Timestamp is emitted for off-chain auditing; not used for business decisions.
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    // ============ Module management (writes to RegistryStorage) ============
    /// @notice Set module address.
    function setModule(bytes32 key, address moduleAddr) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _setModuleInternal(key, moduleAddr, true, true);
    }

    /// @notice Set module address (returns changed status).
    function setModuleWithStatus(bytes32 key, address moduleAddr)
        external
        override
        onlyOwner
        whenNotPaused
        returns (bool changed)
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        changed = _setModuleInternal(key, moduleAddr, true, true);
    }

    /// @notice Set module address with allowReplace flag.
    function setModuleWithReplaceFlag(bytes32 key, address moduleAddr, bool _allowReplace)
        external
        override
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _setModuleInternal(key, moduleAddr, _allowReplace, true);
    }

    /// @notice Batch set module addresses (returns changed status).
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses)
        external
        override
        onlyOwner
        whenNotPaused
        returns (uint256 changedCount, bytes32[] memory changedKeys)
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        // Compat: emit batch event (including executor) and record history.
        address[] memory oldAddresses = new address[](keys.length);
        changedKeys = new bytes32[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            oldAddresses[i] = RegistryStorage.layout().modules[keys[i]];
            bool changed = _setModuleInternal(keys[i], addresses[i], true, true);
            if (changed) {
                changedKeys[changedCount] = keys[i];
                changedCount++;
            }
        }
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, addresses, msg.sender);
    }

    /// @notice Compat: batch set modules (with allowReplace flag).
    /// @dev Used by tests; internally reuses setModuleWithReplaceFlag.
    function batchSetModules(bytes32[] calldata keys, address[] calldata addresses, bool allowReplace)
        external
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        for (uint256 i = 0; i < keys.length; i++) {
            _setModuleInternal(keys[i], addresses[i], allowReplace, true);
        }
    }

    /// @notice Batch set module addresses (event control).
    function setModulesWithEvents(bytes32[] calldata keys, address[] calldata addresses, bool /*emitIndividualEvents*/ )
        external
        override
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        for (uint256 i = 0; i < keys.length; i++) {
            _setModuleInternal(keys[i], addresses[i], true, true);
        }
    }

    /// @notice Batch set module addresses.
    function setModules(bytes32[] calldata keys, address[] calldata addresses)
        external
        override
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        for (uint256 i = 0; i < keys.length; i++) {
            _setModuleInternal(keys[i], addresses[i], true, false);
        }
    }

    /// @dev Internal module write; supports allowReplace and per-item event emission.
    function _setModuleInternal(bytes32 key, address moduleAddr, bool allowReplace, bool emitEvent)
        internal
        returns (bool changed)
    {
        if (moduleAddr == address(0)) revert ZeroAddress();

        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address old = layout.modules[key];

        if (!allowReplace && old != address(0) && old != moduleAddr) {
            revert ModuleAlreadyExists(key);
        }

        if (old == moduleAddr) {
            if (emitEvent) {
                emit RegistryEvents.ModuleNoOp(key, old, msg.sender);
            }
            return false;
        }

        layout.modules[key] = moduleAddr;
        if (emitEvent) {
            emit RegistryEvents.ModuleChanged(key, old, moduleAddr);
            // Compat: treat direct setModule as an upgrade and emit ModuleUpgraded.
            emit RegistryEvents.ModuleUpgraded(key, old, moduleAddr, msg.sender);
        }
        // Record upgrade history (write order; 0 is the first change).
        _recordUpgradeHistory(key, old, moduleAddr, msg.sender);
        return true;
    }

    function _recordUpgradeHistory(bytes32 key, address oldAddr, address newAddr, address executor) internal {
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
            oldAddress: oldAddr,
            newAddress: newAddr,
            // Timestamp is stored for off-chain auditing/forensics; not used for business decisions.
            // solhint-disable-next-line not-rely-on-time
            timestamp: block.timestamp,
            executor: executor
        });
        uint256 currentIndex = layout.historyIndex[key];
        uint256 ringIndex = currentIndex % _MAX_UPGRADE_HISTORY;
        if (layout.upgradeHistory[key].length < _MAX_UPGRADE_HISTORY) {
            layout.upgradeHistory[key].push(history);
        } else {
            layout.upgradeHistory[key][ringIndex] = history;
        }
        layout.historyIndex[key] = currentIndex + 1;
        // Timestamp is emitted for off-chain auditing; not used for business decisions.
        // solhint-disable-next-line not-rely-on-time
        emit RegistryEvents.UpgradeHistoryRecorded(key, oldAddr, newAddr, block.timestamp, executor, bytes32(0));
    }

    // ============ Upgrade scheduling/execution ============
    /// @notice Schedule a module upgrade.
    /// @param key Module key.
    /// @param newAddr New module address.
    function scheduleModuleUpgrade(bytes32 key, address newAddr) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newAddr == address(0)) revert ZeroAddress();
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address oldAddress = layout.modules[key];
        // Timelock scheduling relies on block.timestamp by design.
        // solhint-disable-next-line not-rely-on-time
        uint256 executeAfter = block.timestamp + uint256(layout.minDelay);
        layout.pendingUpgrades[key] = RegistryStorage.PendingUpgrade({
            newAddr: newAddr,
            executeAfter: executeAfter,
            proposer: msg.sender,
            minDelaySnapshot: uint256(layout.minDelay)
        });
        emit RegistryEvents.ModuleUpgradeScheduled(key, oldAddress, newAddr, executeAfter, msg.sender);
    }

    /// @notice Cancel a scheduled module upgrade.
    /// @param key Module key.
    /// @dev Only owner or emergency admin can cancel.
    function cancelModuleUpgrade(bytes32 key) external override whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (msg.sender != owner() && msg.sender != _emergencyAdmin) {
            revert EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory p = layout.pendingUpgrades[key];
        if (p.newAddr == address(0)) return;
        address oldAddress = layout.modules[key];
        delete layout.pendingUpgrades[key];
        emit RegistryEvents.ModuleUpgradeCancelled(key, oldAddress, p.newAddr, msg.sender);
    }

    /// @notice Execute a scheduled module upgrade.
    /// @param key Module key.
    function executeModuleUpgrade(bytes32 key) external override onlyOwner whenNotPaused nonReentrant {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory p = layout.pendingUpgrades[key];
        if (p.newAddr == address(0)) revert ModuleUpgradeNotFound(key);
        // Timelock execution relies on block.timestamp by design.
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < p.executeAfter) revert ModuleUpgradeNotReady(key, p.executeAfter, block.timestamp);
        address oldAddress = layout.modules[key];
        address newAddr = p.newAddr;
        layout.modules[key] = newAddr;
        delete layout.pendingUpgrades[key];
        emit RegistryEvents.ModuleUpgraded(key, oldAddress, newAddr, msg.sender);
        _recordUpgradeHistory(key, oldAddress, newAddr, msg.sender);
    }

    /// @notice Emergency admin: cancel all pending upgrades.
    /// @dev Can be called while paused (pause-then-cancel workflow).
    function emergencyCancelAllUpgrades() external {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (msg.sender != _emergencyAdmin) {
            revert EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        bytes32[] memory keys = ModuleKeys.getAllKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            if (layout.pendingUpgrades[keys[i]].newAddr != address(0)) {
                delete layout.pendingUpgrades[keys[i]];
            }
        }
    }

    /// @notice Emergency admin: recover upgrade authority (set upgradeAdmin = emergencyAdmin).
    function emergencyRecoverUpgrade() external {
        if (msg.sender != _emergencyAdmin) {
            revert EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        address oldAdmin = _upgradeAdmin;
        _upgradeAdmin = _emergencyAdmin;
        emit RegistryEvents.UpgradeAdminChanged(oldAdmin, _upgradeAdmin);
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.EMERGENCY_RECOVERY),
            msg.sender,
            // Timestamp is emitted for off-chain auditing; not used for business decisions.
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    // ============ Query helpers ============
    /// @notice Get pending upgrade info.
    /// @param key Module key.
    /// @return newAddr New module address.
    /// @return executeAfter Earliest execution time.
    /// @return hasPendingUpgrade True if upgrade is pending.
    function getPendingUpgrade(bytes32 key) external view override returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    ) {
        RegistryStorage.PendingUpgrade memory p = RegistryStorage.layout().pendingUpgrades[key];
        return (p.newAddr, p.executeAfter, p.newAddr != address(0));
    }

    /// @notice Check whether a module upgrade is ready to execute.
    /// @param key Module key.
    /// @return True if ready.
    function isUpgradeReady(bytes32 key) external view override returns (bool) {
        RegistryStorage.PendingUpgrade memory p = RegistryStorage.layout().pendingUpgrades[key];
        // Timelock readiness check relies on block.timestamp by design.
        // solhint-disable-next-line not-rely-on-time
        return p.newAddr != address(0) && block.timestamp >= p.executeAfter;
    }

    /* ============ Query helpers (tests/compat) ============ */

    function getAllModuleKeys() external pure returns (bytes32[] memory) {
        return ModuleKeys.getAllKeys();
    }

    function getAllRegisteredModuleKeys() external view returns (bytes32[] memory) {
        return RegistryCompatQuery.getAllRegisteredModuleKeys();
    }

    function getAllRegisteredModules() external view returns (bytes32[] memory keys, address[] memory addresses) {
        keys = RegistryCompatQuery.getAllRegisteredModuleKeys();
        addresses = new address[](keys.length);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        for (uint256 i = 0; i < keys.length; i++) {
            addresses[i] = layout.modules[keys[i]];
        }
        return (keys, addresses);
    }

    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory keys, uint256 totalCount)
    {
        return RegistryCompatQuery.getRegisteredModuleKeysPaginated(offset, limit);
    }

    /// @notice Get upgrade history count for a module.
    /// @param key Module key.
    /// @return Upgrade history entry count.
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256) {
        return RegistryStorage.layout().upgradeHistory[key].length;
    }

    /// @notice Get a single upgrade history record.
    /// @param key Module key.
    /// @param index History index.
    /// @return oldAddress Old address.
    /// @return newAddress New address.
    /// @return timestamp Upgrade timestamp.
    /// @return executor Upgrade executor.
    function getUpgradeHistory(bytes32 key, uint256 index) external view returns (
        address oldAddress,
        address newAddress,
        uint256 timestamp,
        address executor
    ) {
        RegistryStorage.UpgradeHistory[] storage history = RegistryStorage.layout().upgradeHistory[key];
        if (index >= history.length) revert IndexOutOfBounds(index, history.length);
        RegistryStorage.UpgradeHistory storage h = history[index];
        return (h.oldAddress, h.newAddress, h.timestamp, h.executor);
    }

    /// @notice Get all upgrade history records for a module.
    /// @param key Module key.
    /// @return Upgrade history records.
    function getAllUpgradeHistory(bytes32 key) external view override returns (IRegistry.UpgradeHistory[] memory) {
        RegistryStorage.UpgradeHistory[] storage history = RegistryStorage.layout().upgradeHistory[key];
        IRegistry.UpgradeHistory[] memory out = new IRegistry.UpgradeHistory[](history.length);
        for (uint256 i = 0; i < history.length; i++) {
            RegistryStorage.UpgradeHistory storage h = history[i];
            out[i] = IRegistry.UpgradeHistory({
                oldAddress: h.oldAddress,
                newAddress: h.newAddress,
                timestamp: h.timestamp,
                executor: h.executor
            });
        }
        return out;
    }

    // ============ Utils ============
    /// @notice Set minimum delay window.
    /// @param newDelay New delay window (seconds).
    /// @dev Only owner can set.
    function setMinDelay(uint256 newDelay) external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newDelay > _MAX_DELAY) revert DelayTooLong(newDelay, _MAX_DELAY);
        if (newDelay == 0) revert InvalidDelayValue(newDelay);
        uint256 oldDelay = RegistryStorage.layout().minDelay;
        RegistryStorage.layout().minDelay = uint64(newDelay);
        emit RegistryEvents.MinDelayChanged(oldDelay, newDelay);
    }

    /// @notice Execute a storage migration via an external migrator (keeps STORAGE_SLOT).
    /// @param fromVersion Expected current storage version.
    /// @param toVersion Target storage version (must be greater than current).
    /// @param migrator Migrator contract address.
    /// @dev Flow:
    ///      1) Validate currentVersion == fromVersion and toVersion is increasing
    ///      2) validateStorageLayout() before migration
    ///      3) delegatecall migrator.migrate(fromVersion,toVersion) (keep slot)
    ///      4) bump storageVersion to toVersion
    ///      5) validateStorageLayout() after migration
    /// @custom:oz-upgrades-unsafe-allow delegatecall
    function migrateStorage(uint256 fromVersion, uint256 toVersion, address migrator) external override onlyOwner {
        if (migrator == address(0)) revert ZeroAddress();
        // Safety: forbid delegatecall to EOA / empty-code address.
        if (migrator.code.length == 0) revert MigratorNotContract(migrator);

        uint256 cur = RegistryStorage.getStorageVersion();
        if (cur != fromVersion) revert StorageVersionMismatch(fromVersion, cur);
        if (toVersion <= cur) revert InvalidMigrationTarget(fromVersion, toVersion);

        // Pre-migration validation (ensure critical fields are intact).
        RegistryStorage.validateStorageLayout();

        // Perform migration (data move/init) via delegatecall; keep STORAGE_SLOT unchanged.
        bytes memory data = abi.encodeWithSelector(IRegistryStorageMigrator.migrate.selector, fromVersion, toVersion);
        // delegatecall is required for storage migration with a fixed STORAGE_SLOT.
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory reason) = migrator.delegatecall(data);
        if (!ok) revert MigratorFailed(migrator, reason);

        // Bump version and run post-migration validation.
        RegistryStorage.upgradeStorageVersion(toVersion);
        RegistryStorage.validateStorageLayout();

        emit RegistryEvents.StorageMigrated(fromVersion, toVersion, migrator);
    }

    /// @notice Upgrade storage version.
    /// @param newVersion New storage version.
    function upgradeStorageVersion(uint256 newVersion) external override onlyOwner {
        RegistryStorage.upgradeStorageVersion(newVersion);
    }

    /// @notice Validate storage layout.
    /// @dev Ensures storage layout integrity.
    function validateStorageLayout() external view override {
        RegistryStorage.validateStorageLayout();
    }

    /// @notice Get maximum delay window.
    /// @return Maximum delay window (seconds).
    // Interface requires MAX_DELAY() (legacy UPPER_SNAKE_CASE naming).
    // solhint-disable-next-line func-name-mixedcase
    function MAX_DELAY() external pure override returns (uint256) {
        return _MAX_DELAY;
    }

    /// @notice Check whether an address is admin.
    /// @param addr Address to check.
    /// @return True if admin.
    function isAdmin(address addr) external view override returns (bool) {
        return RegistryStorage.isAdmin(addr);
    }

    /// @notice Get storage version.
    /// @return Storage version.
    function getStorageVersion() external view override returns (uint256) {
        return RegistryStorage.getStorageVersion();
    }

    /// @notice Check whether Registry is initialized.
    /// @return True if initialized.
    function isInitialized() external view override returns (bool) {
        return RegistryStorage.isInitialized();
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
}
