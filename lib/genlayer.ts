/**
 * Studio Next access for the browser.
 *
 * Reads use an account-free client. Writes use the Transaction Kit RC for fee
 * quoting and submission through the injected wallet, then this module tracks the
 * transaction itself at a pace that respects Studio Next's 30 requests/minute
 * limit. A decided lifecycle is never treated as success on its own: the
 * execution result is checked and contract state is read back.
 */
import { createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';
import {
  TransactionHashVariant,
  executionResultNumberToName,
  transactionsStatusNumberToName,
  type GenLayerTransaction,
  type TransactionHash,
} from 'genlayer-js/types';
import { createTransactionKit, type PolicyQuote, type SubmitInput } from '@genlayer/transaction-kit';
import deployment from './deployment.json';
import demo from '../config/demo.json';
import {
  isBudget,
  isMandate,
  isProposal,
  isSummary,
  parseJson,
  type Budget,
  type Mandate,
  type Proposal,
  type Summary,
} from './mandate';
import { guardedProvider, type BrowserProvider } from './wallet';

export const chain = studioDevnet;
export const CHAIN_ID = chain.id;
export const RPC_URL = chain.rpcUrls.default.http[0];
export const EXPLORER = demo.explorer;

const envAddress = process.env.NEXT_PUBLIC_MANDATEGATE_ADDRESS?.trim();
export const CONTRACT_ADDRESS = (
  envAddress && /^0x[0-9a-fA-F]{40}$/.test(envAddress) ? envAddress : deployment.contract
) as `0x${string}`;
export const DEPLOY_TX = deployment.deployTransaction;
export const configured = /^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDRESS ?? '');

