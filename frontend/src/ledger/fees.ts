// The network fee a wallet charges from its own fee balance (Loop). Kept
// apart from wallet.ts, which loads the wallet SDKs only when connecting.

export interface FeeStatus {
  /** the balance does not cover the fee: top up in the wallet first */
  topUp: boolean
  amount?: string
  asset?: string
}

/** The wallet's fee balance does not cover the transfer; nothing was signed. */
export class FeeShortfall extends Error {
  readonly fee: FeeStatus
  constructor(fee: FeeStatus) {
    super('Your wallet fee balance is too low for this transaction.')
    this.fee = fee
  }
}
