/**
 * Deploy MandateGate to GenLayer Studio Next and write lib/deployment.json.
 *
 *   npm run deploy:contract          # reuse an in-flight deployment if one is pending
 *   npm run deploy:contract -- --fresh
 *
 * Steps: schema-check the source against the live runner, quote fees through the
 * Transaction Kit RC, deploy, wait for FINALIZED, require FINISHED_WITH_RETURN,
 * then read the contract back and verify its configuration.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import {
  chain, demo, json, deployerAccount, ensureFunded, quote, describeFee,
  statusName, executionName, waitFor, read, readJson, DEPLOYMENT_PATH, explorerAddress, explorerTx,
} from './lib.mjs';
import { createClient } from 'genlayer-js';

const fresh = process.argv.includes('--fresh');
const pendingPath = new URL('../.keys/deploy-pending.json', import.meta.url);
if (fresh) await rm(pendingPath, { force: true });

const account = await deployerAccount();
const client = createClient({ chain, account });
console.log(`Network: ${chain.name} (chain ${await client.getChainId()})`);
console.log(`Deployer: ${account.address}`);
await ensureFunded(account.address);

const code = await readFile(new URL('../contracts/mandate_gate.py', import.meta.url), 'utf8');
const runner = code.split('\n', 1)[0];
console.log(`Runner header: ${runner}`);
const schema = await client.getContractSchemaForCode(new TextEncoder().encode(code));
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/contract-schema.json', import.meta.url), json(schema));
console.log('Schema accepted by the Studio Next runner.');

const args = [
  demo.mandateText,
  demo.mandateVersion,
  demo.pair,
  demo.poolId,
  demo.registryHost,
  demo.totalCap,
  demo.perProposalCap,
];

let pending = null;
try {
  pending = JSON.parse(await readFile(pendingPath, 'utf8'));
} catch {
  /* nothing in flight */
}
if (!pending) {
  const { estimate, feeArgs } = await quote({ kind: 'deploy', code, args, leaderOnly: false });
  console.log(`Deploy fee: ${describeFee(estimate)}`);
  const hash = await client.deployContract({ code, args, leaderOnly: false, ...feeArgs });
  pending = { hash };
  await writeFile(pendingPath, JSON.stringify(pending));
  console.log(`Deployment submitted: ${hash}`);
} else {
  console.log(`Tracking in-flight deployment: ${pending.hash}`);
}

const receipt = await waitFor(pending.hash, 'finalized');
await writeFile(new URL('../artifacts/deploy-receipt.json', import.meta.url), json(receipt));
const status = statusName(receipt);
const execution = executionName(receipt);
console.log(`Deployment status: ${status}, execution: ${execution}`);
if (status !== 'FINALIZED' || !['FINISHED_WITH_RETURN', 'SUCCESS'].includes(execution)) {
  throw new Error('Deployment did not finalize with a successful execution; see artifacts/deploy-receipt.json');
}
const address = receipt.data?.contract_address ?? receipt.to_address ?? receipt.recipient;
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) throw new Error('No contract address in the receipt.');

const version = await read(address, 'get_version');
const mandate = await readJson(address, 'get_mandate');
const budget = await readJson(address, 'get_budget');
if (version !== 'mandate-gate/1.0') throw new Error(`Unexpected version ${version}`);
if (mandate.mandate_text !== demo.mandateText || mandate.pool_id !== demo.poolId || mandate.pair !== demo.pair)
  throw new Error('Deployed configuration does not match config/demo.json');
if (budget.total_cap !== demo.totalCap || budget.per_proposal_cap !== demo.perProposalCap || budget.reserved !== 0)
  throw new Error('Deployed budget does not match config/demo.json');

const deployment = {
  network: 'studioDevnet',
  chainId: chain.id,
  rpc: chain.rpcUrls.default.http[0],
  contract: address,
  owner: mandate.owner,
  deployTransaction: pending.hash,
  deployedAt: new Date().toISOString(),
  runner: runner.replace(/^#\s*/, ''),
};
await writeFile(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2) + '\n');
await rm(pendingPath, { force: true });
console.log(`MandateGate deployed and verified: ${address}`);
console.log(`Contract: ${explorerAddress(address)}`);
console.log(`Deploy tx: ${explorerTx(pending.hash)}`);
