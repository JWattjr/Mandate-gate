/**
 * Local test harness only: a signer for an injected EIP-1193 "dev wallet".
 *
 * Browser verification needs a wallet, and the automated browser has no
 * extension. This localhost-only server holds a throwaway key (generated into
 * .keys/dev-wallet.key, funded from the Studio Next faucet) and answers the
 * JSON-RPC calls a browser wallet would: account/chain queries, eth_sendTransaction
 * (signed here and broadcast to Studio Next), and passthrough reads.
 * Paste scripts/dev-wallet-inject.js into the page console to announce it via EIP-6963.
 *
 *   node scripts/dev-wallet.mjs            # listens on http://127.0.0.1:3999
 */
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWalletClient, http as viemHttp } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { chain, RPC, rpc, ensureFunded, nativeFetch } from './lib.mjs';

const keyPath = new URL('../.keys/dev-wallet.key', import.meta.url);
await mkdir(new URL('../.keys/', import.meta.url), { recursive: true });
let key;
try {
  key = (await readFile(keyPath, 'utf8')).trim();
} catch {
  key = generatePrivateKey();
  await writeFile(keyPath, key, { mode: 0o600 });
}
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: viemHttp(RPC, { fetchFn: nativeFetch, timeout: 30_000 }) });
await ensureFunded(account.address);
console.log(`Dev wallet ${account.address} on chain ${chain.id}`);

const big = (v) => (v === undefined || v === null ? undefined : BigInt(v));

async function handle({ method, params = [] }) {
  switch (method) {
    case 'eth_accounts':
    case 'eth_requestAccounts':
      return [account.address];
    case 'eth_chainId':
      return `0x${chain.id.toString(16)}`;
    case 'eth_sendTransaction': {
      const tx = params[0] ?? {};
      if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) throw new Error('from mismatch');
      return wallet.sendTransaction({
        to: tx.to,
        data: tx.data ?? tx.input,
        value: big(tx.value) ?? 0n,
        gas: big(tx.gas),
      });
    }
    default:
      return rpc(method, params);
  }
}

http
  .createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3107');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const request = JSON.parse(body);
      console.log(`-> ${request.method} ${JSON.stringify(request.params ?? []).slice(0, 160)}`);
      const result = await handle(request);
      console.log(`${request.method} -> ok`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result }));
    } catch (error) {
      console.log(`error: ${error?.shortMessage ?? error?.message}`);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: error?.code ?? -32000, message: error?.shortMessage ?? error?.message ?? String(error) } }));
    }
  })
  .listen(3999, '127.0.0.1', () => console.log('Dev wallet signer on http://127.0.0.1:3999'));
