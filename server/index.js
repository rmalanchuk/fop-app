const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Telegraf, Scenes, session } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// 1. Спочатку оголошуємо змінні оточення
const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FINANCE_TOKEN = process.env.TELEGRAM_FINANCE_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DOMAIN = 'fop-app-02d3.onrender.com';
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id)) : [];

// 2. Ініціалізуємо додаток та базу
const app = express();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '')));

// Публічний маршрут для Cron-job.org, щоб сервер не спав
app.get('/ping', (req, res) => {
    console.log('📡 Ping received: Keep-alive tick');
    res.send('Safe and Sound');
});

// 3. Ініціалізуємо ботів (якщо токени є)
const bot = TELEGRAM_TOKEN ? new Telegraf(TELEGRAM_TOKEN) : null;
const finBot = FINANCE_TOKEN ? new Telegraf(FINANCE_TOKEN) : null;

// --- БЛОК БЕЗПЕКИ (WHITELIST) ---
const authMiddleware = (ctx, next) => {
    const userId = ctx.from?.id;
    const text = ctx.message?.text || "не текст (кнопка/інше)";

    // ЛОГ 1: Бачимо, що запит взагалі дійшов до бота
    console.log(`📩 [ВХІД] Повідомлення від ${userId}: "${text}"`);

    if (ctx.from && ALLOWED_USERS.includes(userId)) {
        // ЛОГ 2: Підтверджуємо, що ID є в списку і пропускаємо далі
        console.log(`✅ [ДОСТУП] ID ${userId} авторизовано. Передаю обробнику...`);
        return next(); 
    }

    // ЛОГ 3: Якщо ID немає в списку
    console.log(`🚫 [ВІДМОВА] Спроба доступу відхилена для ID: ${userId}. Список дозволених: ${ALLOWED_USERS}`);
};

if (bot) bot.use(authMiddleware);
if (finBot) finBot.use(authMiddleware);
// --------------------------------

// 4. Налаштовуємо вебхуки (Виправлено)
if (bot) {
    const carWebhookPath = `/telegraf/${TELEGRAM_TOKEN}`;
    // Використовуємо .post замість .use для точності
    app.post(carWebhookPath, (req, res) => bot.handleUpdate(req.body, res));
    
    bot.telegram.setWebhook(`https://${DOMAIN}${carWebhookPath}`)
        .then(() => console.log('✅ Car Bot Webhook Set'))
        .catch(err => console.error('Car Bot Webhook Error:', err));
}

if (finBot) {
    const finWebhookPath = `/telegraf/${FINANCE_TOKEN}`;
    // Використовуємо .post замість .use для точності
    app.post(finWebhookPath, (req, res) => finBot.handleUpdate(req.body, res));
    
    finBot.telegram.setWebhook(`https://${DOMAIN}${finWebhookPath}`)
        .then(() => console.log('✅ Finance Bot Webhook Set'))
        .catch(err => console.error('Finance Bot Webhook Error:', err));
}

// 5. Запуск сервера (один раз!)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Webhooks are being set via Express middleware`);
});

// Константи категорій згідно з твоєю логікою
const CATEGORIES = {
    EXPENSES: ['Продукти', 'Медицина', 'Розваги', 'Одяг', 'Машина', 'Квартира', 'Податки', 'Кредити', 'Інше'],
    INCOME: ['Школа', 'Хелен Дорон', 'Лангейт', 'Інше'],
    SAVINGS: ['Гривні', 'Долари', 'Євро']
};

const CAR_DB_PATH = path.join(__dirname, 'car_db.json');

