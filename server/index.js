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
                    // НАЙБІЛЬШ НАДІЙНА ЛОГІКА ГРИВНІ:
                    // 1. Якщо валюта операції — гривня (980), беремо operationAmount.
                    // 2. Якщо operationAmount немає, але є звичайний amount — беремо його.
                    let amountInGryvnia = 0;
                    
                    if (t.operationCode === 980 || t.currencyCode === 980) {
                        // Якщо це транзакція в грн, беремо її суму
                        amountInGryvnia = Math.abs(t.amount);
                    } else if (t.operationAmount) {
                        // Якщо це валюта (USD), беремо гривневий еквівалент
                        amountInGryvnia = Math.abs(t.operationAmount);
                    } else {
                        // Резервний варіант
                        amountInGryvnia = Math.abs(t.amount);
                    }
                    
                    return sum + amountInGryvnia;
                }, 0) / 100;

            results[i] = monthTotal;

            if (i < 2) {
                console.log('Чекаємо 61 сек для наступного місяця...');
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