// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardTypes } from "../RewardTypes.sol";

/// @title IServiceConfig - 服务配置模块接口
/// @notice 定义服务配置模块的标准接口
/// @dev 所有服务配置子模块都应实现此接口
interface IServiceConfig {
    
    /// @notice 获取服务配置
    /// @param level 服务等级
    /// @return config 服务配置
    function getConfig(RewardTypes.ServiceLevel level) external view returns (RewardTypes.ServiceConfig memory config);
    
    /// @notice 更新服务配置
    /// @param level 服务等级
    /// @param price 价格
    /// @param duration 持续时间
    /// @param isActive 是否激活
    function updateConfig(
        RewardTypes.ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external;
    
    /// @notice 获取服务冷却期
    /// @return cooldown 冷却期 (秒)
    function getCooldown() external view returns (uint256 cooldown);
    
    /// @notice 设置服务冷却期
    /// @param cooldown 冷却期 (秒)
    function setCooldown(uint256 cooldown) external;
    
    /// @notice 获取服务类型
    /// @return serviceType 服务类型
    function getServiceType() external pure returns (RewardTypes.ServiceType serviceType);
} 