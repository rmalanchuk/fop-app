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
        const rate = data[0]?.rate || 41.5;
        console.log(`[LOG] Курс НБУ на ${yyyymmdd}: ${rate}`);
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
            
            let monthTotalUah = 0;

            if (Array.isArray(data)) {
                for (const t of data) {
                    if (t.amount > 0) {
                        const usdAmount = Math.abs(t.amount) / 100;
                        const rate = await getNbuRate(t.time);
                        const transactionUah = usdAmount * rate;
                        monthTotalUah += transactionUah;
                    }
                }
            }

            // Математичне заокруглення до сотих (напр. 31950.09)
            results[i] = Number((Math.round(monthTotalUah * 100) / 100).toFixed(2));
            console.log(`[RESULT] Місяць ${m+1}: ${results[i]} UAH`);

            if (i < 2) await new Promise(res => setTimeout(res, 61000));
        }
        res.json(results);
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
    } catch (e) {
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running'));