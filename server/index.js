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

        if (!Array.isArray(data)) return res.json({ total: 0 });

        const total = data
            .filter(t => t.amount > 0) // Беремо тільки надходження
            .reduce((sum, t) => {
                // Якщо рахунок валютний (USD/EUR), Mono віддає гривневий еквівалент 
                // у полі operationAmount, якщо транзакція була маркована валютою 980 (UAH) 
                // або через внутрішню конвертацію.
                
                // Для валютних входів (як твій SWIFT), поле operationAmount зазвичай 
                // містить суму в гривнях, якщо запит іде до гривневого представлення.
                // Але на практиці для ФОП-валюти ідеальним є поле:
                const realAmount = (t.currencyCode === 980) ? t.amount : Math.abs(t.operationAmount);
                
                return sum + realAmount;
            }, 0) / 100;

        res.json({ total });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
