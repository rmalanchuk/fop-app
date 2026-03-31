const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

const nbuRateCache = {};

// ✅ локальна дата без UTC бага
function formatDateLocal(timestamp) {
    const d = new Date(timestamp * 1000);
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
    ].join('');
}

async function getNbuRate(timestamp) {
    const yyyymmdd = formatDateLocal(timestamp);

    if (nbuRateCache[yyyymmdd]) return nbuRateCache[yyyymmdd];

    try {
        const response = await fetch(
            `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`
        );
        const data = await response.json();
        const rate = data[0]?.rate || 41.5;

        nbuRateCache[yyyymmdd] = rate;
        return rate;
    } catch {
        return 41.5;
    }
}

async function fetchMonoStatement(accountId, from, to) {
    const r = await fetch(
        `https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`,
        { headers: { 'X-Token': MONO_TOKEN } }
    );

    if (!r.ok) throw new Error(`Mono HTTP ${r.status}`);
    return r.json();
}

// ────────────────
// АККАУНТИ (ФОП)
// ────────────────
app.get('/accounts', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');

    const r = await fetch('https://api.monobank.ua/personal/client-info', {
        headers: { 'X-Token': MONO_TOKEN }
    });

    const data = await r.json();

    // ✅ тільки ФОП (без обмеження по валюті)
    const fopAccounts = (data.accounts || []).filter(a => a.type === 'fop');

    res.json(fopAccounts);
});

// ────────────────
// ДОХІД
// ────────────────
app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');

    const { accountId, year, quarter, months } = req.query;

    const monthsArray = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
    const quarterMonths = monthsArray[parseInt(quarter) - 1];

    const indicesToFetch = months
        ? months.split(',').map(Number)
        : [0,1,2];

    const results = {};

    try {
        for (let idx of indicesToFetch) {
            const m = quarterMonths[idx];

            const from = Math.floor(new Date(year, m, 1).getTime() / 1000);
            const to   = Math.floor(new Date(year, m + 1, 0, 23, 59, 59).getTime() / 1000);

            const data = await fetchMonoStatement(accountId, from, to);

            let monthTotalUah = 0;

            if (Array.isArray(data)) {

                // ✅ тільки надходження
                const incoming = data.filter(t => t.amount > 0);

                if (incoming.length > 0) {

                    // ✅ беремо найбільшу транзакцію
                    const mainTx = incoming.reduce((max, t) =>
                        Math.abs(t.amount) > Math.abs(max.amount) ? t : max
                    );

                    const amount = Math.abs(mainTx.amount) / 100;

                    // ✅ універсальна логіка валют
                    if (mainTx.currencyCode === 840) {
                        const rate = await getNbuRate(mainTx.time);
                        monthTotalUah = amount * rate;
                    } else if (mainTx.currencyCode === 980) {
                        monthTotalUah = amount;
                    } else {
                        const rate = await getNbuRate(mainTx.time);
                        monthTotalUah = amount * rate;
                    }
                }
            }

            results[idx] = Math.round(monthTotalUah * 100) / 100;
        }

        res.json(results);

    } catch (e) {
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
