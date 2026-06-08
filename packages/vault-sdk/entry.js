export {
  createVaultKey,
  destroyVaultKey,
  encryptVaultPayload,
  decryptVaultPayload,
  wrapVaultKey,
  unwrapVaultKey,
  createEncryptedCaseExport
} from "../../src/crypto/clientVault.ts";

export { redactedScopeFromIntake, buildEncryptedIntake } from "./helpers.js";