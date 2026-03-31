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

            const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
                headers: { 'X-Token': MONO_TOKEN }
            });

            if (r.status === 429) { results[i] = "limit"; continue; }
            const data = await r.json();

            // Логування першої транзакції для діагностики
            if (Array.isArray(data) && data.length > 0) {
                const t = data[0];
                console.log('Перша транзакція з Mono:', JSON.stringify({
                    amount: t.amount,
                    operationAmount: t.operationAmount,
                    currencyCode: t.currencyCode,
                    operationCurrencyCode: t.operationCurrencyCode,
                    time: new Date(t.time * 1000).toISOString()
                }));
            }
            
            let monthTotalUah = 0;

            if (Array.isArray(data)) {
                for (const t of data) {
                    if (t.amount > 0) {
                        const usdAmount = Math.abs(t.operationAmount) / 100;
                        const rate = await getNbuRate(t.time);
                        const transactionUah = usdAmount * rate;
                        monthTotalUah += transactionUah;
                        console.log(`Розрахунок: ${usdAmount} USD * ${rate} = ${transactionUah} UAH`);
                    }
                }
            }

            results[i] = Math.round(monthTotalUah * 100) / 100;

            if (i < 2) await new Promise(res => setTimeout(res, 61000));
        }
        res.json(results);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running'));