export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER}/address/${address}`;

/**
 * Studio Next allows 30 JSON-RPC requests per minute per client IP. The page
 * stays well under that (4 reads per refresh, one poll per 5s while tracking),
 * and a rate-limited response is retried after the server's retry_after hint
 * so reads and tracking slow down instead of failing.
 */
function installRpcPacing() {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __mandateGatePaced?: boolean };
  if (w.__mandateGatePaced) return;
  w.__mandateGatePaced = true;
  const native = window.fetch.bind(window);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(RPC_URL)) return native(input, init);
    for (let attempt = 0; ; attempt++) {
      const response = await native(input, init);
      const text = await response.clone().text();
      const gateway = response.status >= 500 || text.trimStart().startsWith('<');
      if (!(response.status === 429 || gateway || text.includes('-32029')) || attempt >= 5) return response;
      let retry = gateway ? 3 : 10;
      try {
        retry = JSON.parse(text)?.error?.data?.retry_after_seconds ?? retry;
      } catch {
        /* non-JSON body */
      }
      await sleep((retry + 1) * 1000);
    }
  };
}
installRpcPacing();

let reader: ReturnType<typeof createClient> | null = null;
function readClient() {
  reader ??= createClient({ chain });
  return reader;
}

export type ReadMode = 'final' | 'latest';

async function view(functionName: string, args: (string | number)[] = [], mode: ReadMode = 'latest') {
  return readClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    transactionHashVariant:
      mode === 'final' ? TransactionHashVariant.LATEST_FINAL : TransactionHashVariant.LATEST_NONFINAL,
  });
}

export type Snapshot = {
  mandate: Mandate;
  budget: Budget;
  summary: Summary;
  proposals: Proposal[];
  mode: ReadMode;
  readAt: number;
};

/** Four reads; the proposal list is capped at 50 (the contract's page size). */
export async function readSnapshot(mode: ReadMode = 'latest'): Promise<Snapshot> {
  const mandate = parseJson<Mandate>(await view('get_mandate', [], mode), isMandate, 'mandate');
  const budget = parseJson<Budget>(await view('get_budget', [], mode), isBudget, 'budget');
  const summary = parseJson<Summary>(await view('get_summary', [], mode), isSummary, 'summary');
  const offset = Math.max(0, summary.proposals - 50);
  const page = parseJson<{ items: Proposal[] }>(
    await view('list_proposals', [offset, 50], mode),
    (v) => Array.isArray(v.items),
    'proposal list',
  );
  const proposals = page.items.filter((p) => isProposal(p as unknown as Record<string, unknown>)).reverse();
  return { mandate, budget, summary, proposals, mode, readAt: Date.now() };
}

export async function readProposal(id: string, mode: ReadMode): Promise<Proposal | null> {
  try {
    return parseJson<Proposal>(await view('get_proposal', [id], mode), isProposal, 'proposal');
  } catch (error) {
    if (String((error as Error)?.message ?? error).includes('NOT_FOUND')) return null;
    throw error;
  }
}

// ------------------------------------------------------------------ writes

function kitFor(provider: BrowserProvider, address: string) {
  return createTransactionKit({
    chain,
    provider: guardedProvider(provider, chain, address),
    account: address as `0x${string}`,
  });
}

export function proposalTx(args: {
  proposalId: string;
  pair: string;
  poolId: string;
  amount: number;
  rationale: string;
  urls: string[];
}): SubmitInput {
  return {
    kind: 'write',
    address: CONTRACT_ADDRESS,
    method: 'evaluate_proposal',
    args: [args.proposalId, args.pair, args.poolId, args.amount, args.rationale, args.urls],
  };
}

export function cancelTx(proposalId: string): SubmitInput {
  return { kind: 'write', address: CONTRACT_ADDRESS, method: 'cancel_authorization', args: [proposalId] };
}

export async function quoteAndSubmit(
  provider: BrowserProvider,
  address: string,
  tx: SubmitInput,
  onQuote: (quote: PolicyQuote) => void,
): Promise<`0x${string}`> {
  const kit = kitFor(provider, address);
  const quote = await kit.estimate({ preset: 'standard' }, tx);
  if (quote.verification.status === 'mismatch')
    throw new Error('Network fee prices changed while quoting. Submit again to use a fresh quote.');
  onQuote(quote);
  const { genlayerTxId } = await kit.submit(quote, tx);
  return genlayerTxId;
}

/** Studio Next development faucet. Only meaningful on this sandbox network. */
export async function requestTestFunds(address: string) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sim_fundAccount', params: [address, '10000000000000000000'] }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? 'Faucet request failed.');
}

export async function balanceOf(address: string): Promise<bigint> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? 'Balance read failed.');
  return BigInt(body.result);
}

// ---------------------------------------------------------------- tracking

export type Phase = 'pending' | 'processing' | 'decided' | 'finalized';

export type Tracked = {
  phase: Phase;
  statusName: string;
  executionResult?: string;
  /** true only when execution returned normally */
  executed?: boolean;
  /** contract error text for failed executions, when the receipt carries it */
  errorText?: string;
};

const DECIDED = ['ACCEPTED', 'UNDETERMINED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT'];
const PROCESSING = ['PROPOSING', 'COMMITTING', 'REVEALING', 'APPEAL_REVEALING', 'APPEAL_COMMITTING', 'LEADER_REVEALING', 'READY_TO_FINALIZE'];

function statusNameOf(tx: GenLayerTransaction): string {
  const raw = tx as unknown as { statusName?: string; status_name?: string; status?: number | string };
  if (raw.statusName) return raw.statusName;
  if (raw.status_name) return raw.status_name;
  if (typeof raw.status === 'number')
    return transactionsStatusNumberToName[String(raw.status) as keyof typeof transactionsStatusNumberToName] ?? 'UNKNOWN';
  return typeof raw.status === 'string' ? raw.status : 'PENDING';
}

function executionOf(tx: GenLayerTransaction): string | undefined {
  const raw = tx as unknown as { txExecutionResultName?: string; txExecutionResult?: number };
  if (raw.txExecutionResultName) return raw.txExecutionResultName;
  if (typeof raw.txExecutionResult === 'number')
    return executionResultNumberToName[String(raw.txExecutionResult) as keyof typeof executionResultNumberToName];
  return undefined;
}

/** Find a contract error tag like "[LIMIT] ..." anywhere in the receipt. */
export function contractErrorIn(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === 'string') {
    const match = /\[(INPUT|LIMIT|IDENTITY|DUPLICATE|FORBIDDEN|STATE|NOT_FOUND|LLM_ERROR)\][^"\\]{0,220}/.exec(value);
    return match?.[0];
  }
  if (typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = contractErrorIn(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function mapTransaction(tx: GenLayerTransaction): Tracked {
  const statusName = statusNameOf(tx);
  const phase: Phase =
    statusName === 'FINALIZED' ? 'finalized' : DECIDED.includes(statusName) ? 'decided' : PROCESSING.includes(statusName) ? 'processing' : 'pending';
  const tracked: Tracked = { phase, statusName };
  if (phase === 'decided' || phase === 'finalized') {
    // Before a decision the node reports placeholder values such as NOT_VOTED.
    const executionResult = executionOf(tx);
    tracked.executionResult = executionResult;
    tracked.executed = statusName !== 'UNDETERMINED' && executionResult === 'FINISHED_WITH_RETURN';
    if (!tracked.executed) tracked.errorText = contractErrorIn(tx);
  }
  return tracked;
}

export async function trackTransaction(
  hash: `0x${string}`,
  onUpdate: (t: Tracked) => void,
  shouldStop: () => boolean,
  intervalMs = 5000,
): Promise<Tracked> {
  let last: Tracked | null = null;
  for (let i = 0; i < 360 && !shouldStop(); i++) {
    try {
      const tx = await readClient().getTransaction({ hash: hash as TransactionHash });
      last = mapTransaction(tx);
      onUpdate(last);
      if (last.phase === 'finalized') return last;
    } catch {
      // Transient RPC errors (including rate limiting) are retried on the next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!last) throw new Error('Could not read this transaction from Studio Next.');
  return last;
}
