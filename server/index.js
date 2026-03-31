const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    try {
        const response = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`);
        const data = await response.json();
        return data[0]?.rate || 41.5;
    } catch (e) {
        return 41.5;
    }
}

app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');

    const { accountId, year, quarter } = req.query;
    const q = parseInt(quarter);
    const y = parseInt(year);
    
    const startMonth = (q - 1) * 3;
    // Визначаємо межі кварталу для одного запиту
    const from = Math.floor(new Date(y, startMonth, 1).getTime() / 1000);
    const to = Math.floor(new Date(y, startMonth + 3, 0, 23, 59, 59).getTime() / 1000);

    try {
        const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
            headers: { 'X-Token': MONO_TOKEN }
        });

        if (r.status === 429) return res.status(429).json({ error: "limit" });
        const data = await r.json();

        const results = { 0: 0, 1: 0, 2: 0 };

        if (Array.isArray(data)) {
            // Отримуємо курси паралельно, щоб не чекати по черзі
            await Promise.all(data.map(async (t) => {
                if (t.amount > 0) {
                    const tDate = new Date(t.time * 1000);
                    const tMonth = tDate.getMonth();
                    const resultIndex = tMonth - startMonth; // 0, 1 або 2 місяць кварталу

                    const usdAmount = Math.abs(t.operationAmount) / 100;
                    const rate = await getNbuRate(t.time);
                    const transactionUah = usdAmount * rate;

                    if (results[resultIndex] !== undefined) {
                        results[resultIndex] += transactionUah;
                    }
                }
            }));
        }

        // Округлення до копійок
        res.json({
            0: Math.round(results[0] * 100) / 100,
            1: Math.round(results[1] * 100) / 100,
            2: Math.round(results[2] * 100) / 100
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/accounts', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');
    try {
        const r = await fetch('https://api.monobank.ua/personal/client-info', {
            headers: { 'X-Token': MONO_TOKEN }
        });
        const data = await r.json();
        res.json(data.accounts || []);
    } catch (e) { res.status(500).send(e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running'));
