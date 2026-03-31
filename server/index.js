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
        return data[0]?.rate || 41.0;
    } catch (e) {
        return 41.0;
    }
}

app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
    
    const { accountId, year, quarter } = req.query;
    const months = [ [0,1,2], [3,4,5], [6,7,8], [9,10,11] ][parseInt(quarter) - 1];
    const results = {};

    try {
        for (let i = 0; i < months.length; i++) {
            const m = months[i];
            const from = Math.floor(new Date(year, m, 1).getTime() / 1000);
            const to = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);

            const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
                headers: { 'X-Token': MONO_TOKEN }
            });

            if (r.status === 429) { results[i] = "limit"; continue; }
            const data = await r.json();
            
            let monthSumUah = 0; // Скидаємо суму для кожного місяця!

            if (Array.isArray(data)) {
                for (const t of data) {
                    if (t.amount > 0) {
                        const rate = await getNbuRate(t.time);
                        // ФОРМУЛА: (Копійки з Моно * Курс НБУ) / 100
                        const calc = (Math.abs(t.amount) * rate) / 100;
                        monthSumUah += calc;
                        console.log(`Місяць ${m+1}: Транзакція ${t.amount} коп * курс ${rate} / 100 = ${calc} грн`);
                    }
                }
            }

            results[i] = parseFloat(monthSumUah.toFixed(2));

            if (i < 2) await new Promise(res => setTimeout(res, 61000));
        }
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is Live'));