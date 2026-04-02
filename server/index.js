const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Telegraf, Scenes, session } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '')));

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { Telegraf, Scenes, session } = require('telegraf'); // Оновив деструктуризацію

// Нові токени та ID
const FINANCE_TOKEN = process.env.TELEGRAM_FINANCE_TOKEN;
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id)) : [];

// Константи категорій згідно з твоєю логікою
const CATEGORIES = {
    EXPENSES: ['Продукти', 'Медицина', 'Розваги', 'Одяг', 'Машина', 'Квартира', 'Податки', 'Кредити', 'Інше'],
    INCOME: ['Школа', 'Хелен Дорон', 'Лангейт', 'Інше'],
    SAVINGS: ['Гривні', 'Долари', 'Євро']
};

const CAR_DB_PATH = path.join(__dirname, 'car_db.json');

// ── Робота з базою авто ──
async function getCarData() {
    const { data, error } = await supabase
        .from('car_stats')
        .select('*')
        .order('date', { ascending: true });

    if (error) {
        console.error('Supabase fetch error:', error);
        return { fuel: [], lastOdo: 0, lastPrice: 87.99 };
    }

    const lastOdo = data && data.length > 0 ? Math.max(...data.map(d => d.odo)) : 0;
    // Використовуємо назву поля точно як у базі — priceattime
    const lastPrice = data && data.length > 0 ? data[data.length - 1].priceattime : 87.99;

    return { fuel: data || [], lastOdo, lastPrice };
}

async function saveCarData(entry) {
    const dbEntry = {
        date: entry.date,
        amount: entry.amount,
        odo: entry.odo,
        liters: entry.liters,
        priceattime: entry.priceAtTime // Мапимо JS-об'єкт на колонку priceattime
    };

    const { error } = await supabase
        .from('car_stats')
        .insert([dbEntry]);

    if (error) {
        console.error('Supabase insert error:', error);
    }
}

async function saveMaintenanceData(entry) {
    const dbEntry = {
        date: entry.date,
        odo: entry.odo,
        description: entry.description,
        cost: entry.cost,
        type: entry.type || 'Ремонт'
    };

    const { error } = await supabase
        .from('car_maintenance')
        .insert([dbEntry]);

    if (error) console.error('Supabase maintenance insert error:', error);
}

