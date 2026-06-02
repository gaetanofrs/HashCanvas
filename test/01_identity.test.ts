import { expect } from "chai";
import { ethers } from "hardhat";
import { deployStack, onboard, Role } from "../scripts/helpers/deploy";

describe("IdentityRegistry — SSI onboarding, MitM (T12) & 3-Strikes", () => {
  it("onboards a holder with a valid MIC-issued credential", async () => {
    const [mic, artist] = await ethers.getSigners();
    const { identity } = await deployStack(mic);

    await onboard(identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist-gaetano");

    expect(await identity.isActive(artist.address)).to.equal(true);
    expect(await identity.roleOf(artist.address)).to.equal(Role.ARTIST);
    expect(await identity.hasActiveRole(artist.address, Role.ARTIST)).to.equal(true);
  });

  it("rejects a self-forged credential (issuer is not the MIC)", async () => {
    const [mic, attacker] = await ethers.getSigners();
    const { identity } = await deployStack(mic);

    const expiry = (await ethers.provider.getBlock("latest"))!.timestamp + 1000;
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("fake"));
    const digest = await identity.credentialDigest(
      attacker.address,
      "did:hashcanvas:fake",
      Role.ARTIST,
      commitment,
      expiry
    );
    // attacker signs their own credential instead of the MIC
    const sig = await attacker.signMessage(ethers.getBytes(digest));

    await expect(
      identity.connect(attacker).onboard("did:hashcanvas:fake", Role.ARTIST, commitment, expiry, sig)
    ).to.be.revertedWithCustomError(identity, "BadIssuerSignature");
  });

  it("defeats Identity Provisioning Interception (T12): a credential is bound to the legitimate holder", async () => {
    const [mic, victim, attacker] = await ethers.getSigners();
    const { identity } = await deployStack(mic);

    // MIC issues a VC for the legitimate applicant (victim).
    const expiry = (await ethers.provider.getBlock("latest"))!.timestamp + 1000;
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("kyc:victim"));
    const digest = await identity.credentialDigest(
      victim.address,
      "did:hashcanvas:victim",
      Role.ARTIST,
      commitment,
      expiry
    );
    const micSig = await mic.signMessage(ethers.getBytes(digest));

    // Attacker intercepts the VC and tries to redeem it from their own key. On-chain the digest is
    // recomputed with msg.sender = attacker, so the MIC signature no longer recovers to the MIC.
    await expect(
      identity
        .connect(attacker)
        .onboard("did:hashcanvas:victim", Role.ARTIST, commitment, expiry, micSig)
    ).to.be.revertedWithCustomError(identity, "BadIssuerSignature");

    // The legitimate holder can still redeem it.
    await identity
      .connect(victim)
      .onboard("did:hashcanvas:victim", Role.ARTIST, commitment, expiry, micSig);
    expect(await identity.isActive(victim.address)).to.equal(true);
  });

  it("revokes a DID deterministically after 3 validated strikes", async () => {
    const [mic, artist, striker] = await ethers.getSigners();
    const { identity } = await deployStack(mic);
    await onboard(identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist");

    await identity.setStriker(striker.address, true);

    await identity.connect(striker).registerStrike(artist.address, "s1");
    await identity.connect(striker).registerStrike(artist.address, "s2");
    expect(await identity.isActive(artist.address)).to.equal(true);
    expect(await identity.strikesOf(artist.address)).to.equal(2);

    await identity.connect(striker).registerStrike(artist.address, "s3");
    expect(await identity.isActive(artist.address)).to.equal(false);
    expect(await identity.statusOf(artist.address)).to.equal(2); // REVOKED
  });

  it("blocks unauthorized strike reporters", async () => {
    const [mic, artist, stranger] = await ethers.getSigners();
    const { identity } = await deployStack(mic);
    await onboard(identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist");

    await expect(
      identity.connect(stranger).registerStrike(artist.address, "x")
    ).to.be.revertedWithCustomError(identity, "NotAuthorizedStriker");
  });
});
