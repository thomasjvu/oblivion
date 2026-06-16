export const MIN_USER_CONFIRMATION_LENGTH = 8;
export const EVM_ADDRESS_PREFIX = "0x";
export const EVM_ADDRESS_LENGTH = 42;
export const VENICE_DEFAULT_MAX_TOKENS_CHAT = 800;
export const VENICE_DEFAULT_MAX_TOKENS_ANALYSIS = 1200;

export function isEvmAddress(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith(EVM_ADDRESS_PREFIX) && value.length === EVM_ADDRESS_LENGTH;
}