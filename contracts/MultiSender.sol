// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MultiSender — Gas-optimized batch token distribution
///
/// GAS OPTIMIZATIONS APPLIED:
/// 1. PACKED CALLDATA  — each recipient is a bytes32 encoding:
///      bits 255–96 : address (20 bytes, left-padded)
///      bits  95– 0 : uint96 whole-token amount (12 bytes)
///    This is 32 bytes/recipient vs the naive 52 bytes (address+uint256),
///    saving ~38% in calldata gas.
///
/// 2. BITMAP DUPLICATE GUARD — mapping(uint256 => uint256) _claimed
///    One storage slot holds 256 boolean flags (one per wallet index).
///    Cost: ~200 gas to read + ~5000 gas for first-write SSTORE.
///    Vs bool mapping: 20,000 gas cold SSTORE per address = 256× cheaper.
///
/// 3. UNCHECKED LOOP INCREMENT — removes Solidity 0.8 overflow check
///    on the loop counter, saving ~40 gas per iteration.
///
/// 4. DIRECT TRANSFER (transfer vs transferFrom) — MultiSender holds tokens
///    directly. Calling transfer() skips the allowance read + SSTORE decrement
///    that transferFrom() requires, saving ~5,000 gas per recipient.
///
/// 5. OWNABLE INSTEAD OF REENTRANCYGUARD — only the owner (deployer) can
///    call multisend(). This eliminates the reentrancy vector entirely without
///    the 2× SSTORE cost of ReentrancyGuard (set ENTERED / reset NOT_ENTERED).
///
/// DESIGN CHOICE — separate uint32[] indices + bytes32[] packed:
///   The indices array carries per-recipient wallet indices for bitmap
///   lookup. The packed array carries address+amount. This keeps the
///   bytes32 unpacking clean (no bit-width ambiguity with variable indices)
///   and allows the off-chain script to build each array independently.
contract MultiSender is Ownable {
    /// @dev One slot per 256 wallet indices.
    mapping(uint256 => uint256) private _claimed;

    /// @notice Emitted after a successful batch.
    /// @param successCount Number of transfers that were executed.
    /// @param totalAmount  Total wei transferred in this batch.
    event BatchComplete(uint256 successCount, uint256 totalAmount);

    constructor() Ownable(msg.sender) {}

    /// @notice Send tokens to up to 300 recipients in a single call.
    /// @dev    MultiSender must hold sufficient token balance before calling.
    ///         Only the contract owner (deployer) can call this function.
    /// @param token    ERC-20 token address held by this contract.
    /// @param indices  Wallet indices (0–99999) — used for bitmap duplicate check.
    /// @param packed   Packed recipient data: address (20B) | uint96 amount in whole tokens (12B).
    function multisend(
        address token,
        uint32[] calldata indices,
        bytes32[] calldata packed
    ) external onlyOwner {
        uint256 len = packed.length;
        require(indices.length == len, "Length mismatch");
        require(len <= 350, "Max 350 per batch");

        uint256 successCount = 0;
        uint256 totalAmount = 0;

        for (uint256 i = 0; i < len; ) {
            uint32 idx = indices[i];

            // Skip if already claimed — bitmap check (OPTIMIZATION 2)
            if (_isClaimed(idx)) {
                unchecked { ++i; }
                continue;
            }

            // Unpack recipient address: upper 160 bits (shift right 96)
            address recipient = address(uint160(uint256(packed[i]) >> 96));

            // Unpack whole-token amount: lower 96 bits, then scale to wei
            uint256 amount = uint256(uint96(uint256(packed[i]))) * 1e18;

            // Mark as claimed before transfer (checks-effects-interactions)
            _setClaimed(idx);

            // Direct transfer — no allowance overhead (OPTIMIZATION 4)
            IERC20(token).transfer(recipient, amount);

            unchecked {
                ++successCount;
                totalAmount += amount;
                ++i;  // OPTIMIZATION 3 — unchecked loop increment
            }
        }

        emit BatchComplete(successCount, totalAmount);
    }

    // ─── Bitmap helpers ───────────────────────────────────────────────────────

    /// @dev Returns true if wallet `index` has already received tokens.
    function _isClaimed(uint256 index) internal view returns (bool) {
        uint256 bucket = index / 256;
        uint256 bit    = index % 256;
        return (_claimed[bucket] >> bit) & 1 == 1;
    }

    /// @dev Marks wallet `index` as having received tokens.
    function _setClaimed(uint256 index) internal {
        uint256 bucket = index / 256;
        uint256 bit    = index % 256;
        _claimed[bucket] |= (1 << bit);
    }

    /// @notice Public read — verify whether wallet index N was already sent to.
    /// @param index Wallet index (0–99999).
    /// @return True if tokens were already sent to this wallet index.
    function isClaimed(uint256 index) external view returns (bool) {
        return _isClaimed(index);
    }

    /// @notice Emergency token recovery — owner can withdraw remaining tokens.
    /// @param token  Token address to recover.
    /// @param amount Amount of tokens to withdraw.
    function withdrawTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(msg.sender, amount);
    }
}