// ── Логіка Telegram Бота ──
if (TELEGRAM_TOKEN) {
    const bot = new Telegraf(TELEGRAM_TOKEN);

    // Створюємо постійну кнопку під полем вводу
    const mainKeyboard = {
        reply_markup: {
            keyboard: [
                [{ text: '⛽️ Остання ціна' }]
            ],
            resize_keyboard: true // Робить кнопку компактною
        }
    };

    bot.telegram.setMyCommands([
        { command: 'price', description: 'Дізнатися останню ціну палива' },
        { command: 'service', description: 'Записати ремонт/ТО' },
        { command: 'start', description: 'Запустити бота' }
    ]);

    // Обробка старту (щоб з'явилася кнопка)
    bot.start((ctx) => ctx.reply('Вітаю! Я готовий записувати витрати твого BMW X1.', mainKeyboard));

    // Функція-помічник для виводу ціни (щоб не дублювати код)
    const sendLastPrice = async (ctx) => {
        try {
            const data = await getCarData();
            const lastPrice = data.lastPrice || 87.99;
            ctx.replyWithMarkdown(
                `⛽️ **Остання ціна в базі:**\n` +
                `${lastPrice} грн/л\n\n` +
                `_Це значення буде використано автоматично, якщо не вказати ціну при записі._`,
                mainKeyboard
            );
        } catch (e) {
            ctx.reply('Не вдалося отримати ціну з бази.', mainKeyboard);
        }
    };

    // Слухаємо і команду, і натискання кнопки
    bot.command('price', sendLastPrice);
    bot.hears('⛽️ Остання ціна', sendLastPrice);

    bot.command('service', async (ctx) => {
        const messageText = ctx.message.text.replace('/service', '').trim();
        
        // Шукаємо всі числа в тексті (враховуємо кому та крапку)
        const numbers = messageText.match(/(\d+[.,]\d+|\d+)/g);
    
        if (numbers && numbers.length >= 2) {
            // Перше число — сума, друге — пробіг
            const cost = parseFloat(numbers[0].replace(',', '.'));
            const odo = parseInt(numbers[1]);
    
            // Весь інший текст, який не є цими двома числами, стає описом
            let description = messageText
                .replace(numbers[0], '')
                .replace(numbers[1], '')
                .trim()
                .replace(/\s+/g, ' '); // прибираємо зайві пробіли
    
            // Якщо раптом опису немає, дамо дефолтний
            if (!description) description = "Ремонт/Обслуговування";
    
            const entry = {
                date: new Date().toISOString().split('T')[0],
                odo,
                description,
                cost,
                type: 'Ремонт'
            };
    
            try {
                await saveMaintenanceData(entry);
                ctx.replyWithMarkdown(
                    `🛠 **СЕРВІС ЗАПИСАНО**\n\n` +
                    `🔧 Що: ${description}\n` +
                    `🛣 Пробіг: ${odo} км\n` +
                    `💰 Вартість: ${cost} грн`,
                    mainKeyboard
                );
            } catch (e) {
                ctx.reply('Помилка збереження в Supabase', mainKeyboard);
            }
        } else {
            ctx.reply('Формат вводу вільний, але вкажіть хоча б два числа (суму та пробіг).\nПриклад: Заміна сайлентблоків 4500 218000', mainKeyboard);
        }
    });
    
    bot.on('text', async (ctx) => {
        let text = ctx.message.text.trim();
        
        // 1. Ігноруємо натискання кнопки ціни
        if (text === '⛽️ Остання ціна') return;

        // 2. Визначаємо, чи це СЕРВІС (якщо в тексті є хоча б 2 літери підряд: ТО, Мастило, Мийка)
        const hasLetters = /[а-яА-Яa-zA-ZіІєЄїЇґҐ]{2,}/.test(text);

        if (hasLetters) {
            // --- ЛОГІКА СЕРВІСУ ---
            // Шукаємо всі числа (ціна та пробіг)
            const numbers = text.match(/(\d+[.,]\d+|\d+)/g);

            if (numbers && numbers.length >= 2) {
                const cost = parseFloat(numbers[0].replace(',', '.'));
                const odo = parseInt(numbers[1]);
                
                // Опис — це весь текст без цих двох чисел
                let description = text
                    .replace(numbers[0], '')
                    .replace(numbers[1], '')
                    .trim()
                    .replace(/\s+/g, ' ');

                if (!description) description = "Технічне обслуговування";

                const entry = {
                    date: new Date().toISOString().split('T')[0],
                    odo,
                    description,
                    cost,
                    type: 'Ремонт'
                };

                try {
                    await saveMaintenanceData(entry);
                    return ctx.replyWithMarkdown(
                        `🛠 **СЕРВІС ЗАПИСАНО**\n\n` +
                        `🔧 Що: ${description}\n` +
                        `🛣 Пробіг: ${odo} км\n` +
                        `💰 Вартість: ${cost} грн`,
                        mainKeyboard
                    );
                } catch (e) {
                    return ctx.reply('Помилка при збереженні сервісу в базу.', mainKeyboard);
                }
            }
        }

        // --- ЛОГІКА ЗАПРАВКИ (якщо тільки цифри) ---
        const isTest = text.toLowerCase().startsWith('тест');
        if (isTest) text = text.replace(/тест/i, '').trim();

        const parts = text.split(/\s+/).map(p => p.replace(',', '.'));

        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            const amount = parseFloat(parts[0]);
            const odo = parseInt(parts[1]);
            
            try {
                const data = await getCarData();
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
                    await saveCarData(entry); 
                }

                const prefix = isTest ? '🧪 **ТЕСТОВИЙ РЕЗУЛЬТАТ**' : '✅ **ЗАПИСАНО В БАЗУ**';

                ctx.replyWithMarkdown(
                    `${prefix}\n\n` +
                    `🚗 Машина: BMW X1\n` +
                    `⛽️ Ціна: ${price} грн/л\n` +
                    `💰 Сума: ${amount} грн\n` +
                    `🛣 Пробіг: ${odo} км\n` +
                    `⛽️ Літрів: ~${liters} л\n\n` +
                    `${isTest ? '_Дані не збережено._' : '_Дані в Supabase._'}`,
                    mainKeyboard
                );
            } catch (e) {
                ctx.reply('Помилка при отриманні ціни або збереженні заправки.', mainKeyboard);
            }
        } else {
            // Якщо текст не підійшов ні під сервіс, ні під заправку
            ctx.reply(
                'Не зрозумів формат 🤔\n\n' +
                '⛽️ **Заправка:** [Сума] [Пробіг]\n' +
                'Приклад: `2500 216000`\n\n' +
                '🛠 **Сервіс:** [Опис] [Сума] [Пробіг]\n' +
                'Приклад: `ТО 4500 218000` або `Заміна мастила 4000 218000`',
                mainKeyboard
            );
        }
    });

    bot.launch()
        .then(() => console.log('Telegram Bot started with Supabase and Keyboard support'))
        .catch(err => console.error('Bot launch error:', err));
}

