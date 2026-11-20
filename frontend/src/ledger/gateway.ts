// Where the CIP-0103 Wallet Gateway listens (LocalNet). Kept apart from the
// wallet SDKs so the page can name it without loading them.
export const GATEWAY_URL: string = import.meta.env.VITE_WALLET_GATEWAY_URL ?? 'http://localhost:3030/api/v0/dapp'
