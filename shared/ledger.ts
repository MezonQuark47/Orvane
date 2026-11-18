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

// ---------- auth ----------

// HS256 JWT for participants running with `unsafe-jwt-hmac-256` auth, as the
// Splice LocalNet does. Never use this against a real network.
export interface HmacAuth {
  secret: string
  audience: string
}

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hmacJwt(auth: HmacAuth, userId: string, ttlSeconds = 7 * 24 * 3600): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(JSON.stringify({ sub: userId, aud: auth.audience, iat: now, exp: now + ttlSeconds }))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(auth.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${b64url(sig)}`
}

export class JsonLedger {
  readonly baseUrl: string
  readonly userId: string
  private readonly auth?: HmacAuth
  private token?: { value: string; exp: number }

  constructor(baseUrl: string, userId = 'participant_admin', auth?: HmacAuth) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.userId = userId
    this.auth = auth
  }

  // A client for the same participant acting as another ledger user.
  as(userId: string): JsonLedger {
    return new JsonLedger(this.baseUrl, userId, this.auth)
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = json ? { 'content-type': 'application/json' } : {}
    if (this.auth) {
      if (!this.token || this.token.exp < Date.now() + 60_000) {
        this.token = { value: await hmacJwt(this.auth, this.userId, 3600), exp: Date.now() + 3600_000 }
      }
      h.authorization = `Bearer ${this.token.value}`
    }
    return h
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: await this.headers(body !== undefined),
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

  // Upload a DAR. Uploading a package that is already loaded is a no-op.
  async uploadDar(bytes: Uint8Array): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v2/packages`, {
      method: 'POST',
      headers: { ...(await this.headers(false)), 'content-type': 'application/octet-stream' },
      body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    })
    if (!res.ok) throw new LedgerError(res.status, await res.text())
  }

  // Make sure a ledger user exists and may act and read as `parties`.
  async ensureUser(userId: string, parties: string[]): Promise<void> {
    const rights = parties.flatMap((party) => [
      { kind: { CanActAs: { value: { party } } } },
      { kind: { CanReadAs: { value: { party } } } },
    ])
    try {
      await this.call('/v2/users', {
        user: { id: userId, primaryParty: '', isDeactivated: false, identityProviderId: '', metadata: { resourceVersion: '', annotations: {} } },
        rights,
      })
    } catch (err) {
      if (!(err instanceof LedgerError) || !/ALREADY_EXISTS|already exists/i.test(err.body)) throw err
      await this.call(`/v2/users/${encodeURIComponent(userId)}/rights`, { userId, rights, identityProviderId: '' })
    }
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

  // `disclosedContracts` lets the command use contracts the submitters don't
  // hold themselves (e.g. AmuletRules handed out by Scan).
  async submit(
    actAs: string[],
    commands: DamlCommand[],
    readAs: string[] = [],
    disclosedContracts: Array<{ templateId: string; contractId: string; createdEventBlob: string; synchronizerId: string }> = [],
  ): Promise<Transaction> {
    const r = await this.call<{ transaction: Transaction }>('/v2/commands/submit-and-wait-for-transaction', {
      commands: { commands, commandId: newCommandId(), userId: this.userId, actAs, readAs, disclosedContracts },
      transactionFormat: {
        eventFormat: { filtersByParty: Object.fromEntries(actAs.map((p) => [p, { cumulative: [] }])), verbose: true },
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      },
    })
    return r.transaction
  }

  // Active contracts implementing an interface, with their interface view.
  async queryInterface<V>(party: string, interfaceId: string): Promise<Array<{ contractId: string; templateId: string; view: V }>> {
    const activeAtOffset = await this.ledgerEnd()
    const rows = await this.call<
      Array<{ contractEntry: { JsActiveContract?: { createdEvent: CreatedEvent & { interfaceViews?: Array<{ viewValue?: unknown }> } } } }>
    >('/v2/state/active-contracts', {
      eventFormat: {
        filtersByParty: {
          [party]: {
            cumulative: [
              { identifierFilter: { InterfaceFilter: { value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } } } },
            ],
          },
        },
        verbose: true,
      },
      activeAtOffset,
    })
    return rows
      .map((r) => r.contractEntry.JsActiveContract?.createdEvent)
      .filter((e): e is NonNullable<typeof e> => !!e && !!e.interfaceViews?.[0]?.viewValue)
      .map((e) => ({ contractId: e.contractId, templateId: e.templateId, view: e.interfaceViews![0].viewValue as V }))
  }
}

// Find the first created contract of a template in a transaction.
export const createdOf = (tx: Transaction, templateId: string) =>
  tx.events.map((e) => e.CreatedEvent).find((e): e is CreatedEvent => !!e && sameTemplate(e.templateId, templateId))
