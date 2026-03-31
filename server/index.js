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
        
        if (r.status === 429) return res.status(429).json({ error: 'Limit' });
        const data = await r.json();
        if (!Array.isArray(data)) return res.json({ total: 0 });

        const total = data
            .filter(t => t.amount > 0)
            .reduce((sum, t) => {
                // Вибираємо саме гривню. Для $740.85 це буде ~31987.09 грн
                const val = (t.operationAmount && Math.abs(t.operationAmount) !== Math.abs(t.amount)) 
                    ? Math.abs(t.operationAmount) 
                    : Math.abs(t.amount);
                return sum + val;
            }, 0) / 100;

        res.json({ total });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
