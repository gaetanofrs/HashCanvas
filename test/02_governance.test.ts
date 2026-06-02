import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployStack, onboard, hashVote, compoundHash, Role, Status } from "../scripts/helpers/deploy";

const FOR = 1;
const AGAINST = 2;
const COMMIT = 1000;
const REVEAL = 1000;

async function setupGovernance() {
  const signers = await ethers.getSigners();
  const [mic, c1, c2, c3] = signers;
  const stack = await deployStack(mic, {
    commitDuration: COMMIT,
    revealDuration: REVEAL,
    revealReward: ethers.parseEther("1"),
  });
  const { governance, sbt } = stack;

  // Whitelist 3 critics and seed reputation weights (meritocratic resolution input).
  for (const c of [c1, c2, c3]) await governance.setCritic(c.address, true);
  await sbt.mint(c1.address, ethers.parseEther("10"));
  await sbt.mint(c2.address, ethers.parseEther("5"));
  await sbt.mint(c3.address, ethers.parseEther("3"));

  return { ...stack, critics: [c1, c2, c3] };
}

const salt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("AICAGovernance — Commit-Reveal, hybrid quorum & cross-contract execution", () => {
  it("runs a Policy Update via commit-reveal and applies it to the Lifecycle", async () => {
    const { governance, lifecycle, critics } = await setupGovernance();
    const [c1, c2, c3] = critics;

    const disallowed = [compoundHash("Lead_White_PW1")];
    const id = await governance.connect(c1).proposePolicyUpdate.staticCall(1000, disallowed);
    await governance.connect(c1).proposePolicyUpdate(1000, disallowed);

    // Commit phase — all three blind-commit FOR.
    for (const c of critics) {
      await governance.connect(c).commitVote(id, hashVote(FOR, salt(c.address), c.address, id));
    }

    await time.increase(COMMIT + 1); // → REVEAL
    for (const c of critics) {
      await governance.connect(c).revealVote(id, FOR, salt(c.address));
    }

    await time.increase(REVEAL + 1); // → CLOSED
    await governance.execute(id);

    expect(await lifecycle.policyMinDeclaredValue()).to.equal(1000);
    expect(await lifecycle.policyVersion()).to.equal(1);
    expect(await lifecycle.disallowedCompound(disallowed[0])).to.equal(true);
  });

  it("reverts reveals attempted during the commit window (blind voting enforced)", async () => {
    const { governance, critics } = await setupGovernance();
    const [c1] = critics;
    await governance.connect(c1).proposePolicyUpdate(1, []);
    const id = await governance.proposalCount();

    await governance.connect(c1).commitVote(id, hashVote(FOR, salt("x"), c1.address, id));
    await expect(
      governance.connect(c1).revealVote(id, FOR, salt("x"))
    ).to.be.revertedWithCustomError(governance, "WrongPhase");
  });

  it("rejects a reveal whose (support,salt) does not match the commit", async () => {
    const { governance, critics } = await setupGovernance();
    const [c1] = critics;
    await governance.connect(c1).proposePolicyUpdate(1, []);
    const id = await governance.proposalCount();

    await governance.connect(c1).commitVote(id, hashVote(FOR, salt("real"), c1.address, id));
    await time.increase(COMMIT + 1);
    await expect(
      governance.connect(c1).revealVote(id, FOR, salt("wrong"))
    ).to.be.revertedWithCustomError(governance, "BadReveal");
  });

  it("fails execution when the 51% heads-based quorum is not reached", async () => {
    const { governance, critics } = await setupGovernance();
    const [c1] = critics; // only 1 of 3 reveals → 33% < 51%
    await governance.connect(c1).proposePolicyUpdate(777, []);
    const id = await governance.proposalCount();

    await governance.connect(c1).commitVote(id, hashVote(FOR, salt("a"), c1.address, id));
    await time.increase(COMMIT + 1);
    await governance.connect(c1).revealVote(id, FOR, salt("a"));
    await time.increase(REVEAL + 1);

    expect(await governance.quorumReached(id)).to.equal(false);
    await expect(governance.execute(id)).to.be.revertedWithCustomError(governance, "QuorumNotReached");
  });

  it("mints synchronous reputation rewards only to critics who reveal", async () => {
    const { governance, sbt, critics } = await setupGovernance();
    const [c1, c2, c3] = critics;
    await governance.connect(c1).proposePolicyUpdate(1, []);
    const id = await governance.proposalCount();

    for (const c of critics) {
      await governance.connect(c).commitVote(id, hashVote(FOR, salt(c.address), c.address, id));
    }
    await time.increase(COMMIT + 1);
    const before = await sbt.balanceOf(c3.address);
    // c1 and c2 reveal; c3 abstains from revealing.
    await governance.connect(c1).revealVote(id, FOR, salt(c1.address));
    await governance.connect(c2).revealVote(id, FOR, salt(c2.address));

    expect(await sbt.balanceOf(c1.address)).to.equal(ethers.parseEther("11"));
    expect(await sbt.balanceOf(c3.address)).to.equal(before); // no reward without reveal
  });

  it("restricts Emergency Revocation proposals to the TPC and auto-freezes the asset on notification", async () => {
    const { governance, lifecycle, mic, identity, critics } = await setupGovernance();
    const signers = await ethers.getSigners();
    const tpc = signers[4];
    const artist = signers[5];
    await onboard(identity, mic, tpc, Role.TPC, "did:hashcanvas:tpc");
    await onboard(identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist");

    await lifecycle.connect(artist).initializeArtwork("asset-1", "QmCid", 1, []);
    await lifecycle.connect(artist).requestCertification("asset-1", "0x");

    await expect(
      governance.connect(critics[0]).proposeEmergencyRevocation("asset-1", artist.address)
    ).to.be.revertedWithCustomError(governance, "NotTpc");

    // The TPC notification opens the proposal AND automatically freezes the asset on-chain.
    await expect(
      governance.connect(tpc).proposeEmergencyRevocation("asset-1", artist.address)
    ).to.emit(governance, "ProposalCreated");
    expect(await lifecycle.statusOf("asset-1")).to.equal(Status.FROZEN);
  });
});
