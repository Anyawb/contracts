// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { EventLibrary } from "./EventLibrary.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";

/// @title ModuleAccessLibrary
/// @notice 统一的模块访问库
/// @dev 提供所有合约都需要的基础模块访问功能
/// @dev 避免重复代码，统一事件发出
/// @custom:security-contact security@example.com
library ModuleAccessLibrary {
    
    /// @notice 从Registry获取模块地址并发出事件
    /// @param registryAddr Registry合约地址
    /// @param moduleKey 模块键
    /// @param caller 调用者地址
    /// @return 模块地址
    function getModule(
        address registryAddr,
        bytes32 moduleKey,
        address caller
    ) internal returns (address) {
        if (registryAddr == address(0)) revert ZeroAddress();
        
        address moduleAddress = Registry(registryAddr).getModuleOrRevert(moduleKey);
        
        // 发出模块访问事件
        emit EventLibrary.ModuleAccessed(
            moduleKey,
            moduleAddress,
            caller,
            block.timestamp,
            EventLibrary.OPERATION_QUERY,
            ""
        );
        
        return moduleAddress;
    }
    
    /// @notice 安全获取模块地址（带异常处理）
    /// @param registryAddr Registry合约地址
    /// @param moduleKey 模块键
    /// @param caller 调用者地址
    /// @return 模块地址，如果失败返回零地址
    function safeGetModule(
        address registryAddr,
        bytes32 moduleKey,
        address caller
    ) internal returns (address) {
        if (registryAddr == address(0)) return address(0);
        
        try Registry(registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddress) {
            // 发出模块访问事件
            emit EventLibrary.ModuleAccessed(
                moduleKey,
                moduleAddress,
                caller,
                block.timestamp,
                EventLibrary.OPERATION_QUERY,
                ""
            );
            
            return moduleAddress;
        } catch {
            // 发出模块调用失败事件
            emit EventLibrary.ModuleCallFailure(
                moduleKey,
                "Registry call failed",
                true,
                block.timestamp
            );
            
            return address(0);
        }
    }
    
    /// @notice 验证模块地址有效性
    /// @param moduleAddr 模块地址
    /// @param moduleName 模块名称
    function validateModuleAddress(address moduleAddr, string memory moduleName) internal pure {
        if (moduleAddr == address(0)) {
            revert(string(abi.encodePacked("Invalid ", moduleName, " address: zero address")));
        }
    }
}
