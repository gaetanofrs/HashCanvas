// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReputationSBT
 * @notice Non-transferable Soulbound Token mapping AICA critic voting weight / reputation
 *         (WP2 §3.3.2). It is a modified ERC-20 where `transfer`, `transferFrom`, `approve`
 *         and allowance flows are entirely deactivated. This mathematically isolates governance
 *         from speculative vote-buying and economic flash-loan attacks: weight can only be earned
 *         on-chain (minted on successful reveal) and never moved.
 */
contract ReputationSBT is ERC20 {
    address public immutable owner; // bootstrap authority (deployer)
    mapping(address => bool) public isMinter; // governance contract(s) allowed to mint rewards

    error Soulbound(); // transfers are permanently disabled
    error NotOwner();
    error NotMinter();

    event MinterUpdated(address indexed minter, bool allowed);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() ERC20("HashCanvas Reputation", "REP") {
        owner = msg.sender;
        isMinter[msg.sender] = true; // owner may seed initial reputation
        emit MinterUpdated(msg.sender, true);
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    /// @notice Mint reputation. Used for initial seeding (owner) and synchronous reveal rewards
    ///         (governance, WP2 §3.3.5).
    function mint(address to, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }

    // --- Soulbound enforcement -------------------------------------------------------------------

    function approve(address, uint256) public pure override returns (bool) {
        revert Soulbound();
    }

    function transfer(address, uint256) public pure override returns (bool) {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert Soulbound();
    }

    /// @dev Only mint (from == 0) and burn (to == 0) are permitted; any wallet-to-wallet move reverts.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert Soulbound();
        super._update(from, to, value);
    }
}
