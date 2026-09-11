// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestUSDC — a testnet stand-in for USDC. It has NO monetary value.
/// @notice 6 decimals. The owner can mint; anyone can call `faucet()` once per 24h for 1,000 tUSDC.
contract TestUSDC is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 24 hours;

    mapping(address => uint256) public lastFaucetAt;

    error FaucetCooldown(uint256 availableAt);

    event Faucet(address indexed to, uint256 amount);

    constructor(address initialOwner) ERC20("Test USDC (no value)", "tUSDC") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function faucet() external {
        uint256 at = faucetAvailableAt(msg.sender);
        if (block.timestamp < at) revert FaucetCooldown(at);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit Faucet(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Timestamp at which `who` may next call `faucet()` (0 = never used).
    function faucetAvailableAt(address who) public view returns (uint256) {
        uint256 last = lastFaucetAt[who];
        return last == 0 ? 0 : last + FAUCET_COOLDOWN;
    }
}
