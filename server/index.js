const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

const auth = (req, res, next) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

app.get('/quarter-income', auth, async (req, res) => {
    const { accountId, year, quarter } = req.query;
    const quarterMonths = [ [0,1,2], [3,4,5], [6,7,8], [9,10,11] ];
    const months = quarterMonths[parseInt(quarter) - 1];
    const results = {};

    try {
        for (let i = 0; i < months.length; i++) {
            const m = months[i];
            const from = Math.floor(new Date(year, m, 1, 0, 0, 0).getTime() / 1000);
            const to = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);

            console.log(`Запит для місяця ${m + 1}...`);
            
            const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
                headers: { 'X-Token': MONO_TOKEN }
            });

            if (r.status === 429) {
                results[i] = "limit";
                continue;
            }

            const data = await r.json();
            if (!Array.isArray(data)) {
                results[i] = 0;
                continue;
            }

            const monthTotal = data
                .filter(t => t.amount > 0)
                .reduce((sum, t) => {
                    // ПРІОРИТЕТ ГРИВНІ:
                    // Якщо в транзакції є operationAmount і він відрізняється від суми в валюті,
                    // значить це гривневий еквівалент. Беремо його.
                    let amountInGryvnia = Math.abs(t.amount);
                    
                    if (t.operationAmount && Math.abs(t.operationAmount) !== Math.abs(t.amount)) {
                        amountInGryvnia = Math.abs(t.operationAmount);
                    }
                    
                    return sum + amountInGryvnia;
                }, 0) / 100;

            results[i] = monthTotal;

            // Пауза між місяцями (крім останнього)
            if (i < 2) {
                console.log('Ліміт Mono API: чекаємо 61 сек...');
                await new Promise(res => setTimeout(res, 61000));
            }
        }
        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
