/** MandateGate domain types, parsing, and client-side pre-checks that mirror the contract. */
export type Status = 'COMPLIANT' | 'NON_COMPLIANT' | 'INSUFFICIENT_EVIDENCE';
export type Authorization = 'RESERVED' | 'CANCELLED' | 'NONE';

export type Mandate = {
  owner: string;
  mandate_text: string;
  mandate_version: string;
  pair: string;
  pool_id: string;
  registry_host: string;
  total_cap: number;
  per_proposal_cap: number;
};

export type Budget = { total_cap: number; per_proposal_cap: number; reserved: number; available: number };

export type Summary = {
  proposals: number;
  compliant: number;
  non_compliant: number;
  insufficient_evidence: number;
  cancelled: number;
  reserved: number;
  available: number;
  total_cap: number;
};

export type SourceLog = { url: string; ok: boolean; error: string };

export type Proposal = {
  proposal_id: string;
  proposer: string;
  pair: string;
  pool_id: string;
  amount: number;
  rationale: string;
  evidence_urls: string[];
  mandate_version: string;
  decided_at: number;
  status: Status;
  reason_codes: string[];
  reasoning: string;
  supporting_urls: string[];
  findings: Record<string, string | boolean> | null;
  sources: SourceLog[];
  reserved_amount: number;
  authorization: Authorization;
  cancelled_at: number;
};

export const STATUS_LABEL: Record<Status, string> = {
  COMPLIANT: 'Compliant',
  NON_COMPLIANT: 'Non-compliant',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

export const REASON_TEXT: Record<string, string> = {
  IDENTITY_CONFIRMED: 'Evidence names the configured pool and pair',
  POOL_ACTIVE_SUPPORTED: 'Pool reported active and supported',
  NO_ADVERSE_REPORTS: 'No active suspension, exploit, deprecation or warning',
  ADVERSE_REPORT: 'Authoritative source reports an active adverse event',
  POOL_NOT_ACTIVE: 'Pool reported suspended, deprecated or unsupported',
  EVIDENCE_UNAVAILABLE: 'No submitted source returned usable content',
  NON_AUTHORITATIVE_EVIDENCE: 'No authoritative source for this pool',
  IDENTITY_MISMATCH: 'Evidence refers to a different pool or pair',
  IDENTITY_UNCLEAR: 'Evidence does not clearly identify the configured pool',
  CONFLICTING_EVIDENCE: 'Authoritative sources contradict each other',
  POOL_STATE_UNCLEAR: 'Current pool state is not established',
  INCOMPLETE_EVIDENCE: 'Sources do not establish the absence of adverse reports',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseJson<T>(raw: unknown, check: (value: Record<string, unknown>) => boolean, what: string): T {
  if (typeof raw !== 'string') throw new Error(`Unexpected ${what} response from the contract.`);
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !check(value)) throw new Error(`The contract returned a malformed ${what}.`);
  return value as T;
}

export const isBudget = (v: Record<string, unknown>) =>
  ['total_cap', 'per_proposal_cap', 'reserved', 'available'].every((k) => Number.isInteger(v[k]));
export const isMandate = (v: Record<string, unknown>) =>
  typeof v.mandate_text === 'string' && typeof v.pool_id === 'string' && typeof v.pair === 'string';
export const isSummary = (v: Record<string, unknown>) => Number.isInteger(v.proposals) && Number.isInteger(v.reserved);
export const isProposal = (v: Record<string, unknown>) =>
  typeof v.proposal_id === 'string' && typeof v.status === 'string' && Array.isArray(v.reason_codes);

export type Draft = { proposalId: string; amount: string; rationale: string; urls: string[] };
export type DraftErrors = Partial<Record<'proposalId' | 'amount' | 'rationale' | 'urls', string>>;

/** Same deterministic rules the contract enforces; the contract remains the authority. */
export function validateDraft(draft: Draft, budget: Budget | null, knownIds: Set<string>): DraftErrors {
  const errors: DraftErrors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,47}$/.test(draft.proposalId))
    errors.proposalId = 'Use 3-48 letters, digits, "-" or "_", starting with a letter or digit.';
  else if (knownIds.has(draft.proposalId)) errors.proposalId = 'This proposal ID has already been adjudicated.';

  if (!/^\d+$/.test(draft.amount.trim())) errors.amount = 'Enter a positive whole number of accounting units.';
  else {
    const amount = Number(draft.amount.trim());
    if (amount <= 0) errors.amount = 'Amount must be positive.';
    else if (budget && amount > budget.per_proposal_cap)
      errors.amount = `Exceeds the per-proposal cap of ${budget.per_proposal_cap.toLocaleString('en-US')} units.`;
    else if (budget && amount > budget.available)
      errors.amount = `Exceeds the available budget of ${budget.available.toLocaleString('en-US')} units.`;
  }

  const rationale = draft.rationale.split(/\s+/).filter(Boolean).join(' ');
  if (rationale.length < 12 || rationale.length > 600) errors.rationale = 'Rationale must be 12-600 characters.';

  const urls = draft.urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length < 1 || urls.length > 3) errors.urls = 'Provide between 1 and 3 evidence URLs.';
  else if (new Set(urls).size !== urls.length) errors.urls = 'Evidence URLs must be distinct.';
  else {
    const bad = urls.find((u) => !validEvidenceUrl(u));
    if (bad) errors.urls = `Not an accepted public https:// URL: ${bad.slice(0, 80)}`;
  }
  return errors;
}

export function validEvidenceUrl(url: string): boolean {
  if (url.length > 300) return false;
  const match = /^https:\/\/([A-Za-z0-9.-]+)(\/[^\s\\]*)?$/.exec(url);
  if (!match) return false;
  const host = match[1].toLowerCase().replace(/\.$/, '');
  return (
    host.includes('.') &&
    host !== 'localhost' &&
    !/\.(localhost|local|internal)$/.test(host) &&
    !/^[0-9.]+$/.test(host)
  );
}

/** Map a contract UserError such as "[LIMIT] amount ..." to a reviewer-facing sentence. */
export function explainContractError(message: string): string {
  const match = /\[(INPUT|LIMIT|IDENTITY|DUPLICATE|FORBIDDEN|STATE|NOT_FOUND|LLM_ERROR)\]\s*([^"'\\]*)/.exec(message);
  if (!match) return message;
  const [, kind, detail] = match;
  const prefix: Record<string, string> = {
    INPUT: 'Rejected by input validation',
    LIMIT: 'Rejected by a deterministic limit',
    IDENTITY: 'Rejected: wrong pair or pool',
    DUPLICATE: 'Rejected: duplicate proposal ID',
    FORBIDDEN: 'Rejected: owner-only action',
    STATE: 'Rejected by the authorization state',
    NOT_FOUND: 'Rejected: unknown proposal',
    LLM_ERROR: 'Validators could not obtain a usable model assessment; nothing was recorded. Safe to retry',
  };
  return `${prefix[kind]}: ${detail.trim()}`;
}

export function shortHex(value: string, head = 6, tail = 4) {
  return value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function units(value: number) {
  return value.toLocaleString('en-US');
}
