// Local test harness only. Announces an EIP-6963 "Dev wallet" backed by scripts/dev-wallet.mjs.
// It starts on Ethereum mainnet (0x1) so the wrong-network state can be exercised; the app's
// "Switch to Studio Next" button flips it via wallet_switchEthereumChain.
(() => {
  const listeners = {};
  let chainId = '0x1';
  const call = async (method, params) => {
    const res = await fetch('http://127.0.0.1:3999', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  const provider = {
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        chainId = params[0].chainId.toLowerCase();
        (listeners.chainChanged || []).forEach((l) => l(chainId));
        return null;
      }
      if (method === 'wallet_addEthereumChain') return null;
      if ((method === 'eth_sendTransaction' || method === 'eth_signTransaction') && chainId !== '0xf22d')
        throw Object.assign(new Error('Dev wallet is not on Studio Next'), { code: 4901 });
      return call(method, params);
    },
    on: (event, listener) => { (listeners[event] = listeners[event] || []).push(listener); },
    removeListener: (event, listener) => { listeners[event] = (listeners[event] || []).filter((l) => l !== listener); },
  };
  const info = { uuid: 'mandategate-dev-wallet', name: 'Dev wallet (test harness)', icon: 'data:,', rdns: 'local.devwallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return 'dev wallet announced';
})();
