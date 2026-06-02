/**
 * DEMO 2 — Deleghe e revoca.
 * Delega primaria (Proprietario → Galleria), sub-delega asimmetrica (Galleria → Collezionista),
 * blocco dei loop inter-galleria e revoca unilaterale con annullamento a cascata.
 *
 *   npx hardhat run scripts/demo/scenario2.ts
 */
import { bootstrap, title, step, info, pause, confirm, showStatus, done } from "./common";

const ASSET = "urn:uuid:delegation-demo-0001";
const CID = "QmDemoManifestCid000000000000000000000000000000";
const DAY = 24 * 3600;

async function main() {
  title("DEMO 2 · Catena di deleghe e revoca");

  const { lifecycle, actors } = await bootstrap();
  const { artist, gallery, gallery2, collector1 } = actors;

  // Preparazione: opera già creata e certificata (fuori dal focus della demo).
  await lifecycle.connect(artist).initializeArtwork(ASSET, CID, 150, []);
  await lifecycle.connect(artist).requestCertification(ASSET, "0x");
  info("Setup: opera creata e CERTIFIED. Proprietario = Artista.");

  // ---- Step 1: delega primaria --------------------------------------------------------------
  step(1, "Il Proprietario delega la Galleria (delega primaria, 30 giorni)");
  await pause("concedere la delega primaria alla Galleria");
  await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * DAY);
  await showStatus(lifecycle, ASSET);
  info(`Galleria autorizzata = ${await lifecycle.isDelegateAuthorized(ASSET, gallery.address)}`);

  // ---- Step 2: sub-delega Galleria → Collezionista ------------------------------------------
  step(2, "La Galleria sub-delega al Collezionista (10 giorni, ≤ delega padre)");
  await pause("eseguire la sub-delega verso il Collezionista");
  await lifecycle.connect(gallery).subDelegate(ASSET, collector1.address, 10 * DAY);
  info(`Collezionista autorizzato = ${await lifecycle.isDelegateAuthorized(ASSET, collector1.address)}`);
  info(`Profondità catena = ${(await lifecycle.delegationChain(ASSET)).length} (max 2).`);

  // ---- Step 3: regola anti-loop -------------------------------------------------------------
  step(3, "Tentativo di loop: la Galleria prova a sub-delegare a un'altra Galleria");
  info("Regola asimmetrica: una Galleria può sub-delegare SOLO a Collezionisti.");
  await pause("provare la sub-delega Galleria → Galleria (deve fallire)");
  try {
    await lifecycle.connect(gallery).subDelegate(ASSET, gallery2.address, 1 * DAY);
    info("⚠️  Inatteso: la transazione NON è fallita.");
  } catch {
    info("✅ Respinta a runtime (AntiLoop): loop inter-galleria impedito.");
  }

  // ---- Step 4: revoca unilaterale a cascata -------------------------------------------------
  step(4, "Revoca della delega primaria da parte del Proprietario");
  if (await confirm("Revocare la delega primaria? (annulla a cascata anche la sub-delega)")) {
    await lifecycle.connect(artist).revokeDelegation(ASSET);
    info("Revoca eseguita: l'intera catena è scollegata istantaneamente.");
    info(`Galleria autorizzata     = ${await lifecycle.isDelegateAuthorized(ASSET, gallery.address)}`);
    info(`Collezionista autorizzato = ${await lifecycle.isDelegateAuthorized(ASSET, collector1.address)}`);
    await showStatus(lifecycle, ASSET);
  } else {
    info("Nessuna revoca: la catena di deleghe resta attiva.");
    await showStatus(lifecycle, ASSET);
  }

  console.log("\n✅ Demo 2 completata.");
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
