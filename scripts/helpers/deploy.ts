/**
 * Deployment + onboarding helpers shared by the test suite and the end-to-end simulation.
 */
import { ethers } from "hardhat";

// Mirrors IIdentityRegistry.Role
export const Role = {
  NONE: 0,
  ARTIST: 1,
  MIC: 2,
  AICA: 3,
  GALLERY: 4,
  COLLECTOR: 5,
  TPC: 6,
} as const;

// Mirrors ArtworkLifecycle.Status
export const Status = {
  NONE: 0,
  PENDING_VALIDATION: 1,
  CERTIFIED: 2,
  LOCKED_FOR_SALE: 3,
  DELEGATED: 4,
  FROZEN: 5,
  REVOKED: 6,
} as const;

export interface Stack {
  identity: any;
  sbt: any;
  lifecycle: any;
  governance: any;
  mic: any; // signer acting as MIC issuer + infrastructure deployer
}

export interface GovParams {
  commitDuration?: number;
  revealDuration?: number;
  revealReward?: bigint;
}

/**
 * Deploys the full HashCanvas suite and wires the cross-contract authorizations.
 * The MIC signer doubles as the infrastructure deployer (institutional root authority).
 */
export async function deployStack(mic: any, params: GovParams = {}): Promise<Stack> {
  const commitDuration = params.commitDuration ?? 3600;
  const revealDuration = params.revealDuration ?? 3600;
  const revealReward = params.revealReward ?? ethers.parseEther("1");

  const Identity = await ethers.getContractFactory("IdentityRegistry", mic);
  const identity = await Identity.deploy(mic.address);

  const SBT = await ethers.getContractFactory("ReputationSBT", mic);
  const sbt = await SBT.deploy();

  const Lifecycle = await ethers.getContractFactory("ArtworkLifecycle", mic);
  const lifecycle = await Lifecycle.deploy(await identity.getAddress());

  const Gov = await ethers.getContractFactory("AICAGovernance", mic);
  const governance = await Gov.deploy(
    await identity.getAddress(),
    await sbt.getAddress(),
    await lifecycle.getAddress(),
    commitDuration,
    revealDuration,
    revealReward
  );

  // Wiring (all executed by the MIC/deployer authority).
  await (await lifecycle.setGovernance(await governance.getAddress())).wait();
  await (await identity.setStriker(await governance.getAddress(), true)).wait();
  await (await sbt.setMinter(await governance.getAddress(), true)).wait();

  return { identity, sbt, lifecycle, governance, mic };
}

/**
 * Onboards a holder: the MIC signs the Verifiable Credential digest off-chain, then the holder
 * submits the one-time onboarding transaction (Subject-Signer Validation enforced on-chain).
 */
export async function onboard(
  identity: any,
  mic: any,
  holder: any,
  role: number,
  did: string,
  opts: { commitment?: string; expiry?: number } = {}
): Promise<void> {
  const commitment = opts.commitment ?? ethers.keccak256(ethers.toUtf8Bytes(`kyc:${did}`));
  const expiry = opts.expiry ?? (await currentTime()) + 365 * 24 * 3600;

  const digest = await identity.credentialDigest(holder.address, did, role, commitment, expiry);
  const sig = await mic.signMessage(ethers.getBytes(digest));

  await (await identity.connect(holder).onboard(did, role, commitment, expiry, sig)).wait();
}

/** keccak256(abi.encodePacked(support, salt, voter, proposalId)) — matches AICAGovernance.hashVote. */
export function hashVote(
  support: number,
  salt: string,
  voter: string,
  proposalId: bigint | number
): string {
  return ethers.solidityPackedKeccak256(
    ["uint8", "bytes32", "address", "uint256"],
    [support, salt, voter, proposalId]
  );
}

/** keccak256 of a compoundId string — matches the on-chain bytes32 mirror used for policy checks. */
export function compoundHash(compoundId: string): string {
  return ethers.id(compoundId);
}

export async function currentTime(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp;
}
