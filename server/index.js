const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// Функція для отримання курсу НБУ на конкретну дату
async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    try {
        const response = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`);
        const data = await response.json();
        const rate = data[0]?.rate;
        if (rate) {
            console.log(`Курс НБУ на ${yyyymmdd}: ${rate}`);
            return rate;
        }
        return 41.0; // Дефолт, якщо НБУ не віддав дані
    } catch (e) {
        console.error('Помилка запиту до НБУ:', e);
        return 41.0; 
    }
}

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

            console.log(`Запит Mono: місяць ${m + 1}, акаунт ${accountId}`);
            
            const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
                headers: { 'X-Token': MONO_TOKEN }
            });

            if (r.status === 429) {
                console.log('Ліміт запитів Mono (429)');
                results[i] = "limit";
                continue;
            }

            const data = await r.json();
            if (!Array.isArray(data)) {
                results[i] = 0;
                continue;
            }

            let monthTotalUah = 0;
            
            for (const t of data) {
                // Беремо тільки поповнення (сума > 0)
                if (t.amount > 0) {
                    const amountInOriginalCurrency = Math.abs(t.amount) / 100;
                    
                    // Якщо валюта транзакції НЕ гривня (код 980)
                    if (t.currencyCode !== 980) {
                        const rate = await getNbuRate(t.time);
                        const converted = amountInOriginalCurrency * rate;
                        monthTotalUah += converted;
                        console.log(`Конвертація: ${amountInOriginalCurrency} USD * ${rate} = ${converted.toFixed(2)} UAH`);
                    } else {
                        // Якщо вже в гривні
                        monthTotalUah += amountInOriginalCurrency;
                    }
                }
            }

            // Округлюємо до 2 знаків для чистоти
            results[i] = parseFloat(monthTotalUah.toFixed(2));

            // Пауза 61 сек між місяцями для обходу лімітів Mono (1 запит на хвилину)
            if (i < months.length - 1) {
                console.log('Чекаємо 61 сек для наступного запиту...');
                await new Promise(res => setTimeout(res, 61000));
            }
        }
        res.json(results);
    } catch (e) {
        console.error('Критична помилка:', e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));