const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// ── Кеш курсів НБУ (в пам'яті, скидається при рестарті сервера) ──
const nbuRateCache = {};

async function getNbuRate(dateStr) {
    // dateStr = 'YYYYMMDD'
    if (nbuRateCache[dateStr]) return nbuRateCache[dateStr];
    try {
        const r = await fetch(
            `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${dateStr}&json`
        );
        const data = await r.json();
        const rate = data[0]?.rate;
        if (!rate) throw new Error('no rate');
        nbuRateCache[dateStr] = rate;
        console.log(`НБУ курс на ${dateStr}: ${rate}`);
        return rate;
    } catch (e) {
        console.log(`НБУ помилка для ${dateStr}, fallback 41.5`);
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
        if (attempt > 3) return null;
        const wait = parseInt(r.headers.get('retry-after') || '61', 10);
        console.log(`Mono 429, чекаємо ${wait}с (спроба ${attempt})`);
        await new Promise(res => setTimeout(res, wait * 1000));
        return fetchMonoStatement(accountId, from, to, attempt + 1);
    }
    if (!r.ok) throw new Error(`Mono HTTP ${r.status}`);
    return r.json();
}

// ── Авторизація ──
function auth(req, res) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// ── Список рахунків ──
app.get('/accounts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
        const r = await fetch('https://api.monobank.ua/personal/client-info', {
            headers: { 'X-Token': MONO_TOKEN }
        });
        const data = await r.json();
        // Повертаємо всі рахунки з типом — фронтенд показує [ФОП] мітку
        const accounts = (data.accounts || []).map(a => ({
            id: a.id,
            currencyCode: a.currencyCode, // 980=UAH, 840=USD, 978=EUR
            type: a.type                  // 'fop', 'black', 'white' і т.д.
        }));
        res.json(accounts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Дохід за квартал ──
// Логіка:
//   - фільтруємо ЛИШЕ надходження: amount > 0 (це гривнева сума від Mono)
//   - для UAH рахунку (currencyCode=980): amount / 100 = гривні, курс не потрібен
//   - для USD/EUR рахунку: operationAmount / 100 = сума у валюті,
//     множимо на курс НБУ на дату транзакції
//   - курс тягнемо ОДИН раз на транзакцію (по даті надходження)
app.get('/quarter-income', async (req, res) => {
    if (!auth(req, res)) return;

    const { accountId, year, quarter, months, currencyCode } = req.query;
    const currency = parseInt(currencyCode || '980');

    const monthsArray = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
    const quarterMonths = monthsArray[parseInt(quarter) - 1];

    // months=0,1,2 або підмножина типу 0,2
    const indicesToFetch = months
        ? months.split(',').map(Number)
        : [0, 1, 2];

    const results = {};

    try {
        for (let i = 0; i < indicesToFetch.length; i++) {
            const idx = indicesToFetch[i];
            const m = quarterMonths[idx]; // 0-based місяць року

            const from = Math.floor(new Date(parseInt(year), m, 1).getTime() / 1000);
            const to   = Math.floor(new Date(parseInt(year), m + 1, 0, 23, 59, 59).getTime() / 1000);

            console.log(`\nЗапит місяць ${m + 1}/${year} (currency: ${currency})...`);

            const data = await fetchMonoStatement(accountId, from, to);
            if (data === null) {
                results[idx] = 'limit';
                continue;
            }

            if (!Array.isArray(data)) {
                console.log('Mono повернув не масив:', data);
                results[idx] = 0;
                continue;
            }

            // Тільки надходження
            const incoming = data.filter(t => t.amount > 0);
            console.log(`Знайдено ${incoming.length} надходжень (з ${data.length} транзакцій)`);

            let monthTotal = 0;

            for (const t of incoming) {
                const date = new Date(t.time * 1000);
                const dateStr = date.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD

                if (currency === 980) {
                    // UAH рахунок: amount вже в копійках гривні
                    const uah = t.amount / 100;
                    console.log(`  UAH надходження: ${uah} ₴ (${dateStr})`);
                    monthTotal += uah;
                } else {
                    // Валютний рахунок: operationAmount — сума у валюті (копійки)
                    // amount — еквівалент у гривні від Mono (за їх курсом, НАМ НЕ ПОТРІБЕН)
                    // Нам потрібен курс НБУ на дату надходження
                    const foreignAmount = t.operationAmount / 100; // USD або EUR
                    const rate = await getNbuRate(dateStr);
                    const uah = foreignAmount * rate;
                    console.log(`  Валютне надходження: ${foreignAmount} (код ${currency}) × ${rate} = ${uah.toFixed(2)} ₴ (${dateStr})`);
                    monthTotal += uah;
                }
            }

            results[idx] = Math.round(monthTotal * 100) / 100;
            console.log(`Підсумок місяць ${m + 1}: ${results[idx]} ₴`);

            // Пауза між запитами до Mono (крім останнього)
            if (i < indicesToFetch.length - 1) {
                await new Promise(res => setTimeout(res, 1100));
            }
        }

        res.json(results);
    } catch (e) {
        console.error('Помилка:', e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
