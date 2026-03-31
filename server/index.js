const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// Кеш курсів НБУ щоб не смикати API зайвий раз
const nbuRateCache = {};

async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');

    if (nbuRateCache[yyyymmdd]) return nbuRateCache[yyyymmdd];

    try {
        const response = await fetch(
            `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`
        );
        const data = await response.json();
        const rate = data[0]?.rate || 41.5;
        nbuRateCache[yyyymmdd] = rate;
        console.log(`Курс НБУ на ${yyyymmdd}: ${rate}`);
        return rate;
    } catch (e) {
        console.log(`Помилка НБУ для ${yyyymmdd}, fallback 41.5`);
        return 41.5;
    }
}

// Запит до Mono з автоматичним retry при 429
async function fetchMonoStatement(accountId, from, to, attempt = 1) {
    const r = await fetch(
        `https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`,
        { headers: { 'X-Token': MONO_TOKEN } }
    );

    if (r.status === 429) {
        if (attempt > 3) {
            console.log('Mono: забагато спроб, здаємось');
            return null;
        }
        const retryAfter = parseInt(r.headers.get('retry-after') || '61', 10);
        console.log(`Mono 429, чекаємо ${retryAfter}с (спроба ${attempt})`);
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return fetchMonoStatement(accountId, from, to, attempt + 1);
    }

    if (!r.ok) throw new Error(`Mono HTTP ${r.status}`);
    return r.json();
}

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

app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');

    const { accountId, year, quarter, months } = req.query;

    const monthsArray = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
    const quarterMonths = monthsArray[parseInt(quarter) - 1];

    // Якщо передано параметр months=0,2 — тягнемо тільки їх, інакше всі три
    const indicesToFetch = months
        ? months.split(',').map(Number)
        : [0, 1, 2];

    const results = {};

    try {
        for (let i = 0; i < indicesToFetch.length; i++) {
            const idx = indicesToFetch[i];
            const m = quarterMonths[idx];

            const from = Math.floor(new Date(year, m, 1).getTime() / 1000);
            const to   = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);

            console.log(`Запит місяць ${m + 1}/${year}...`);
            const data = await fetchMonoStatement(accountId, from, to);

            if (data === null) {
                results[idx] = "limit";
                continue;
            }

            let monthTotalUah = 0;

            if (Array.isArray(data)) {
                const incoming = data.filter(t => t.amount > 0);
                const rates = await Promise.all(incoming.map(t => getNbuRate(t.time)));

                incoming.forEach((t, j) => {
                    const usdAmount = Math.abs(t.operationAmount) / 100;
                    const rate = rates[j];
                    monthTotalUah += usdAmount * rate;
                    console.log(`${usdAmount} USD × ${rate} = ${usdAmount * rate} UAH`);
                });
            }

            results[idx] = Math.round(monthTotalUah * 100) / 100;

            // Пауза тільки між запитами (не після останнього)
            if (i < indicesToFetch.length - 1) {
                await new Promise(res => setTimeout(res, 1000));
            }
        }

        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
