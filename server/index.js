const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// Функція для отримання курсу НБУ
async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    try {
        const r = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`);
        const data = await r.json();
        return data[0]?.rate || 41.5; 
    } catch (e) {
        return 41.5;
    }
}

app.get('/quarter-income', async (req, res) => {
    // Перевірка ключа
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');
    
    const { accountId, year, quarter } = req.query;
    const quarterMonths = [ [0,1,2], [3,4,5], [6,7,8], [9,10,11] ];
    const months = quarterMonths[parseInt(quarter) - 1];
    const results = {};

    try {
        for (let i = 0; i < months.length; i++) {
            const m = months[i];
            const from = Math.floor(new Date(year, m, 1).getTime() / 1000);
            const to = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);

            const response = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
                headers: { 'X-Token': MONO_TOKEN }
            });

            if (response.status === 429) {
                results[i] = "limit";
                continue;
            }

            const data = await response.json();
            let monthTotal = 0;

            if (Array.isArray(data)) {
                for (const t of data) {
                    if (t.amount > 0) {
                        // 1. Перетворюємо копійки в чисті долари (740.85)
                        const amountUsd = Math.abs(t.amount) / 100;
                        
                        // 2. Отримуємо курс НБУ
                        const rate = await getNbuRate(t.time);
                        
                        // 3. Множимо ОДИН РАЗ. 740.85 * 43.17 = 31987.09
                        monthTotal += (amountUsd * rate);
                    }
                }
            }

            // Відправляємо чисте число без жодних додаткових множень
            results[i] = parseFloat(monthTotal.toFixed(2));

            // Пауза 61 сек для Mono
            if (i < 2) await new Promise(resolve => setTimeout(resolve, 61000));
        }
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running'));