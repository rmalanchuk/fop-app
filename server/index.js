const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const MONO_TOKEN = process.env.MONO_TOKEN;
const SECRET_KEY = process.env.SECRET_KEY;

// Функція для отримання курсу НБУ
async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    const yyyymmdd = date.toISOString().split('T')[0].replace(/-/g, '');
    try {
        const response = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`);
        const data = await response.json();
        const rate = data[0]?.rate || 41.5;
        return rate;
    } catch (e) {
        return 41.5;
    }
}

app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');
    
    const { accountId, year, quarter } = req.query;
    const q = parseInt(quarter);
    
    // Визначаємо початок і кінець кварталу
    // Quarter 1: Jan(0)-Mar(2), Q2: Apr(3)-Jun(5), і т.д.
    const startMonth = (q - 1) * 3;
    const endMonth = startMonth + 2;
    
    const from = Math.floor(new Date(year, startMonth, 1).getTime() / 1000);
    const to = Math.floor(new Date(year, endMonth + 1, 0, 23, 59, 59).getTime() / 1000);

    try {
        console.log(`Запит до Mono за період: ${new Date(from*1000).toLocaleDateString()} - ${new Date(to*1000).toLocaleDateString()}`);
        
        // ОДИН запит до Monobank за весь квартал
        const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
            headers: { 'X-Token': MONO_TOKEN }
        });

        if (r.status === 429) return res.status(429).json({ error: "limit" });
        const data = await r.json();

        if (!Array.isArray(data)) {
            return res.status(500).json({ error: "Invalid data from Mono" });
        }

        // Об'єкт для результатів: {0: сума1, 1: сума2, 2: сума3} (індекси місяців у кварталі)
        const results = { 0: 0, 1: 0, 2: 0 };

        for (const t of data) {
            if (t.amount > 0) {
                const tDate = new Date(t.time * 1000);
                const tMonth = tDate.getMonth();
                
                // Визначаємо, до якого індексу в межах кварталу відноситься транзакція
                // Наприклад, для Q2 (місяці 3,4,5): квітень(3) - 3 = індекс 0
                const resultIndex = tMonth - startMonth;

                const usdAmount = Math.abs(t.operationAmount) / 100;
                const rate = await getNbuRate(t.time);
                const transactionUah = usdAmount * rate;

                results[resultIndex] += transactionUah;
            }
        }

        // Округляємо фінальні суми
        results[0] = Math.round(results[0] * 100) / 100;
        results[1] = Math.round(results[1] * 100) / 100;
        results[2] = Math.round(results[2] * 100) / 100;

        res.json(results);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
