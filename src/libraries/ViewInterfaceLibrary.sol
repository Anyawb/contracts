// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EventLibrary } from "./EventLibrary.sol";
import { ModuleAccessLibrary } from "./ModuleAccessLibrary.sol";
import { Registry } from "../registry/Registry.sol";

/// @title ViewInterfaceLibrary
/// @notice 统一的View接口库
/// @dev 提供标准的View函数模板，避免重复代码
/// @custom:security-contact security@example.com
library ViewInterfaceLibrary {
    
    /// @notice 用户历史记录结构体
    struct UserHistory {
        bytes32 operationType;
        address asset;
        uint256 amount;
        uint256 timestamp;
        bytes32 moduleKey;
        bytes additionalData;
    }
    
    /// @notice 用户位置结构体
    struct UserPosition {
        address user;
        address asset;
        uint256 collateral;
        uint256 debt;
        uint256 healthFactor;
        uint256 timestamp;
    }
    
    /// @notice 系统状态结构体
    struct SystemStatus {
        address asset;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 utilizationRate;
        uint256 timestamp;
    }
    
    /// @notice 标准用户位置查询
    /// @param registryAddr Registry合约地址
    /// @param userViewKey 用户View模块键
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param caller 调用者地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    function getUserPosition(
        address registryAddr,
        bytes32 userViewKey,
        address user,
        address asset,
        address caller
    ) internal returns (uint256 collateral, uint256 debt) {
        address userViewAddr = ModuleAccessLibrary.getModule(registryAddr, userViewKey, caller);
        
        (bool success, bytes memory data) = userViewAddr.staticcall(
            abi.encodeWithSignature("getUserPosition(address,address)", user, asset)
        );
        require(success, "ViewInterface: call failed");
        
        // 发出查询事件
        emit EventLibrary.UserDataQueried(
            user,
            asset,
            EventLibrary.QUERY_POSITION,
            block.timestamp,
            caller
        );
        
        return abi.decode(data, (uint256, uint256));
    }
    
    /// @notice 标准批量用户位置查询
    /// @param registryAddr Registry合约地址
    /// @param userViewKey 用户View模块键
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @param caller 调用者地址
    /// @return positions 用户位置数组
    function batchGetUserPositions(
        address registryAddr,
        bytes32 userViewKey,
        address[] memory users,
        address[] memory assets,
        address caller
    ) internal returns (UserPosition[] memory positions) {
        require(users.length == assets.length, "ViewInterface: array length mismatch");
        
        address userViewAddr = ModuleAccessLibrary.getModule(registryAddr, userViewKey, caller);
        
        (bool success, bytes memory data) = userViewAddr.staticcall(
            abi.encodeWithSignature("batchGetUserPositions(address[],address[])", users, assets)
        );
        require(success, "ViewInterface: batch call failed");
        
        // 发出批量查询事件
        for (uint256 i = 0; i < users.length; i++) {
            emit EventLibrary.UserDataQueried(
                users[i],
                assets[i],
                EventLibrary.QUERY_POSITION,
                block.timestamp,
                caller
            );
        }
        
        return abi.decode(data, (UserPosition[]));
    }
    
    /// @notice 标准系统状态查询
    /// @param registryAddr Registry合约地址
    /// @param systemViewKey 系统View模块键
    /// @param asset 资产地址
    /// @param caller 调用者地址
    /// @return totalCollateral 总抵押数量
    /// @return totalDebt 总债务数量
    function getSystemStatus(
        address registryAddr,
        bytes32 systemViewKey,
        address asset,
        address caller
    ) internal returns (uint256 totalCollateral, uint256 totalDebt) {
        address systemViewAddr = ModuleAccessLibrary.getModule(registryAddr, systemViewKey, caller);
        
        (bool success, bytes memory data) = systemViewAddr.staticcall(
            abi.encodeWithSignature("getSystemStatus(address)", asset)
        );
        require(success, "ViewInterface: system call failed");
        
        // 发出系统查询事件
        emit EventLibrary.UserDataQueried(
            address(0), // 系统查询，用户地址为0
            asset,
            EventLibrary.QUERY_SYSTEM_STATUS,
            block.timestamp,
            caller
        );
        
        return abi.decode(data, (uint256, uint256));
    }
    
    /// @notice 只读解析模块地址（不发事件，适用于 view 上下文）
    /// @param registryAddr Registry合约地址
    /// @param moduleKey 模块键
    /// @return 模块地址（不存在将直接回滚）
    function resolveModuleView(address registryAddr, bytes32 moduleKey) internal view returns (address) {
        return Registry(registryAddr).getModuleOrRevert(moduleKey);
    }
}
