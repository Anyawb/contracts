// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IDataPush
/// @notice Unified, gas-efficient data push interface for off-chain monitoring.
/// @dev Any module that needs to stream structured data to off-chain services SHOULD
///      emit the `DataPushed` event instead of bespoke events.  
///      `dataTypeHash` MUST be the keccak256 hash of a short, UPPER_SNAKE_CASE identifier
///      (e.g. "USER_HEALTH", "GLOBAL_STATS").  The `payload` **SHOULD** be ABI-encoded
///      as a struct defined in its respective module contract to keep context.
interface IDataPush {
    /// @notice 通用数据推送事件 – 任意模块均可使用。
    /// @param dataTypeHash keccak256("SOME_TYPE") 常量，用于快速过滤。
    /// @param payload      ABI-encoded bytes payload. Decoding schema由 dataTypeHash 决定。
    event DataPushed(bytes32 indexed dataTypeHash, bytes payload);

    /// @notice 推送数据至链下监听服务。
    /// @dev 仅作约束；实现可选择 internal 函数+emit 事件 或直接 external 调用。
    /// @param dataTypeHash 哈希常量标识
    /// @param payload      ABI 编码数据
    function pushData(bytes32 dataTypeHash, bytes calldata payload) external;
}