// ── Робота з базою авто ──
async function getCarData() {
    const now = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setDate(now.getDate() - 180);
    const isoSixMonthsAgo = sixMonthsAgo.toISOString();

    const { data: fuel } = await supabase.from('car_stats').select('*').order('date', { ascending: true });
    const { data: maint } = await supabase.from('car_maintenance').select('*').order('date', { ascending: true });
    const { data: configs } = await supabase.from('maintenance_configs').select('*');

    // --- МАТЕМАТИКА АНАЛІТИКИ (6 МІСЯЦІВ) ---
    const recentFuel = fuel ? fuel.filter(f => new Date(f.date) >= sixMonthsAgo) : [];
    
    let avgConsumption = 0;
    let costPer100km = 0;

    if (recentFuel.length >= 2) {
        const totalLiters = recentFuel.slice(1).reduce((sum, f) => sum + f.liters, 0); // сума літрів
        const minOdo = recentFuel[0].odo;
        const maxOdo = recentFuel[recentFuel.length - 1].odo;
        const deltaOdo = maxOdo - minOdo;

        if (deltaOdo > 0) {
            // Формула: (Σ літрів / Δ пробіг) * 100
            avgConsumption = (totalLiters / deltaOdo) * 100;
            
            // Формула: (Σ витрат / Δ пробіг) * 100
            const totalSpend = recentFuel.slice(1).reduce((sum, f) => sum + f.amount, 0);
            costPer100km = (totalSpend / deltaOdo) * 100;
        }
    }

    const lastOdo = fuel && fuel.length > 0 ? Math.max(...fuel.map(d => d.odo)) : 0;
    const lastPrice = fuel && fuel.length > 0 ? fuel[fuel.length - 1].priceattime : 87.99;

    return { 
        fuel: fuel || [], 
        maintenance: maint || [], 
        configs: configs || [], 
        analytics: {
            avgConsumption: avgConsumption.toFixed(2),
            costPer100km: Math.round(costPer100km)
        },
        lastOdo, 
        lastPrice 
    };
}
async function saveCarData(entry) {
    const dbEntry = {
        date: entry.date,
        amount: entry.amount,
        odo: entry.odo,
        liters: entry.liters,
        priceattime: entry.priceAtTime // Тут JS бере значення з об'єкта і кладе в колонку priceattime
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
    // Створюємо постійну кнопку під полем вводу
    const mainKeyboard = {
        reply_markup: {
            keyboard: [
                [{ text: '⛽️ Остання ціна' }, { text: '🗑 Скасувати останній запис' }]
            ],
            resize_keyboard: true 
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
    bot.hears('🗑 Скасувати останній запис', async (ctx) => {
        // Беремо останні записи, сортуючи саме за часом створення (created_at)
        const { data: fuel } = await supabase.from('car_stats').select('*').order('created_at', { ascending: false }).limit(1);
        const { data: maint } = await supabase.from('car_maintenance').select('*').order('created_at', { ascending: false }).limit(1);

        const f = fuel?.[0];
        const m = maint?.[0];

        if (!f && !m) return ctx.reply("Записів не знайдено.");

        let last = null;
        let type = '';

        // ПОРІВНЯННЯ ЗА ЧАСОМ (Date.parse перетворює рядок часу в число для порівняння)
        const fuelTime = f ? Date.parse(f.created_at || f.date) : 0;
        const maintTime = m ? Date.parse(m.created_at || m.date) : 0;

        if (fuelTime > maintTime) {
            last = f;
            type = 'fuel';
        } else {
            last = m;
            type = 'service';
        }

        const info = type === 'fuel' 
            ? `⛽ Паливо: ${last.amount} грн (${last.liters}л)` 
            : `🛠 Сервіс: ${last.description} (${last.cost} грн)`;

        ctx.replyWithMarkdown(
            `⚠️ **Видалити останній запис?**\n\n${info}\n📅 Дата: ${last.date.split('T')[0]}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Так, видалити', callback_data: `car_del_${type}_${last.id}` }],
                        [{ text: '❌ Скасувати', callback_data: 'car_del_cancel' }]
                    ]
                }
            }
        );
    });

    // Обробник натискання кнопок видалення
    bot.action(/^car_del_(.+)$/, async (ctx) => {
        const actionData = ctx.match[1].split('_');
        if (actionData[0] === 'cancel') {
            await ctx.answerCbQuery();
            return ctx.editMessageText("Видалення скасовано.");
        }

        const [type, id] = actionData;
        const table = type === 'fuel' ? 'car_stats' : 'car_maintenance';

        const { error } = await supabase.from(table).delete().eq('id', id);
        
        if (!error) {
            await ctx.answerCbQuery("Видалено");
            await ctx.editMessageText("✅ Запис успішно видалено з бази.");
        } else {
            await ctx.answerCbQuery("Помилка");
            await ctx.reply("Не вдалося видалити запис.");
        }
    });
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
}

if (FINANCE_TOKEN) {
    finBot.use(session());

    // --- 1. ПЕРЕНЕСЕНО СЮДИ ---
    const showMainMenu = (ctx) => {
        return ctx.reply('Family Finance: Головне меню', {
            reply_markup: {
                keyboard: [
                    ['💸 Витрати', '💰 Доходи'],
                    ['🏦 Заощадження', '📉 Витрата з заощаджень'],
                    ['🔙 Скасувати останній запис'],
                    ['❓ Довідка']
                ],
                resize_keyboard: true
            }
        });
    };

    const exitScene = async (ctx) => {
        if (ctx.scene) await ctx.scene.leave();
        return showMainMenu(ctx);
    };

    // Обробка старту теж тепер тут
    finBot.start((ctx) => showMainMenu(ctx));
    
    // --- 2. Сцени (Wizard Scenes) ---

    // Сцена для звичайних витрат/доходів
    const transactionScene = new Scenes.WizardScene(
        'ADD_TRANSACTION_SCENE',
        async (ctx) => {
            ctx.scene.session.state.category = ctx.message.text;
            const cat = ctx.message.text;
            let type = 'Витрати';
            if (CATEGORIES.INCOME.includes(cat)) type = 'Доходи';
            if (CATEGORIES.SAVINGS.includes(cat)) type = 'Заощадження';
            
            ctx.scene.session.state.type = type;
            await ctx.reply(`Введіть суму для "${cat}":`, {
                reply_markup: { keyboard: [[{ text: '⬅️ Назад' }]], resize_keyboard: true }
            });
            return ctx.wizard.next();
        },
        async (ctx) => {
            if (ctx.message.text === '⬅️ Назад') return exitScene(ctx);
            const amount = parseFloat(ctx.message.text.replace(',', '.'));
            if (isNaN(amount)) return ctx.reply('Введіть число:');

            const { category, type } = ctx.scene.session.state;
            let currency = 'UAH';
            if (category === 'Долари') currency = 'USD';
            if (category === 'Євро') currency = 'EUR';
            await supabase.from('family_finances').insert([{
                user_id: ctx.from.id, type, category, amount, currency
            }]);
            await ctx.reply(`✅ Записано: ${category} ${amount} ${currency}`);
            return exitScene(ctx);
        }
    );

    // Сцена для витрат ІЗ ЗАОЩАДЖЕНЬ (з вибором валюти)
    const savingsExpenseScene = new Scenes.WizardScene(
        'SAVINGS_EXPENSE_SCENE',
        async (ctx) => {
            ctx.scene.session.state.currency = ctx.message.text.split(' ')[0]; // Витягуємо USD/EUR/UAH
            const buttons = CATEGORIES.EXPENSES.map(c => [{ text: c }]);
            buttons.push([{ text: '⬅️ Назад' }]);
            await ctx.reply('На яку категорію витрачаємо з сейфа?', {
                reply_markup: { keyboard: buttons, resize_keyboard: true }
            });
            return ctx.wizard.next();
        },
        async (ctx) => {
            if (ctx.message.text === '⬅️ Назад') return exitScene(ctx);
            ctx.scene.session.state.category = ctx.message.text;
            await ctx.reply(`Введіть суму витрати (${ctx.scene.session.state.currency}):`);
            return ctx.wizard.next();
        },
        async (ctx) => {
            const amount = parseFloat(ctx.message.text.replace(',', '.'));
            if (isNaN(amount)) return ctx.reply('Введіть число:');
            const { currency, category } = ctx.scene.session.state;

            await supabase.from('family_finances').insert([{
                user_id: ctx.from.id, type: 'Витрати', category, amount, currency, is_from_savings: true
            }]);
            await ctx.reply(`✅ Записано: Витрата з сейфа [${currency}] на ${category}: ${amount}`);
            return exitScene(ctx);
        }
    );

    const stage = new Scenes.Stage([transactionScene, savingsExpenseScene]);
    finBot.use(stage.middleware());

    // --- АВТОМАТИЗАЦІЯ ЗВІТІВ (CRON) ---
const cron = require('node-cron');
let GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
if (GROUP_CHAT_ID && !GROUP_CHAT_ID.startsWith('-100')) {
    GROUP_CHAT_ID = '-100' + GROUP_CHAT_ID.replace('-', '');
}
console.log(`🚀 Фінансовий бот ініціалізовано для чату: ${GROUP_CHAT_ID}`);

if (finBot && GROUP_CHAT_ID) {
    
    // Функція генерації тижневого звіту (винесена окремо для зручності)
    const sendWeeklyReport = async (targetId) => {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
            .from('family_finances')
            .select('category, amount')
            .eq('type', 'Витрати')
            .eq('currency', 'UAH')
            .gte('created_at', oneWeekAgo);

        if (error || !data || data.length === 0) {
            return finBot.telegram.sendMessage(targetId, "📊 *Тижневий звіт:* Витрат за останні 7 днів не знайдено.", { parse_mode: 'Markdown' });
        }

        const summary = data.reduce((acc, curr) => {
            acc[curr.category] = (acc[curr.category] || 0) + Math.abs(curr.amount);
            return acc;
        }, {});

        let message = "📊 *Звіт за тиждень (Витрати UAH):*\n\n";
        Object.entries(summary).sort((a, b) => b[1] - a[1]).forEach(([cat, val]) => {
            message += `• ${cat}: ${val.toLocaleString('uk-UA')} ₴\n`;
        });
        
        const total = Object.values(summary).reduce((a, b) => a + b, 0);
        message += `\n💰 *Разом:* ${total.toLocaleString('uk-UA')} ₴`;

        return finBot.telegram.sendMessage(targetId, message, { parse_mode: 'Markdown' });
    };

    // 1. Кожну неділю о 22:00
    cron.schedule('0 22 * * 0', () => sendWeeklyReport(GROUP_CHAT_ID));

    // 2. Останній день місяця о 23:00
    cron.schedule('0 23 28-31 * *', async () => {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        if (tomorrow.getMonth() === today.getMonth()) return;

        try {
            const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
            const { data: records } = await supabase.from('family_finances').select('*').gte('created_at', startOfMonth);

            const exp = records.filter(r => r.type === 'Витрати' && r.currency === 'UAH').reduce((s, r) => s + Math.abs(r.amount), 0);
            const inc = records.filter(r => r.type === 'Доходи' && r.currency === 'UAH').reduce((s, r) => s + Math.abs(r.amount), 0);
            const sav = { UAH: 0, USD: 0, EUR: 0 };
            records.filter(r => r.type === 'Заощадження').forEach(r => { sav[r.currency] += r.amount; });

            let msg = `🏁 *ПІДСУМОК МІСЯЦЯ*\n\n`;
            msg += `📉 Витрати: ${exp.toLocaleString('uk-UA')} ₴\n`;
            msg += `📈 Доходи: ${inc.toLocaleString('uk-UA')} ₴\n`;
            msg += `⚖️ Баланс: ${(inc - exp).toLocaleString('uk-UA')} ₴\n\n`;
            msg += `🏦 *Додано в сейф:* \n• UAH: ${sav.UAH} ₴\n• USD: ${sav.USD} $\n• EUR: ${sav.EUR} €`;

            await finBot.telegram.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'Markdown' });
        } catch (e) { console.error(e); }
    });

    // 3. Тестова команда (тільки для тебе)
    finBot.command('test_report', async (ctx) => {
        await ctx.reply(`🔍 Перевіряю ID групи: ${GROUP_CHAT_ID}`);
        try {
            await sendWeeklyReport(GROUP_CHAT_ID);
            await ctx.reply("✅ Звіт відправлено!");
        } catch (e) {
            console.error("DEBUG ERROR:", e);
            await ctx.reply(`❌ Помилка! Бот намагався відправити на ${GROUP_CHAT_ID}, але Telegram відмовив: ${e.description}`);
        }
    });

    // --- 4. Обробка кнопок Меню ---

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

    finBot.hears('🏦 Заощадження', (ctx) => {
        const buttons = CATEGORIES.SAVINGS.map(c => [{ text: c }]);
        buttons.push([{ text: '⬅️ Назад' }]);
        ctx.reply('Що саме відкладаємо в сейф?', { reply_markup: { keyboard: buttons, resize_keyboard: true } });
    });

    finBot.hears('📉 Витрата з заощаджень', (ctx) => {
        const buttons = [['UAH (Гривні)', 'USD (Долари)', 'EUR (Євро)'], ['⬅️ Назад']];
        ctx.reply('З якої валюти сейфа знімаємо кошти?', { reply_markup: { keyboard: buttons, resize_keyboard: true } });
    });

    finBot.hears(['UAH (Гривні)', 'USD (Долари)', 'EUR (Євро)'], (ctx) => ctx.scene.enter('SAVINGS_EXPENSE_SCENE'));

    finBot.hears('❓ Довідка', (ctx) => {
        ctx.replyWithMarkdown(
            `ℹ️ **Довідка Family Finance**\n\n` +
            `1. **Швидкий ввід:** Пиши просто \`Категорія Сума\` (напр. *Продукти 500*).\n` +
            `2. **Кнопки:** Використовуй меню для детальних записів.\n` +
            `3. **Заощадження:** Це поповнення "сейфа".\n` +
            `4. **Витрата з заощаджень:** Коли купуєш щось за валюту або знімаєш велику суму з капіталу.`
        );
    });

    finBot.hears('🔙 Скасувати останній запис', async (ctx) => {
        const { data, error } = await supabase
            .from('family_finances')
            .select('*')
            .eq('user_id', ctx.from.id)
            .order('created_at', { ascending: false })
            .limit(1);

        if (data && data.length > 0) {
            const last = data[0];
            const msg = `❓ **Видалити цей запис?**\n\n` +
                        `📂 ${last.category}: ${last.amount} ${last.currency}\n` +
                        `📅 ${new Date(last.created_at).toLocaleString('uk-UA')}`;
            
            await ctx.replyWithMarkdown(msg, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔥 Так, видалити', callback_data: `delete_${last.id}` },
                            { text: '❌ Ні, лишити', callback_data: 'cancel_delete' }
                        ]
                    ]
                }
            });
        } else {
            ctx.reply('Записів не знайдено.');
        }
    });

    // Обробка натискання Inline-кнопок
    // Обробка натискання Inline-кнопки "ТАК, ВИДАЛИТИ"
    finBot.action(/^delete_(.+)$/, async (ctx) => {
        const recordId = ctx.match[1];
        
        // Спочатку дістаємо дані, які збираємось видалити, щоб показати їх у звіті
        const { data: record, error: fetchError } = await supabase
            .from('family_finances')
            .select('*')
            .eq('id', recordId)
            .single();

        if (record) {
            const { error: deleteError } = await supabase
                .from('family_finances')
                .delete()
                .eq('id', recordId);
            
            if (!deleteError) {
                await ctx.answerCbQuery('Видалено!');
                // Тепер бот редагує повідомлення і пише, що саме було видалено
                await ctx.editMessageText(
                    `✅ **Успішно видалено:**\n\n` +
                    `📂 ${record.category}: ${record.amount} ${record.currency}\n` +
                    `🗑 Запис стерто з бази.`
                , { parse_mode: 'Markdown' });
            } else {
                await ctx.answerCbQuery('Помилка видалення');
                await ctx.reply('Сталася помилка при видаленні з Supabase.');
            }
        } else {
            await ctx.answerCbQuery('Запис не знайдено');
            await ctx.editMessageText('⚠️ Не вдалося знайти запис для видалення (можливо, він уже видалений).');
        }
    });

    finBot.action('cancel_delete', async (ctx) => {
        await ctx.answerCbQuery('Скасовано');
        await ctx.editMessageText('Спроба видалення скасована.');
    });

    finBot.hears('⬅️ Назад', (ctx) => showMainMenu(ctx));

    // Запуск сцени для всіх категорій
    const allSimpleCats = [...CATEGORIES.EXPENSES, ...CATEGORIES.INCOME, ...CATEGORIES.SAVINGS];
    finBot.hears(allSimpleCats, (ctx) => ctx.scene.enter('ADD_TRANSACTION_SCENE'));

    // --- 5. Швидкий текстовий ввід (Оновлений з підтримкою команд) ---
    finBot.on('text', async (ctx, next) => {
        // 1. Якщо ми в сцені (діалозі) — передаємо керування сцені
        if (ctx.scene && ctx.scene.current) return next();
    
        const text = ctx.message.text.trim();
    
        // 2. КРИТИЧНО: Якщо текст починається з "/", це команда. 
        if (text.startsWith('/')) {
            console.log(`[finBot] Пропускаю команду: ${text}`);
            return next();
        }
    
        // 3. Регулярка для формату "Категорія Сума"
        const match = text.match(/^([А-Яа-яіІєЄґҐa-zA-Z]+)\s+(\d+(?:[.,]\d+)?)$/u);
        
        if (!match) {
            console.log(`[finBot] Текст не відповідає формату швидкого вводу: ${text}`);
            return next();
        }
    
        let [_, catInput, amountStr] = match;
        const amount = parseFloat(amountStr.replace(',', '.'));
        
        const allCats = [...CATEGORIES.EXPENSES, ...CATEGORIES.INCOME, ...CATEGORIES.SAVINGS];
        const category = allCats.find(c => c.toLowerCase() === catInput.toLowerCase());
    
        if (!category) {
            return ctx.reply(`⚠️ Категорія "${catInput}" не знайдена в базі.`);
        }
    
        let type = 'Витрати';
        if (CATEGORIES.INCOME.includes(category)) type = 'Доходи';
        if (CATEGORIES.SAVINGS.includes(category)) type = 'Заощадження';
    
        let currency = 'UAH';
        if (category === 'Долари') currency = 'USD';
        if (category === 'Євро') currency = 'EUR';
    
        try {
            console.log(`[finBot] Записую: ${category} -> ${amount} ${currency}`);
            
            await supabase.from('family_finances').insert([{
                user_id: ctx.from.id, 
                type, 
                category, 
                amount, 
                currency
            }]);
    
            await ctx.reply(`✅ Швидкий запис: ${category} ${amount} ${currency}`);
        } catch (e) {
            console.error('❌ Помилка швидкого запису:', e);
            await ctx.reply('Сталася помилка при збереженні в базу.');
        }
    });
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
app.post('/api/maintenance/config', async (req, res) => {
    // Використовуємо твою існуючу функцію авторизації auth
    if (!auth(req, res)) return;

    const { id, name, threshold_km, last_service_km } = req.body;

    try {
        if (id) {
            // Оновлення існуючого трекера (напр. Олива)
            await supabase
                .from('maintenance_configs')
                .update({ name, threshold_km, last_service_km })
                .eq('id', id);
        } else {
            // Створення нового трекера (напр. ГРМ або Гальма)
            await supabase
                .from('maintenance_configs')
                .insert([{ name, threshold_km, last_service_km }]);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Error saving config:', e);
        res.status(500).send(e.message);
    }
});

app.post('/api/maintenance/done', async (req, res) => {
    if (!auth(req, res)) return;
    
    const { configId, currentOdo } = req.body;

    if (!configId || !currentOdo) return res.status(400).send('Missing data');

    try {
        const { error } = await supabase
            .from('maintenance_configs')
            .update({ last_service_km: currentOdo })
            .eq('id', configId);

        if (error) throw error;
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});
    
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

// ── API для Finance App ──
app.get('/api/dashboard', async (req, res) => {
    // Перевірка ключа (безпека)
    const key = req.query.key;
    if (key !== SECRET_KEY) {
        console.error('Finance API: Auth failed');
        return res.status(401).send('Unauthorized');
    }

    try {
        // 1. Отримуємо всю історію операцій
        const { data: history, error } = await supabase
            .from('family_finances')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // 2. Рахуємо залишки в сейфі
        // Логіка: Поповнення (тип Заощадження) мінус витрати з міткою is_from_savings
        const safe = { UAH: 0, USD: 0, EUR: 0 };
        
        history.forEach(t => {
            if (t.type === 'Заощадження') {
                safe[t.currency] += t.amount;
            }
            if (t.is_from_savings) {
                safe[t.currency] -= t.amount;
            }
        });

        // 3. Віддаємо JSON (саме те, що чекає фронтенд)
        res.json({
            safe: {
                UAH: Math.round(safe.UAH),
                USD: Math.round(safe.USD),
                EUR: Math.round(safe.EUR)
            },
            history: history
        });

    } catch (e) {
        console.error('Finance API Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/car', (req, res) => {
        res.sendFile(path.join(__dirname, 'car.html'));
    });
}
