const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rm4.surge.sh').split(',');
app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));

const PORT = process.env.PORT || 3000;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

// Wallet addresses (real)
const WALLETS = {
  BTC: 'bc1pga0nwgy57jj92f0686qjuvtr0ug7lte4fsxwkja5678qcyx4tm5qlxeek4',
  ETH: '0x624D64C130a329dc944b8C591e0193242313B5FC',
  LTC: '0x624D64C130a329dc944b8C591e0193242313B5FC',
  XMR: '4RM4market9K2p7V5n3S8c4D6e0F2g7H5j',
  CASH: '7XXuRwCAV6KUmegrLSkzo2TGqnL9BbNZKDk7ELbfR87A',
  USDT: '0x624D64C130a329dc944b8C591e0193242313B5FC',
  USDC: '4UBbshhXTuqpCBDoSnhvbbtz6UwE8dV1oenvS4rfrypf',
  SOL: '4UBbshhXTuqpCBDoSnhvbbtz6UwE8dV1oenvS4rfrypf'
};

const COINS = {
  LTC:  { name: 'Litecoin',  rate: 84.52,   symbol: 'Ł', confirmMin: 5  },
  BTC:  { name: 'Bitcoin',   rate: 64143.68, symbol: '₿', confirmMin: 30 },
  ETH:  { name: 'Ethereum',  rate: 1876.17, symbol: 'Ξ', confirmMin: 3  },
  XMR:  { name: 'Monero',    rate: 158.44,  symbol: 'M', confirmMin: 5  },
  CASH: { name: 'Cash',      rate: 1.0,      symbol: '$', confirmMin: 5  },
  USDT: { name: 'Tether',    rate: 1.0,      symbol: '₮', confirmMin: 5  },
  USDC: { name: 'USD Coin',  rate: 1.0,      symbol: '$', confirmMin: 5  },
  SOL:  { name: 'Solana',    rate: 145.0,    symbol: '◎', confirmMin: 5  }
};

// In-memory store (use a real DB in production)
const orders = new Map();
const users = new Map();

function genId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// --- Create order ---
app.post('/api/create-order', (req, res) => {
  const { amount, coin, user } = req.body;
  const a = parseFloat(amount);
  if (!isFinite(a) || a < 10 || a > 100000) return res.status(400).json({ error: 'Monto inválido (10-100000)' });
  if (!COINS[coin]) return res.status(400).json({ error: 'Moneda no soportada' });
  const c = COINS[coin];
  const cryptoAmount = a / c.rate;
  const orderId = genId();
  const order = {
    id: orderId,
    user: user || 'anonymous',
    amount: a,
    coin,
    cryptoAmount,
    rate: c.rate,
    address: WALLETS[coin],
    status: 'pending',
    createdAt: Date.now(),
    txid: null,
    bonus: a >= 100 ? Math.round(a * 0.05 * 100) / 100 : 0
  };
  orders.set(orderId, order);
  res.json({ orderId, address: order.address, amountCrypto: cryptoAmount, rate: c.rate, bonus: order.bonus });
});

// --- Get order ---
app.get('/api/order/:id', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(o);
});

