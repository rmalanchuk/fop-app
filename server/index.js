const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

function auth(req, res) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        res.status(401).send('Unauthorized');
        return false;
    }
    return true;
}

// ── Кеш курсів НБУ ──
const nbuRateCache = {};

async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    if (nbuRateCache[yyyymmdd]) return nbuRateCache[yyyymmdd];
    try {
        const r = await fetch(
            `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`
        );
        const data = await r.json();
        const rate = data[0]?.rate || 41.5;
        nbuRateCache[yyyymmdd] = rate;
        console.log(`НБУ ${yyyymmdd}: ${rate}`);
        return rate;
    } catch (e) {
        console.log(`НБУ помилка для ${yyyymmdd}, fallback 41.5`);
        return 41.5;
    }
}

// ── Запит до Mono з retry при 429 ──
async function fetchMonoStatement(accountId, from, to, attempt = 1) {
    const r = await fetch(
        `https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`,
        { headers: { 'X-Token': MONO_TOKEN } }
    );
    if (r.status === 429) {
        if (attempt > 3) { console.log('Mono: забагато спроб'); return null; }
        const retryAfter = parseInt(r.headers.get('retry-after') || '61', 10);
        console.log(`Mono 429, чекаємо ${retryAfter}с (спроба ${attempt})`);
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return fetchMonoStatement(accountId, from, to, attempt + 1);
    }
    if (!r.ok) throw new Error(`Mono HTTP ${r.status}`);
    return r.json();
}

// ── Порахувати дохід з масиву транзакцій ──
// UAH рахунок: amount > 0, ігноруємо mcc=4829 (внутрішні перекази "поповнення картки")
// USD рахунок: amount > 0, конвертуємо operationAmount по курсу НБУ
async function calcIncome(transactions, currencyCode) {
    if (!Array.isArray(transactions)) return 0;

    const incoming = transactions.filter(t => {
        if (t.amount <= 0) return false;
        if (currencyCode === 980 && t.mcc === 4829) return false; // UAH: ігноруємо перекази
        return true;
    });

    console.log(`  надходжень після фільтру: ${incoming.length}`);

    let total = 0;
    for (const t of incoming) {
        const dateStr = new Date(t.time * 1000).toISOString().slice(0, 10);
        if (currencyCode === 980) {
            const uah = t.amount / 100;
            console.log(`  UAH ${dateStr}: ${uah} ₴`);
            total += uah;
        } else {
            const foreignAmount = Math.abs(t.operationAmount) / 100;
            const rate = await getNbuRate(t.time);
            const uah = foreignAmount * rate;
            console.log(`  USD ${dateStr}: ${foreignAmount} × ${rate} = ${uah.toFixed(2)} ₴`);
            total += uah;
        }
    }
    return total;
}

// ── GET /accounts ──
app.get('/accounts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
        const r = await fetch('https://api.monobank.ua/personal/client-info', {
            headers: { 'X-Token': MONO_TOKEN }
        });
        const data = await r.json();
        const accounts = (data.accounts || []).map(a => ({
            id: a.id,
            currencyCode: a.currencyCode,
            type: a.type
        }));
        res.json(accounts);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ── GET /quarter-income ──
// accounts = JSON масив [{id, currencyCode}, ...]
// Для кожного місяця тягне дані з усіх рахунків і сумує
app.get('/quarter-income', async (req, res) => {
    if (!auth(req, res)) return;

    const { year, quarter, months } = req.query;
    let accounts;
    try {
        accounts = JSON.parse(req.query.accounts); // [{id, currencyCode}]
    } catch(e) {
        return res.status(400).send('Невірний формат accounts');
    }

    const monthsArray = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
    const quarterMonths = monthsArray[parseInt(quarter) - 1];
    const indicesToFetch = months ? months.split(',').map(Number) : [0, 1, 2];

    const results = {};

    try {
        for (let i = 0; i < indicesToFetch.length; i++) {
            const idx = indicesToFetch[i];
            const m = quarterMonths[idx];
            const from = Math.floor(new Date(parseInt(year), m, 1).getTime() / 1000);
            const to   = Math.floor(new Date(parseInt(year), m + 1, 0, 23, 59, 59).getTime() / 1000);

            console.log(`\n--- Місяць ${m + 1}/${year} ---`);
            let monthTotal = 0;

            for (const account of accounts) {
                console.log(` Рахунок ${account.id.slice(0,10)}… (currency: ${account.currencyCode})`);
                const data = await fetchMonoStatement(account.id, from, to);

                if (data === null) {
                    results[idx] = 'limit';
                    break;
                }

                console.log(` транзакцій всього: ${Array.isArray(data) ? data.length : 'помилка'}`);
                const income = await calcIncome(data, account.currencyCode);
                monthTotal += income;

                // Пауза між рахунками щоб не словити 429
                if (accounts.indexOf(account) < accounts.length - 1) {
                    await new Promise(res => setTimeout(res, 1100));
                }
            }

            if (results[idx] !== 'limit') {
                results[idx] = Math.round(monthTotal * 100) / 100;
                console.log(`Підсумок ${m + 1}/${year}: ${results[idx]} ₴`);
            }

            // Пауза між місяцями
            if (i < indicesToFetch.length - 1) {
                await new Promise(res => setTimeout(res, 1100));
            }
        }

        res.json(results);
    } catch (e) {
        console.error('Помилка:', e);
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
