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
    } catch (e) { return 41.5; }
}

app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');
    
    const { accountId, year, quarter } = req.query;
    const q = parseInt(quarter);
    const y = parseInt(year);
    
    const startMonth = (q - 1) * 3;
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
            // Обробляємо транзакції
            for (const t of data) {
                if (t.amount > 0) {
                    const tDate = new Date(t.time * 1000);
                    const tMonth = tDate.getMonth();
                    const resultIndex = tMonth - startMonth;

                    const usdAmount = Math.abs(t.operationAmount) / 100;
                    const rate = await getNbuRate(t.time);
                    
                    if (results[resultIndex] !== undefined) {
                        results[resultIndex] += (usdAmount * rate);
                    }
                }
            }
        }

        results[0] = Number(results[0].toFixed(2));
        results[1] = Number(results[1].toFixed(2));
        results[2] = Number(results[2].toFixed(2));

        res.json(results);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server Live'));