if (FINANCE_TOKEN) {
    const finBot = new Telegraf(FINANCE_TOKEN);

    // --- 1. Middleware Безпеки ---
    finBot.use((ctx, next) => {
        if (ctx.from && ALLOWED_USERS.includes(ctx.from.id)) return next();
        console.log(`Unauthorized access: ${ctx.from?.id}`);
    });

    finBot.use(session());

    // --- 2. Сцени для покрокового вводу ---
    const financeScene = new Scenes.WizardScene(
        'ADD_TRANSACTION_SCENE',
        // Крок 1: Вибір категорії (вже зроблено кнопкою, тут просто чекаємо суму)
        async (ctx) => {
            const category = ctx.message.text;
            ctx.scene.session.state.category = category;
            
            // Визначаємо тип на основі категорії
            if (CATEGORIES.INCOME.includes(category)) ctx.scene.session.state.type = 'Доходи';
            else if (CATEGORIES.SAVINGS.includes(category)) ctx.scene.session.state.type = 'Заощадження';
            else ctx.scene.session.state.type = 'Витрати';

            await ctx.reply(`Обрано категорію: ${category}. Введіть суму:`, {
                reply_markup: { keyboard: [[{ text: '⬅️ Назад' }]], resize_keyboard: true }
            });
            return ctx.wizard.next();
        },
        // Крок 2: Отримання суми та запис
        async (ctx) => {
            if (ctx.message.text === '⬅️ Назад') {
                await ctx.scene.leave();
                return showMainMenu(ctx);
            }

            const amount = parseFloat(ctx.message.text.replace(',', '.'));
            if (isNaN(amount)) return ctx.reply('Будь ласка, введіть числове значення суми:');

            const { category, type } = ctx.scene.session.state;

            try {
                await supabase.from('family_finances').insert([{
                    user_id: ctx.from.id,
                    type: type,
                    category: category,
                    amount: amount,
                    currency: 'UAH' // Дефолт для звичайних витрат
                }]);
                await ctx.reply(`✅ Записано: ${type} -> ${category}: ${amount} грн`);
            } catch (e) {
                ctx.reply('❌ Помилка запису в базу.');
            }
            return ctx.scene.leave();
        }
    );

    const stage = new Scenes.Stage([financeScene]);
    finBot.use(stage.middleware());

    // --- 3. Головне Меню ---
    const showMainMenu = (ctx) => {
        return ctx.reply('Оберіть дію:', {
            reply_markup: {
                keyboard: [
                    ['💸 Витрати', '💰 Доходи'],
                    ['🏦 Заощадження', '📉 Витрата з заощаджень'],
                    ['🔙 Скасувати останній запис', '❓ Довідка']
                ],
                resize_keyboard: true
            }
        });
    };

    finBot.start((ctx) => showMainMenu(ctx));

    // Обробка кнопок категорій
    finBot.hears('💸 Витрати', (ctx) => {
        const buttons = CATEGORIES.EXPENSES.map(c => [{ text: c }]);
        buttons.push([{ text: '⬅️ Назад' }]);
        ctx.reply('Оберіть категорію витрат:', { reply_markup: { keyboard: buttons, resize_keyboard: true } });
    });

    finBot.hears('💰 Доходи', (ctx) => {
        const buttons = CATEGORIES.INCOME.map(c => [{ text: c }]);
        buttons.push([{ text: '⬅️ Назад' }]);
        ctx.reply('Оберіть джерело доходу:', { reply_markup: { keyboard: buttons, resize_keyboard: true } });
    });

    finBot.hears('⬅️ Назад', (ctx) => showMainMenu(ctx));

    // Запуск сцени при виборі конкретної категорії
    const allCats = [...CATEGORIES.EXPENSES, ...CATEGORIES.INCOME, ...CATEGORIES.SAVINGS];
    finBot.hears(allCats, (ctx) => ctx.scene.enter('ADD_TRANSACTION_SCENE'));

    // --- 4. Швидкий текстовий ввід (Пункт 3-А) ---
    finBot.on('text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        const match = text.match(/^([А-Яа-яіІєЄґҐa-zA-Z]+)\s+(\d+(?:[.,]\d+)?)$/u);
        if (!match) return next();

        let [_, catInput, amountStr] = match;
        const amount = parseFloat(amountStr.replace(',', '.'));
        const category = CATEGORIES.EXPENSES.find(c => c.toLowerCase() === catInput.toLowerCase());

        if (!category) return ctx.reply(`⚠️ Категорія "${catInput}" не знайдена.`);

        await supabase.from('family_finances').insert([{
            user_id: ctx.from.id, type: 'Витрати', category, amount, currency: 'UAH'
        }]);
        ctx.reply(`✅ Швидкий запис: ${category} ${amount} грн`);
    });

    finBot.launch().then(() => console.log('Finance Bot started'));
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

// ── Функція авторизації ──
function auth(req, res) {
    const clientKey = req.headers['x-secret-key'];
    if (clientKey !== SECRET_KEY) {
        console.error('Auth failed: invalid secret key');
        res.status(401).send('Unauthorized');
        return false;
    }
    return true;
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
        const data = await getCarData(); // Додаємо await
        res.json(data);
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
