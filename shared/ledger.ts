// Minimal client for the Canton JSON Ledger API v2.
// Used by both the operator service (Node) and the web app (browser).

export type DamlCommand =
  | { CreateCommand: { templateId: string; createArguments: unknown } }
  | {
      ExerciseCommand: {
        templateId: string
        contractId: string
        choice: string
        choiceArgument: unknown
      }
    }
  | {
      CreateAndExerciseCommand: {
        templateId: string
        createArguments: unknown
        choice: string
        choiceArgument: unknown
      }
    }

export interface Contract<T> {
  contractId: string
  templateId: string
  payload: T
  createdAt?: string
}

export interface CreatedEvent {
  contractId: string
  templateId: string
  createArgument: unknown
  createdAt?: string
}

export interface Transaction {
  updateId: string
  effectiveAt: string
  events: Array<{ CreatedEvent?: CreatedEvent; ArchivedEvent?: { contractId: string; templateId: string } }>
}

// Response template ids carry the package id; our ids use the package name.
// Compare on the "Module:Entity" suffix.
export const sameTemplate = (a: string, b: string) =>
  a.split(':').slice(-2).join(':') === b.split(':').slice(-2).join(':')

const templateFilter = (templateId: string) => ({
  identifierFilter: {
    TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } },
  },
})

let commandCounter = 0
const newCommandId = () =>
  `orvane-${Date.now().toString(36)}-${(commandCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export class LedgerError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(LedgerError.summarize(body) ?? `Ledger API error ${status}`)
    this.status = status
    this.body = body
  }

  // Pull the human-readable part out of a Canton error ("... failed: <reason>").
  static summarize(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body)
      const cause: string = parsed.cause ?? parsed.message ?? ''
      const assertion = cause.match(/(?:Assertion failed|UnhandledException)[^:]*:\s*(.*?)(?:"|$)/)
      if (assertion?.[1]) return assertion[1]
      return cause.slice(0, 240) || undefined
    } catch {
      return body.slice(0, 240) || undefined
    }
  }
}

export class JsonLedger {
  readonly baseUrl: string
  readonly userId: string

  constructor(baseUrl: string, userId = 'participant_admin') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.userId = userId
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new LedgerError(res.status, text)
    return text ? (JSON.parse(text) as T) : (undefined as T)
  }

  async ledgerEnd(): Promise<number> {
    const r = await this.call<{ offset: number }>('/v2/state/ledger-end')
    return r.offset
  }

  async listParties(): Promise<string[]> {
    const r = await this.call<{ partyDetails: Array<{ party: string }> }>('/v2/parties')
    return r.partyDetails.map((p) => p.party)
  }

  async allocateParty(hint: string): Promise<string> {
    const r = await this.call<{ partyDetails: { party: string } }>('/v2/parties', {
      partyIdHint: hint,
      identityProviderId: '',
    })
    return r.partyDetails.party
  }

  async query<T>(party: string, templateIds: string[]): Promise<Contract<T>[]> {
    const activeAtOffset = await this.ledgerEnd()
    const rows = await this.call<Array<{ contractEntry: { JsActiveContract?: { createdEvent: CreatedEvent } } }>>(
      '/v2/state/active-contracts',
      {
        eventFormat: {
          filtersByParty: { [party]: { cumulative: templateIds.map(templateFilter) } },
          verbose: true,
        },
        activeAtOffset,
      },
    )
    return rows
      .map((r) => r.contractEntry.JsActiveContract?.createdEvent)
      .filter((e): e is CreatedEvent => !!e)
      .map((e) => ({
        contractId: e.contractId,
        templateId: e.templateId,
        payload: e.createArgument as T,
        createdAt: e.createdAt,
      }))
  }

  // Every create of the given templates visible to `party`, oldest first.
  async history(party: string, templateIds: string[]): Promise<Array<{ at: string; event: CreatedEvent }>> {
    const endInclusive = await this.ledgerEnd()
    const updates = await this.call<Array<{ update: { Transaction?: { value: Transaction } } }>>('/v2/updates', {
      beginExclusive: 0,
      endInclusive,
      updateFormat: {
        includeTransactions: {
          eventFormat: {
            filtersByParty: { [party]: { cumulative: templateIds.map(templateFilter) } },
            verbose: true,
          },
          transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA',
        },
      },
    })
    const out: Array<{ at: string; event: CreatedEvent }> = []
    for (const u of updates) {
      const tx = u.update.Transaction?.value
      if (!tx) continue
      for (const ev of tx.events) if (ev.CreatedEvent) out.push({ at: tx.effectiveAt, event: ev.CreatedEvent })
    }
    return out
  }

  async submit(actAs: string[], commands: DamlCommand[], readAs: string[] = []): Promise<Transaction> {
    const r = await this.call<{ transaction: Transaction }>('/v2/commands/submit-and-wait-for-transaction', {
      commands: { commands, commandId: newCommandId(), userId: this.userId, actAs, readAs },
    })
    return r.transaction
  }
}

// Find the first created contract of a template in a transaction.
export const createdOf = (tx: Transaction, templateId: string) =>
  tx.events.map((e) => e.CreatedEvent).find((e): e is CreatedEvent => !!e && sameTemplate(e.templateId, templateId))
