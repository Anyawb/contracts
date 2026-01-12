// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RWAToken
 * @dev RWA (Real World Asset) Token - ERC20 implementation
 * @notice 用于抵押借贷的 RWA 代币，支持 mint 和 burn 功能
 */
contract RWAToken is ERC20, Ownable {
    
    /**
     * @dev 构造函数
     * @param name_ 代币名称
     * @param symbol_ 代币符号
     */
    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {}
    
    /**
     * @dev 铸造代币
     * @param to 接收地址
     * @param amount 铸造数量
     * @notice 只有 owner 可以调用
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "RWAToken: cannot mint to zero address");
        require(amount > 0, "RWAToken: cannot mint zero amount");
        
        _mint(to, amount);
    }
    
    /**
     * @dev 销毁代币
     * @param from 销毁地址
     * @param amount 销毁数量
     * @notice 只有 owner 可以调用
     */
    function burn(address from, uint256 amount) external onlyOwner {
        require(from != address(0), "RWAToken: cannot burn from zero address");
        require(amount > 0, "RWAToken: cannot burn zero amount");
        require(balanceOf(from) >= amount, "RWAToken: insufficient balance to burn");
        
        _burn(from, amount);
    }
    
    /**
     * @dev 销毁自己的代币
     * @param amount 销毁数量
     */
    function burn(uint256 amount) external {
        require(amount > 0, "RWAToken: cannot burn zero amount");
        require(balanceOf(msg.sender) >= amount, "RWAToken: insufficient balance to burn");
        
        _burn(msg.sender, amount);
    }
} 