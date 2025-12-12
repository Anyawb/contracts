// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * 简单的 Mock 合约示例
 * 用于演示 .sol 到 .ts 的生成过程
 */
contract SimpleMock {
    uint256 public counter;
    mapping(address => bool) public authorizedUsers;
    
    event CounterIncremented(address indexed user, uint256 newValue);
    event UserAuthorized(address indexed user, bool authorized);
    
    constructor() {
        counter = 0;
    }
    
    function increment() external {
        require(authorizedUsers[msg.sender], "Not authorized");
        counter++;
        emit CounterIncremented(msg.sender, counter);
    }
    
    function authorizeUser(address user, bool authorized) external {
        authorizedUsers[user] = authorized;
        emit UserAuthorized(user, authorized);
    }
    
    function getCounter() external view returns (uint256) {
        return counter;
    }
    
    function isAuthorized(address user) external view returns (bool) {
        return authorizedUsers[user];
    }
} 