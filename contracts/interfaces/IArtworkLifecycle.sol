// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IArtworkLifecycle
 * @notice Cross-contract surface the AICA Governance contract uses to apply approved proposals:
 *         policy overwrites (Policy Update) and terminal asset revocation (Emergency Revocation).
 */
interface IArtworkLifecycle {
    /// @notice Overwrite the active validation policy (autonomous policy application, WP2 §3.3.5).
    function setPolicy(uint256 minDeclaredValue, bytes32[] calldata disallowedCompounds) external;

    /// @notice Automatically freeze an asset on a TPC fraud notification. Callable only by governance.
    function governanceFreeze(string calldata assetId) external;

    /// @notice Push an asset to the terminal REVOKED state. Callable only by the governance contract.
    function governanceRevoke(string calldata assetId) external;

    /// @notice Current legal title holder of an asset (used to apply the fraud strike).
    function ownerOf(string calldata assetId) external view returns (address);
}
