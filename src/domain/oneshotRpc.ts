const ALLOWED_ONESHOT_RPC_METHODS = new Set(["relayer_getStatus"]);

export function assertOneShotRpcMethodAllowed(method: string): void {
  if (!ALLOWED_ONESHOT_RPC_METHODS.has(method)) {
    throw new Error(`oneshot-rpc-method-not-allowed:${method}`);
  }
}