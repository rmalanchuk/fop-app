const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// 1. Тягнемо курс на конкретну дату з НБУ
async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    try {
        const response = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`);
        const data = await response.json();
        // Беремо точний курс (напр. 43.1925)
        const rate = data[0]?.rate || 41.5;
        console.log(`Курс НБУ на ${yyyymmdd}: ${rate}`);
        return rate;
    } catch (e) {
        return 41.5;
    }
}

app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');
    
    const { accountId, year, quarter } = req.query;
    const monthsArray = [ [0,1,2], [3,4,5], [6,7,8], [9,10,11] ];
    const months = monthsArray[parseInt(quarter) - 1];
    const results = {};

    try {
        for (let i = 0; i < months.length; i++) {
            const m = months[i];
            const from = Math.floor(new Date(year, m, 1).getTime() / 1000);
            const to = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);

            // 2. Тягнемо дані з Моно
            const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
                headers: { 'X-Token': MONO_TOKEN }
            });

            if (r.status === 429) { results[i] = "limit"; continue; }
            const data = await r.json();
            
            let monthTotalUah = 0;

            if (Array.isArray(data)) {
                for (const t of data) {
                    if (t.amount > 0) {
                        // 3. Ділимо на 100, щоб отримати долари (напр. 740.85)
                        const usdAmount = Math.abs(t.amount) / 100;
                        
                        // 4. Тягнемо курс НБУ на дату транзакції
                        const rate = await getNbuRate(t.time);
                        
                        // 5. Множимо долари на курс
                        const transactionUah = usdAmount * rate;
                        
                        monthTotalUah += transactionUah;
                        console.log(`Розрахунок: ${usdAmount} USD * ${rate} = ${transactionUah} UAH`);
                    }
                }
            }

            // 6. Математичне заокруглення до сотих (31950.09)
            results[i] = Math.round(monthTotalUah * 100) / 100;

            // Пауза 61 сек для лімітів Mono
            if (i < 2) await new Promise(res => setTimeout(res, 61000));
        }
        res.json(results);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running'));