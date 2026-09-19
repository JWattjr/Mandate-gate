/** Injected EIP-1193 wallet discovery (EIP-6963 first, window.ethereum fallback) and network setup. */
export type BrowserProvider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  providers?: BrowserProvider[];
  isRabby?: boolean;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
};

export type WalletOption = { id: string; name: string; provider: BrowserProvider };

export type WalletNetwork = {
  id: number;
  name: string;
  rpcUrls: { default: { http: readonly string[] } };
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

declare global {
  interface Window {
    ethereum?: BrowserProvider;
  }
}

export function discoverWallets(target: Window, update: (wallets: WalletOption[]) => void) {
  const wallets: WalletOption[] = [];
  const add = (provider: BrowserProvider, id: string, name: string) => {
    if (!provider || typeof provider.request !== 'function') return;
    const existing = wallets.find((w) => w.provider === provider);
    if (existing) {
      if (id.startsWith('eip6963:')) Object.assign(existing, { id, name });
    } else {
      wallets.push({ id, name, provider });
    }
    update([...wallets]);
  };
  const legacy = () => {
    const injected = target.ethereum;
    const providers = injected?.providers?.length ? injected.providers : injected ? [injected] : [];
    providers.forEach((provider, index) => {
      const name = provider.isRabby
        ? 'Rabby'
        : provider.isCoinbaseWallet
          ? 'Coinbase Wallet'
          : provider.isMetaMask
            ? 'MetaMask'
            : 'Browser wallet';
      add(provider, `injected:${index}`, name);
    });
  };
  const announce = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail?.info?.uuid !== 'string' || typeof detail?.info?.name !== 'string') return;
    add(detail.provider, `eip6963:${detail.info.uuid.slice(0, 100)}`, detail.info.name.slice(0, 80));
  };
  target.addEventListener('eip6963:announceProvider', announce);
  target.addEventListener('ethereum#initialized', legacy);
  legacy();
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => {
    target.removeEventListener('eip6963:announceProvider', announce);
    target.removeEventListener('ethereum#initialized', legacy);
  };
}

export function chainMatches(value: unknown, id: number): boolean {
  try {
    return typeof value === 'string' && BigInt(value) === BigInt(id);
  } catch {
    return false;
  }
}

function unknownChain(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  const record = error as Record<string, unknown>;
  return (
    Number(record.code) === 4902 ||
    (record.data !== error && unknownChain(record.data, depth + 1)) ||
    (record.originalError !== error && unknownChain(record.originalError, depth + 1))
  );
}

export function firstAccount(accounts: unknown): string | null {
  const address = Array.isArray(accounts) ? accounts[0] : null;
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
}

export async function connect(provider: BrowserProvider): Promise<string> {
  const address = firstAccount(await provider.request({ method: 'eth_requestAccounts' }));
  if (!address) throw new Error('No wallet account is available. Unlock your wallet and try again.');
  return address;
}

export async function switchNetwork(provider: BrowserProvider, chain: WalletNetwork) {
  const chainId = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if (!unknownChain(error)) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: 'GenLayer Studio Next',
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
        },
      ],
    });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
}

/** Refuse to sign unless the wallet is still on the expected chain and account. */
export function guardedProvider(provider: BrowserProvider, chain: WalletNetwork, address: string): BrowserProvider {
  return {
    request: async (request) => {
      if (request.method === 'eth_sendTransaction' || request.method === 'eth_signTransaction') {
        if (!chainMatches(await provider.request({ method: 'eth_chainId' }), chain.id))
          throw new Error(`Switch your wallet to GenLayer Studio Next (chain ${chain.id}) before signing.`);
        const current = firstAccount(await provider.request({ method: 'eth_accounts' }));
        if (current?.toLowerCase() !== address.toLowerCase())
          throw new Error('The wallet account changed. Reconnect before sending.');
      }
      return provider.request(request);
    },
  };
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const code = Number(record.code);
    if (code === 4001) return 'The request was declined in your wallet.';
    if (code === -32002) return 'Your wallet already has a pending request. Open it and finish or cancel that request.';
    for (const key of ['shortMessage', 'details', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.split('\n')[0].slice(0, 400);
    }
  }
  return 'The action could not be completed.';
}