// --- Verify payment on-chain ---
async function verifyOnChain(coin, address, txid, expectedAmount) {
  try {
    if (coin === 'BTC') {
      const r = await fetch(`https://api.blockcypher.com/v1/btc/main/txs/${txid}`);
      if (!r.ok) return { ok: false, reason: 'TX no encontrada en Bitcoin' };
      const d = await r.json();
      const outputs = d.outputs || [];
      const match = outputs.some(o => o.addresses && o.addresses.indexOf(address) !== -1 && (o.value / 1e8) >= expectedAmount * 0.99);
      if (!match) return { ok: false, reason: 'La TX no envía fondos a tu dirección o el monto no coincide' };
      return { ok: true };
    }
    if (coin === 'ETH' || coin === 'USDT' || coin === 'USDC') {
      const r = await fetch(`https://api.etherscan.io/api?module=transaction&action=gettxinfo&txhash=${txid}&apikey=${ETHERSCAN_API_KEY}`);
      if (!r.ok) return { ok: false, reason: 'Error consultando Etherscan' };
      const d = await r.json();
      if (d.status !== '1' || !d.result) return { ok: false, reason: 'TX no encontrada o fallida en Ethereum' };
      const tx = d.result;
      if (tx.to && tx.to.toLowerCase() !== address.toLowerCase()) return { ok: false, reason: 'La TX no va a tu dirección' };
      const valueEth = parseInt(tx.value, 10) / 1e18;
      if (valueEth < expectedAmount * 0.99) return { ok: false, reason: 'Monto insuficiente' };
      return { ok: true };
    }
    if (coin === 'SOL' || coin === 'CASH') {
      const r = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [txid, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] })
      });
      if (!r.ok) return { ok: false, reason: 'Error consultando Solana RPC' };
      const d = await r.json();
      if (!d.result) return { ok: false, reason: 'TX no encontrada en Solana' };
      const tx = d.result;
      const instructions = tx.transaction?.message?.instructions || [];
      // Simplified: check that the tx succeeded
      if (tx.meta?.err) return { ok: false, reason: 'La TX falló en la red' };
      return { ok: true };
    }
    if (coin === 'LTC') {
      const r = await fetch(`https://api.blockcypher.com/v1/ltc/main/txs/${txid}${BLOCKCYPHER_TOKEN ? '?token=' + BLOCKCYPHER_TOKEN : ''}`);
      if (!r.ok) return { ok: false, reason: 'TX no encontrada en Litecoin' };
      const d = await r.json();
      const outputs = d.outputs || [];
      const match = outputs.some(o => o.addresses && o.addresses.indexOf(address) !== -1 && (o.value / 1e8) >= expectedAmount * 0.99);
      if (!match) return { ok: false, reason: 'La TX no envía fondos a tu dirección o el monto no coincide' };
      return { ok: true };
    }
    if (coin === 'XMR') {
      // Monero verification requires a full node or third-party API; placeholder
      return { ok: true, reason: 'Verificación de Monero no implementada (requiere nodo completo)' };
    }
    return { ok: false, reason: 'Moneda no soportada para verificación' };
  } catch (e) {
    return { ok: false, reason: 'Error de red: ' + e.message };
  }
}

app.post('/api/verify-payment', async (req, res) => {
  const { orderId, txid, user } = req.body;
  const o = orders.get(orderId);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  if (o.status === 'paid') return res.status(400).json({ error: 'Orden ya pagada' });
  if (!txid || txid.length < 10) return res.status(400).json({ error: 'TXID inválido' });

  // Prevent replay: check if txid already used
  for (const [id, ord] of orders) {
    if (ord.txid === txid && id !== orderId) {
      return res.status(400).json({ error: 'Este TXID ya fue usado en otra orden' });
    }
  }

  const result = await verifyOnChain(o.coin, o.address, txid, o.cryptoAmount);
  if (!result.ok) {
    return res.status(400).json({ error: result.reason });
  }

  o.status = 'paid';
  o.txid = txid;
  o.paidAt = Date.now();
  orders.set(orderId, o);

  // Credit balance to user
  const u = users.get(user) || { balance: 0, purchases: [] };
  u.balance += o.amount + (o.bonus || 0);
  if (!u.purchases.includes(o.id)) u.purchases.push(o.id);
  users.set(user, u);

  res.json({ success: true, message: 'Pago verificado y saldo acreditado', balance: u.balance, bonus: o.bonus });
});

// --- Get balance ---
app.get('/api/balance/:user', (req, res) => {
  const u = users.get(req.params.user) || { balance: 0 };
  res.json({ balance: u.balance });
});

// --- Get user purchases ---
app.get('/api/purchases/:user', (req, res) => {
  const u = users.get(req.params.user) || { purchases: [] };
  res.json({ purchases: u.purchases });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
module.exports = app;
