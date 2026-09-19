/** Read-only: quote a deploy and each MandateGate write on Studio Next. Signs and sends nothing. */
import { readFile } from 'node:fs/promises';
import { chain, demo, quote, describeFee, loadDeployment } from './lib.mjs';

const address = (await loadDeployment())?.contract ?? '0x0000000000000000000000000000000000000000';
const code = await readFile(new URL('../contracts/mandate_gate.py', import.meta.url), 'utf8');
const txs = [
  ['deploy', { kind: 'deploy', code, args: [], leaderOnly: false }],
  ['evaluate_proposal', { kind: 'write', address, method: 'evaluate_proposal', args: ['fee-probe', demo.pair, demo.poolId, 1000, 'Fee probe rationale text.', [demo.fixtures.active]] }],
  ['cancel_authorization', { kind: 'write', address, method: 'cancel_authorization', args: ['fee-probe'] }],
  ['transfer_ownership', { kind: 'write', address, method: 'transfer_ownership', args: [address] }],
];
console.log(`${chain.name} (chain ${chain.id})`);
for (const [label, tx] of txs) {
  try {
    const { estimate } = await quote(tx);
    console.log(`${label.padEnd(22)} ${describeFee(estimate)}`);
  } catch (error) {
    console.log(`${label.padEnd(22)} estimate failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
