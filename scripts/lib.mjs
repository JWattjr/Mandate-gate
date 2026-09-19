/**
 * Shared Node tooling for MandateGate on GenLayer Studio Next (studioDevnet, chain 61997).
 *
 * The deployer key lives in .keys/deployer.key (git-ignored) or the
 * MANDATEGATE_DEPLOYER_KEY environment variable. It is never printed.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createClient, createAccount, generatePrivateKey } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';
import {
  TransactionHashVariant,
  executionResultNumberToName,
  transactionsStatusNumberToName,
} from 'genlayer-js/types';
import { createTransactionKit } from '@genlayer/transaction-kit';

export const chain = studioDevnet;
export const RPC = chain.rpcUrls.default.http[0];

/**
 * Studio Next allows 30 JSON-RPC requests per minute per client. Space every
 * RPC request at least 2.2s apart and retry rate-limited responses after the
 * server's retry_after hint, so long waits never fail on the limiter.
 */
export const nativeFetch = globalThis.fetch;
let nextSlot = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url.startsWith(RPC)) return nativeFetch(input, init);
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + 2200;
    if (wait) await sleep(wait);
    const response = await nativeFetch(input, init);
    const text = await response.clone().text();
    const limited = response.status === 429 || response.status >= 500 || text.includes('-32029') || text.trimStart().startsWith('<');
    if (!limited || attempt >= 8) return response;
    let retry = response.status >= 500 || text.trimStart().startsWith('<') ? 5 : 15;
    try {
      retry = JSON.parse(text)?.error?.data?.retry_after_seconds ?? retry;
    } catch {
      /* non-JSON 429 body */
    }
    await sleep((retry + 1) * 1000);
  }
};
export const demo = JSON.parse(await readFile(new URL('../config/demo.json', import.meta.url), 'utf8'));
export const DEPLOYMENT_PATH = new URL('../lib/deployment.json', import.meta.url);
export const PROOF_PATH = new URL('../deploy/proof.json', import.meta.url);

export const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

export async function deployerAccount() {
  let key = process.env.MANDATEGATE_DEPLOYER_KEY?.trim();
  if (!key) {
    await mkdir(new URL('../.keys/', import.meta.url), { recursive: true });
    const path = new URL('../.keys/deployer.key', import.meta.url);
    try {
      key = (await readFile(path, 'utf8')).trim();
    } catch {
      key = generatePrivateKey();
      await writeFile(path, key, { mode: 0o600 });
      console.log('Generated a new Studio Next deployer key in .keys/deployer.key (git-ignored).');
    }
  }
  return createAccount(key);
}

export function readClient() {
  return createClient({ chain });
}

export async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/** Studio Next exposes a development faucet; top the deployer up when it runs low. */
export async function ensureFunded(address, minimumWei = 10n ** 18n) {
  const balance = BigInt(await rpc('eth_getBalance', [address, 'latest']));
  if (balance >= minimumWei) return balance;
  await rpc('sim_fundAccount', [address, (10n ** 20n).toString()]);
  const after = BigInt(await rpc('eth_getBalance', [address, 'latest']));
  console.log(`Funded deployer from the Studio Next faucet: ${after} wei`);
  return after;
}

const estimatingProvider = {
  request: async () => {
    throw new Error('Scripts estimate fees without an injected wallet.');
  },
};

/** Quote through the matching Transaction Kit RC; prices are always live reads. */
export async function quote(tx) {
  const kit = createTransactionKit({ chain, provider: estimatingProvider });
  const estimate = await kit.estimate({ preset: 'standard' }, tx);
  if (estimate.verification?.status === 'mismatch')
    throw new Error('Fee policy changed while quoting; re-run the command.');
  const feeArgs = estimate.gasless
    ? {}
    : { fees: { distribution: estimate.distribution, feeValue: estimate.feeValue } };
  return { estimate, feeArgs };
}

export function describeFee(estimate) {
  return estimate.gasless
    ? 'gasless (no deposit)'
    : `refundable deposit ${estimate.feeValue} wei (${estimate.source}, prices ${estimate.verification?.status})`;
}

export function statusName(receipt) {
  if (receipt.statusName) return receipt.statusName;
  if (receipt.status_name) return receipt.status_name;
  if (typeof receipt.status === 'number')
    return transactionsStatusNumberToName[String(receipt.status)];
  return receipt.status;
}

export function executionName(receipt) {
  if (receipt.txExecutionResultName) return receipt.txExecutionResultName;
  if (typeof receipt.txExecutionResult === 'number')
    return executionResultNumberToName[String(receipt.txExecutionResult)];
  const leader = receipt.consensus_data?.leader_receipt?.filter((r) => r.mode === 'leader').at(-1);
  return leader?.execution_result;
}

/** Best-effort extraction of the leader's return/error payload for proof records. */
export function leaderResult(receipt) {
  const leader = receipt.consensus_data?.leader_receipt?.filter?.((r) => r.mode === 'leader').at(-1)
    ?? (Array.isArray(receipt.consensus_data?.leader_receipt) ? receipt.consensus_data.leader_receipt[0] : receipt.consensus_data?.leader_receipt);
  if (!leader) return undefined;
  return leader.result ?? leader.execution_result;
}

export async function waitFor(hash, waitUntil = 'finalized') {
  return readClient().waitForTransactionReceipt({ hash, waitUntil, interval: 10000, retries: 90 });
}

export async function read(address, functionName, args = []) {
  return readClient().readContract({
    address,
    functionName,
    args,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
}

export async function readJson(address, functionName, args = []) {
  const raw = await read(address, functionName, args);
  if (typeof raw !== 'string') throw new Error(`${functionName} returned ${typeof raw}`);
  return JSON.parse(raw);
}

export async function loadDeployment() {
  try {
    return JSON.parse(await readFile(DEPLOYMENT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export const explorerTx = (hash) => `${demo.explorer}/tx/${hash}`;
export const explorerAddress = (address) => `${demo.explorer}/address/${address}`;
