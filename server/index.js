const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// Перевірка секретного ключа
function auth(req, res) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// Отримати список рахунків
app.get('/accounts', async (req, res) => {
    if (!auth(req, res)) return;
    const r = await fetch('https://api.monobank.ua/personal/client-info', {
        headers: { 'X-Token': MONO_TOKEN }
    });
    const data = await r.json();
    // Повертаємо тільки потрібні поля, без зайвого
    const accounts = data.accounts.map(a => ({
        id: a.id,
        currencyCode: a.currencyCode, // 980=UAH, 840=USD, 978=EUR
        type: a.type
    }));
    res.json(accounts);
});

// Отримати суму надходжень за місяць
app.get('/income', async (req, res) => {
    if (!auth(req, res)) return;
    const { accountId, from, to } = req.query;
    const r = await fetch(
        `https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`,
        { headers: { 'X-Token': MONO_TOKEN } }
    );
    const data = await r.json();
    // Тільки надходження (amount > 0), сума в копійках → гривні
    const total = data
        .filter(t => t.amount > 0)
        .reduce((sum, t) => sum + t.amount, 0) / 100;
    res.json({ total });
});

app.listen(3000, () => console.log('Running'));
