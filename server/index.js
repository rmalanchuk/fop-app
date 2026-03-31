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
    
    const startMonth = (q - 1) * 3;
    const from = Math.floor(new Date(year, startMonth, 1).getTime() / 1000);
    const to = Math.floor(new Date(year, startMonth + 3, 0, 23, 59, 59).getTime() / 1000);

    try {
        // 1. ОДИН запит до Моно
        const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
            headers: { 'X-Token': MONO_TOKEN }
        });

        if (r.status === 429) return res.status(429).json({ error: "limit" });
        const data = await r.json();
        if (!Array.isArray(data)) return res.json({ 0: 0, 1: 0, 2: 0 });

        const results = { 0: 0, 1: 0, 2: 0 };
        
        // 2. Збираємо всі унікальні дати для курсів НБУ, щоб не запитувати одне й те саме
        const incomeTransactions = data.filter(t => t.amount > 0);
        
        // 3. Паралельно отримуємо курси НБУ для всіх транзакцій (це ДУЖЕ швидко)
        const calculations = await Promise.all(incomeTransactions.map(async (t) => {
            const rate = await getNbuRate(t.time);
            const usdAmount = Math.abs(t.operationAmount) / 100;
            const tMonth = new Date(t.time * 1000).getMonth();
            const resultIndex = tMonth - startMonth;
            
            return {
                index: resultIndex,
                uah: usdAmount * rate
            };
        }));

        // 4. Сумуємо результати
        calculations.forEach(calc => {
            if (results[calc.index] !== undefined) {
                results[calc.index] += calc.uah;
            }
        });

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
