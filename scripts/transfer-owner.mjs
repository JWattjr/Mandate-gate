/**
 * Hand MandateGate ownership to another address (for example your own wallet,
 * so the frontend's owner-only Cancel control works for you).
 *
 *   npm run owner:transfer -- 0xYourWalletAddress
 *
 * Signs with whichever local key (.keys/deployer.key or .keys/dev-wallet.key)
 * currently owns the contract. Waits for FINALIZED and reads the owner back.
 */
import { readFile } from 'node:fs/promises';
import { createClient, createAccount } from 'genlayer-js';
import {
  chain, deployerAccount, ensureFunded, quote, statusName, executionName, waitFor, readJson, loadDeployment, explorerTx,
} from './lib.mjs';

const target = process.argv[2]?.trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(target ?? '')) throw new Error('Usage: npm run owner:transfer -- 0xNewOwnerAddress');
const deployment = await loadDeployment();
if (!deployment?.contract) throw new Error('No deployment in lib/deployment.json.');
const address = deployment.contract;
const { owner } = await readJson(address, 'get_mandate');
if (owner.toLowerCase() === target.toLowerCase()) {
  console.log(`${target} already owns ${address}.`);
  process.exit(0);
}

const candidates = [await deployerAccount()];
try {
  candidates.push(createAccount((await readFile(new URL('../.keys/dev-wallet.key', import.meta.url), 'utf8')).trim()));
} catch {
  /* no dev wallet key */
}
const account = candidates.find((a) => a.address.toLowerCase() === owner.toLowerCase());
if (!account) throw new Error(`The current owner ${owner} is not a key held in .keys/. Ask that wallet to call transfer_ownership.`);
await ensureFunded(account.address);

const client = createClient({ chain, account });
const args = [target];
const { feeArgs } = await quote({ kind: 'write', address, method: 'transfer_ownership', args });
const hash = await client.writeContract({ address, functionName: 'transfer_ownership', args, value: 0n, leaderOnly: false, ...feeArgs });
console.log(`Submitted ${explorerTx(hash)}`);
const receipt = await waitFor(hash, 'finalized');
const after = (await readJson(address, 'get_mandate')).owner;
console.log(`${statusName(receipt)} / ${executionName(receipt)} / owner is now ${after}`);
if (after.toLowerCase() !== target.toLowerCase()) process.exitCode = 1;
