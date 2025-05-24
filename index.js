require('dotenv').config();
const express = require('express');
const axios = require('axios');

const crypto = require('crypto');
const processedRounds = new Set();
const app = express();
app.use(express.json());

const LOOTLOCKER_API_URL = 'https://api.lootlocker.io';
const LOOTLOCKER_VERSION = '2021-03-01';
const SERVER_API_KEY = process.env.SERVER_API_KEY;
const GAME_VERSION = process.env.GAME_VERSION || '1.0.0.0';
const GAME_ID = process.env.GAME_ID;
const CURRENCY_ID = process.env.CURRENCY_ID;

let authToken = null;

function verifySignature(payload, signature, secret) {
  const baseString = `${payload.wallet_id}:${payload.amount}:${payload.round_id}:${payload.timestamp}`;
  const hmac = crypto.createHmac('sha256', secret).update(baseString).digest('hex');
  return hmac === signature;
}

// Function to start a server session
async function getAuthToken() {
  if (authToken) return authToken;

  try {
    const response = await axios.post(
      `${LOOTLOCKER_API_URL}/server/session`,
      { game_version: GAME_VERSION },
      {
        headers: {
          'x-server-key': SERVER_API_KEY,
          'LL-Version': LOOTLOCKER_VERSION,
          'Content-Type': 'application/json',
        },
      }
    );

    authToken = response.data.token;    
    return authToken;
  } catch (error) {
    console.error('Failed to start server session:', error.response?.data || error.message);
    throw new Error('Could not get server token');
  }
}

// Send credit or debit request
async function updateBalance(amount, wallet_id) {
    async function sendRequest(token) {
        const endpoint = amount >= 0 ? 'credit' : 'debit';
        const absAmount = Math.abs(amount);

        return await axios.post(`${LOOTLOCKER_API_URL}/server/balances/${endpoint}`, {
            amount: absAmount.toString(),
            wallet_id,
            currency_id: CURRENCY_ID
        }, {
            headers: {
                'x-auth-token': token,
                'LL-Version': LOOTLOCKER_VERSION,
                'Content-Type': 'application/json'
            }
        });
    }

    try {
        if (!authToken) authToken = await getAuthToken();
        return (await sendRequest(authToken)).data;
    } catch (err) {
        if (err.response?.status === 401) {
            // Token expired, refresh and retry
            authToken = await getAuthToken();
            return (await sendRequest(authToken)).data;
        } else {
            throw err; // Propagate other errors
        }
    }
}

app.post('/credit-currency', async (req, res) => {
  const { wallet_id, amount, round_id, timestamp, signature } = req.body;
  console.log("received request");
  console.log(req.body);

  // Validate timestamp freshness
  const now = Math.floor(Date.now() / 1000); // Current time in seconds
  if (Math.abs(now - timestamp) > 30) {
    return res.status(408).json({ error: 'Request too old or too far in future' });
  }

  // Validate signature
  const payload = { wallet_id, amount, round_id, timestamp };
  if (!verifySignature(payload, signature, process.env.HMAC_SECRET)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Check for duplicate round
  const key = `${wallet_id}:${round_id}`;
  if (processedRounds.has(key)) {
    return res.status(409).json({ error: 'Round already processed' });
  }

  try {
        const result = await updateBalance(amount, wallet_id);
        processedRounds.add(key);
        res.json({ success: true });
    } catch (err) {
        console.error('LootLocker API Error:', err.response?.data || err.message);
        res.status(500).json({ error: 'LootLocker API request failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LootLocker Server API backend running on http://localhost:${PORT}`);
});