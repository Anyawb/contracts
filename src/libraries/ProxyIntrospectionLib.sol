// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ProxyIntrospectionLib
 * @notice Minimal helpers for proxy runtime introspection (no external calls).
 *
 * @dev When called through an ERC1967 proxy via delegatecall, `sload(_IMPLEMENTATION_SLOT)`
 * returns the implementation address stored in the proxy. When called directly on an
 * implementation contract (non-proxy), the slot is usually unset (zero).
 */
library ProxyIntrospectionLib {
    // keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant _IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function getImplementation() internal view returns (address impl) {
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly ("memory-safe") {
            impl := sload(slot)
        }
    }

    function getImplementationOrSelf() internal view returns (address impl) {
        impl = getImplementation();
        if (impl == address(0)) impl = address(this);
    }
}


