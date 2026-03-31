const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// Мідлвар для перевірки ключа
function auth(req, res, next) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Отримати список рахунків
app.get('/accounts', auth, async (req, res) => {
    try {
        const r = await fetch('https://api.monobank.ua/personal/client-info', {
            headers: { 'X-Token': MONO_TOKEN }
        });
        const data = await r.json();
        
        if (!data.accounts) {
            return res.status(400).json({ error: data.errorDescription || 'Mono API Error' });
        }

        const accounts = data.accounts.map(a => ({
            id: a.id,
            currencyCode: a.currencyCode,
            type: a.type
        }));
        res.json(accounts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Отримати суму надходжень
app.get('/income', auth, async (req, res) => {
    const { accountId, from, to } = req.query;
    try {
        const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
            headers: { 'X-Token': MONO_TOKEN }
        });
        const data = await r.json();

        if (!Array.isArray(data)) {
            console.error('Mono Error:', data);
            return res.status(429).json({ error: 'Limit or Error' });
        }

        const totalInGryvnia = data
            .filter(t => t.amount > 0) // Тільки надходження
            .reduce((sum, t) => {
                // ЛОГІКА:
                // 1. Якщо валюта рахунку НЕ гривня (не 980), то сума в гривнях 
                // за курсом НБУ лежить в operationAmount.
                // 2. Якщо валюта рахунку гривня (980), беремо amount.
                
                let currentAmount;
                
                // Перевіряємо, чи є дані про конвертацію (operationAmount)
                if (t.operationAmount && t.currencyCode !== 980) {
                    currentAmount = Math.abs(t.operationAmount);
                } else {
                    currentAmount = Math.abs(t.amount);
                }

                return sum + currentAmount;
            }, 0) / 100;

        res.json({ total: totalInGryvnia });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
