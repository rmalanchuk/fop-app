const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '')));

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const CAR_DB_PATH = path.join(__dirname, 'car_db.json');

// ── Робота з базою авто ──
function getCarData() {
    if (!fs.existsSync(CAR_DB_PATH)) return { fuel: [], service: [], lastOdo: 0, lastPrice: 87.99 };
    try {
        return JSON.parse(fs.readFileSync(CAR_DB_PATH));
    } catch (e) {
        return { fuel: [], service: [], lastOdo: 0, lastPrice: 87.99 };
    }
}

function saveCarData(data) {
    fs.writeFileSync(CAR_DB_PATH, JSON.stringify(data, null, 2));
}

function auth(req, res) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        res.status(401).send('Unauthorized');
        return false;
    }
    return true;
}

// ── Логіка Telegram Бота ──
if (TELEGRAM_TOKEN) {
    const bot = new Telegraf(TELEGRAM_TOKEN);

    bot.on('text', async (ctx) => {
        let text = ctx.message.text.trim();
        const isTest = text.toLowerCase().startsWith('тест');
        
        if (isTest) {
            text = text.replace(/тест/i, '').trim();
        }

        const parts = text.split(/\s+/).map(p => p.replace(',', '.'));

        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            const amount = parseFloat(parts[0]);
            const odo = parseInt(parts[1]);
            const data = getCarData();
            
            let price = (parts.length >= 3 && !isNaN(parts[2])) 
                ? parseFloat(parts[2]) 
                : (data.lastPrice || 87.99);

            const liters = Math.round((amount / price) * 100) / 100;

            const entry = {
                date: new Date().toISOString(),
                amount,
                odo,
                liters,
                priceAtTime: price
            };

            if (!isTest) {
                data.fuel.push(entry);
                data.lastOdo = odo;
                data.lastPrice = price;
                saveCarData(data);
            }

            const prefix = isTest ? '🧪 **ТЕСТОВИЙ РЕЗУЛЬТАТ**' : '✅ **ЗАПИСАНО В БАЗУ**';

            ctx.replyWithMarkdown(
                `${prefix}\n\n` +
                `🚗 Машина: BMW X1\n` +
                `⛽️ Ціна: ${price} грн/л\n` +
                `💰 Сума: ${amount} грн\n` +
                `🛣 Пробіг: ${odo} км\n` +
                `⛽️ Літрів: ~${liters} л\n\n` +
                `${isTest ? '_Дані не було збережено._' : '_Дані успішно збережено._'}`
            );
        } else {
            ctx.reply('Формат: [Сума] [Пробіг] [Ціна (опційно)]\nПриклад: 2500 216000\nДля тесту: Тест 2500 216000');
        }
    });

    bot.launch().then(() => console.log('Telegram Bot started')).catch(err => console.error('Bot launch error:', err));
}

// ── Допоміжні функції Mono/NBU ──
const nbuRateCache = {};
async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    if (nbuRateCache[yyyymmdd]) return nbuRateCache[yyyymmdd];
    try {
        const r = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`);
        const data = await r.json();
        const rate = data[0]?.rate || 41.5;
        nbuRateCache[yyyymmdd] = rate;
        return rate;
    } catch (e) {
        return 41.5;
    }
}

async function fetchMonoStatement(accountId, from, to, attempt = 1) {
    const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, { headers: { 'X-Token': MONO_TOKEN } });
    if (r.status === 429) {
        if (attempt > 3) return null;
        const retryAfter = parseInt(r.headers.get('retry-after') || '61', 10);
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return fetchMonoStatement(accountId, from, to, attempt + 1);
    }
    if (!r.ok) throw new Error(`Mono HTTP ${r.status}`);
    return r.json();
}

async function calcIncome(transactions, currencyCode) {
    if (!Array.isArray(transactions)) return 0;
    const incoming = transactions.filter(t => t.amount > 0 && !(currencyCode === 980 && t.mcc === 4829));
    let total = 0;
    for (const t of incoming) {
        if (currencyCode === 980) {
            total += t.amount / 100;
        } else {
            const rate = await getNbuRate(t.time);
            total += (Math.abs(t.operationAmount) / 100) * rate;
        }
    }
    return total;
}

// ── API Endpoints ──
app.get('/accounts', async (req, res) => {
    if (!auth(req, res)) return;
    try {
        const r = await fetch('https://api.monobank.ua/personal/client-info', { headers: { 'X-Token': MONO_TOKEN } });
        const data = await r.json();
        res.json((data.accounts || []).map(a => ({ id: a.id, currencyCode: a.currencyCode, type: a.type })));
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/car-stats', async (req, res) => {
    if (!auth(req, res)) return;
    try {
        res.json(getCarData());
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/quarter-income', async (req, res) => {
    if (!auth(req, res)) return;
    const { year, quarter, months } = req.query;
    let accounts = JSON.parse(req.query.accounts);
    const monthsArray = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]];
    const quarterMonths = monthsArray[parseInt(quarter) - 1];
    const indicesToFetch = months ? months.split(',').map(Number) : [0, 1, 2];
    const results = {};
    try {
        for (let idx of indicesToFetch) {
            const m = quarterMonths[idx];
            const from = Math.floor(new Date(parseInt(year), m, 1).getTime() / 1000);
            const to = Math.floor(new Date(parseInt(year), m + 1, 0, 23, 59, 59).getTime() / 1000);
            let monthTotal = 0;
            for (const account of accounts) {
                const data = await fetchMonoStatement(account.id, from, to);
                if (data === null) { results[idx] = 'limit'; break; }
                monthTotal += await calcIncome(data, account.currencyCode);
                await new Promise(res => setTimeout(res, 1100));
            }
            if (results[idx] !== 'limit') results[idx] = Math.round(monthTotal * 100) / 100;
        }
        res.json(results);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/car', (req, res) => {
    res.sendFile(path.join(__dirname, 'car.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
