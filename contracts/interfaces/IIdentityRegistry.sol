// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IIdentityRegistry
 * @notice Shared view/authorization surface of the SSI Identity Smart Contract Registry.
 *         Other contracts (Lifecycle, Governance) depend only on this thin interface so the
 *         dRBAC checks (WP2 §3.4.1) can be resolved at the EVM runtime layer without external
 *         server dependencies (D.2).
 */
interface IIdentityRegistry {
    /// @dev Organizational role attributes issued by the MIC (WP2 §3.4.1).
    enum Role {
        NONE,
        ARTIST, // E01
        MIC, // E02 (issuer / root)
        AICA, // E03
        GALLERY, // E05
        COLLECTOR, // E04
        TPC // E06
    }

    /// @dev On-chain DID lifecycle status (WP2 §3.2.4).
    enum DidStatus {
        UNREGISTERED,
        ACTIVE,
        REVOKED
    }

    function isActive(address account) external view returns (bool);

    function roleOf(address account) external view returns (Role);

    function hasActiveRole(address account, Role role) external view returns (bool);

    function strikesOf(address account) external view returns (uint8);

    /// @notice Register a validated fraud strike against an actor (3-Strikes Enforcement).
    function registerStrike(address actor, string calldata reason) external;
}
