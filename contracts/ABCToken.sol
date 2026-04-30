// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ABCToken — BEP-20 token for BSC Testnet distribution
/// @notice 50,000,000 ABC minted to the deployer at construction.
contract ABCToken is ERC20, Ownable {
    uint256 public constant TOTAL_SUPPLY = 50_000_000 * 10 ** 18;

    constructor() ERC20("ABC", "ABC") Ownable(msg.sender) {
        _mint(msg.sender, TOTAL_SUPPLY);
    }
}
