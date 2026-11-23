// What a wallet left unsaid. Kept apart from wallet.ts, which loads the
// wallet SDKs only when connecting.

/**
 * The wallet stopped answering before it said whether the transaction went
 * through: the request timed out, or the wallet window closed. The user may
 * have signed it, so it can still land.
 */
export class OutcomeUnknown extends Error {}
