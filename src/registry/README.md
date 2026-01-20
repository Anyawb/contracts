# Registry module (`src/registry/`)

This folder contains the **canonical on-chain Registry system** for module address management, governance handover (compat), timelocked upgrades, storage versioning, and related utilities.

It is designed to align with the **Architecture-Guide "unified event library + strict NatSpec + SSOT entrypoints"** principle.

---

## What this module is responsible for

- **Module address registry (SSOT)**: `bytes32 moduleKey -> address moduleAddress`.
- **Governance entrypoint** (owner-gated): setting module addresses, configuring admins, pausing/unpausing.
- **Timelocked module upgrades**: schedule / cancel / execute upgrade flows with a minimum delay window.
- **Upgrade history**: an on-chain ring buffer for recent upgrade history per module key (bounded).
- **Storage versioning & migrations**: a fixed `STORAGE_SLOT` layout with explicit storage version markers and migrator support.
- **A-class cache refresh orchestration**: best-effort module-address cache refresh entrypoint (`CacheMaintenanceManager`).

Non-goals (by design):
- Heavy enumeration / pagination for production frontends (kept as compat/test helpers; prefer dedicated View modules).
- Business state writes (Registry is not a business ledger).

---

## Files and roles

### `Registry.sol` (primary entrypoint)

The **canonical entrypoint** for:
- Governance/admin operations (owner-gated).
- Module address writes.
- Timelock scheduling/execution/cancellation.
- Pause/unpause emergency actions.
- Storage migration entrypoints.

Notes:
- Uses `OwnableUpgradeable` with explicit `initialize(..., initialOwner)` (`__Ownable_init(initialOwner)`).
- Uses `PausableUpgradeable` and emits `RegistryEvents.EmergencyActionExecuted(...)` for pause/unpause.
- Enforces a compat gate where relevant: `RegistryStorage.requireCompatibleVersion(...)`.

### `RegistryEventsLibrary.sol` (canonical events SSOT)

`library RegistryEvents` is the **single canonical definition** for Registry-family events.  
All Registry-related contracts should **emit** via:

```solidity
emit RegistryEvents.SomeEvent(...);
```

This avoids duplicate event declarations across contracts and keeps off-chain consumers consistent.

### `RegistryStorageLibrary.sol` (diamond storage / fixed slot)

`library RegistryStorage` defines:
- Fixed `STORAGE_SLOT` layout for Registry state.
- `storageVersion` marker and helper guards.
- Helper functions for initialization and version bumping.

This is the **SSOT for storage layout**. `Registry.sol` and related libraries read/write through it.

### `RegistryQueryLibrary.sol` (minimal read helpers)

`library RegistryQuery` provides minimal read-only helpers:
- `getModule`
- `getModuleOrRevert`
- `isModuleRegistered`

### `RegistryCompatQueryLibrary.sol` (compat enumeration helpers)

Compatibility helpers that:
- Enumerate registered keys by scanning `ModuleKeys.getAllKeys()`.
- Provide pagination on top of that enumeration.

These are intentionally **O(N)** and primarily for tests/compat tooling.  
Production-grade enumeration should be done in dedicated View modules.

### `RegistryDynamicModuleKey.sol` (optional integration: dynamic keys)

An optional module that allows registering/unregistering **dynamic module keys** on-chain, with role-gated admin controls.

Events are emitted via `RegistryEvents` (canonical event library).

### `CacheMaintenanceManager.sol` (A-class cache refresh entrypoint)

Governance-gated, best-effort batch refresh for contracts that implement `ICacheRefreshable.refreshModuleCache()`.

Important design choice:
- It emits **local audit events** (`CacheRefreshAttempted`, `CacheRefreshBatchCompleted`) because they are specific to this maintenance entrypoint and are referenced by operational docs/tooling.
- This does **not** violate the "Registry canonical event library" rule for Registry core events; it keeps domain-specific audit events scoped to the maintenance module.

---

## Interfaces (external contracts depend on these)

The primary external interface is:
- `src/interfaces/IRegistry.sol`

Related interfaces include:
- `src/interfaces/IRegistryStorageMigrator.sol` (for migration delegatecall targets)
- `src/interfaces/ICacheRefreshable.sol` (cache refresh targets)
- Optional dynamic key interface: `src/interfaces/IRegistryDynamicModuleKey.sol`

Interfaces are documented with the Architecture-Guide NatSpec template:
- `@notice`
- `@dev Reverts if:`
- `Security:`

---

## Event policy (SSOT)

- **Core Registry-family events**: defined in `RegistryEventsLibrary.sol` only; emitted as `RegistryEvents.Xxx(...)`.
- **Module-specific audit events** (e.g., cache maintenance): may be defined locally when the event is:
  - operational/maintenance scoped,
  - not part of the Registry core event surface,
  - referenced by dedicated scripts/docs that expect the emitting contract.

---

## Error policy

- Prefer custom errors (`Contract__ErrorName(...)`) and shared `StandardErrors`.
- Avoid `require(...)` / `revert("string")`.

---

## Testing & verification

Typical verification commands:

```bash
pnpm -s run compile
pnpm -s exec solhint "src/registry/*.sol"
pnpm -s exec hardhat test test/Registry*.test.ts
```

---

## Architecture-Guide alignment status

This module is **strongly aligned** with the Architecture-Guide principles:
- SSOT entrypoints (`Registry.sol` for module address writes/upgrades; `CacheMaintenanceManager` for A-class cache refresh).
- Canonical event library for Registry core events (`RegistryEventsLibrary.sol`).
- Strict NatSpec format on external/public entrypoints.
- Custom errors / `StandardErrors` instead of string reverts.

Remaining caveat (important):
- "Perfect alignment" depends on the scope you mean. The code in `src/registry/` is aligned; however, the architecture guide also governs **how other modules consume Registry** (e.g., cache refresh patterns, view modules, scripts). Those are outside this folder.

