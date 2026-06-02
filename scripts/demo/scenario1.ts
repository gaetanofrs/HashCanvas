/**
 * DEMO 1 — Ciclo di vita base di un'opera.
 * Creazione (Digital Twin + IPFS) → presentazione/validazione AICA → vendita off-chain
 * con passaggio di proprietà on-chain tramite lock-and-release.
 *
 *   npx hardhat run scripts/demo/scenario1.ts
 */
import { ethers } from "hardhat";
import { compoundHash } from "../helpers/deploy";
import { createHeliaNode } from "../helpers/ipfs";
import { buildManifest } from "../helpers/manifest";
import { bootstrap, title, step, info, pause, confirm, showStatus, done } from "./common";

const ASSET = "urn:uuid:6c9b33a1-2851-4b1e-962a-7bf439019284";

async function main() {
  title("DEMO 1 · Creazione, validazione e vendita di un'opera");

  const { lifecycle, actors } = await bootstrap();
  const { artist, collector1 } = actors;

  // ---- Step 1: genesi del Digital Twin + storage su IPFS -------------------------------------
  step(1, "L'Artista crea il Digital Twin e lo ancora su IPFS");
  info("L'Artista compila il manifest JSON-LD (dati fisici, forensics, diagnostica) e lo carica");
  info("sul cluster IPFS privato; on-chain viene salvato solo il CID immutabile.");
  await pause("registrare l'opera on-chain");

  const ctx = await createHeliaNode();
  const built = await buildManifest(ctx, { artistDid: "did:hashcanvas:artist:gaetano", value: 150 });
  const compounds = built.manifest.realizationMaterials.map((m: any) => compoundHash(m.compoundId));
  await lifecycle.connect(artist).initializeArtwork(ASSET, built.cid, 150, compounds);
  info(`manifest CID = ${built.cid}`);
  await showStatus(lifecycle, ASSET);
  info("L'opera è PENDING_VALIDATION: non può ancora essere venduta o delegata.");

  // ---- Step 2: presentazione e validazione AICA ----------------------------------------------
  step(2, "Presentazione all'AICA e certificazione");
  info("L'opera viene valutata rispetto alla policy di validazione AICA attiva.");
  info("Se i requisiti (valore minimo, materiali ammessi) sono soddisfatti, viene certificata.");
  await pause("richiedere la certificazione");

  const aicaSig = await actors.mic.signMessage(ethers.toUtf8Bytes(`aica-cert:${ASSET}`));
  await lifecycle.connect(artist).requestCertification(ASSET, aicaSig);
  await showStatus(lifecycle, ASSET);
  info("Ora è CERTIFIED: sbloccata l'operatività commerciale (vendita / delega).");

  // ---- Step 3: vendita off-chain → blocco on-chain -------------------------------------------
  step(3, "Vendita off-chain e avvio del trasferimento");
  info("Acquirente: Collector Alpha. La trattativa e il pagamento avvengono off-chain.");
  if (!(await confirm("La vendita off-chain è conclusa: avviare il trasferimento on-chain?"))) {
    info("Trasferimento annullato. L'opera resta all'Artista.");
    await ctx.stop();
    return;
  }
  await lifecycle.connect(artist).initiateTransfer(ASSET, collector1.address);
  await showStatus(lifecycle, ASSET);
  info("Stato LOCKED_FOR_SALE: l'opera è bloccata, niente doppia vendita (mitiga T03).");

  // ---- Step 4: finalizzazione (lock-and-release) ---------------------------------------------
  step(4, "Finalizzazione del passaggio di proprietà");
  if (await confirm("Confermi la finalizzazione del passaggio di proprietà?")) {
    await lifecycle.connect(collector1).finalizeTransfer(ASSET);
    info(`Nuovo proprietario = Collector Alpha (${(await lifecycle.ownerOf(ASSET)) === collector1.address}).`);
  } else {
    await lifecycle.connect(artist).cancelTransfer(ASSET);
    info("Vendita annullata: l'opera torna disponibile e resta all'Artista.");
  }
  await showStatus(lifecycle, ASSET);

  await ctx.stop();
  console.log("\n✅ Demo 1 completata.");
}

main()
  .then(() => {
    done();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    done();
    process.exit(1);
  });
