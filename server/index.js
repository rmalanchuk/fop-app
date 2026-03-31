const axios = require('axios');

// Функція для отримання курсу НБУ з фіксацією Київського часу
async function getNbuRate(timestamp) {
    const date = new Date(timestamp * 1000);
    
    // Форматуємо дату суворо за київським часом (Europe/Kyiv)
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    
    const parts = formatter.formatToParts(date);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    const yyyymmdd = `${y}${m}${d}`;

    try {
        const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=${yyyymmdd}&json`;
        const response = await axios.get(url);
        const rate = response.data[0]?.rate || 41.5;
        console.log(`[NBU] Дата: ${yyyymmdd}, Курс: ${rate}`);
        return rate;
    } catch (e) {
        console.error(`[NBU Error] Не вдалося отримати курс за ${yyyymmdd}`);
        return 41.5;
    }
}

// Основна логіка обробки транзакцій (у твоїй endpoint-функції)
async function processTransactions(transactions) {
    let totalUah = 0;
    
    for (const t of transactions) {
        // Фільтруємо тільки надходження (amount > 0)
        // Ігноруємо дрібні транзакції менше 10$ (1000 центів у operationAmount), щоб відсікти сміття
        if (t.amount > 0 && Math.abs(t.operationAmount) > 1000) {
            
            const usdAmount = Math.abs(t.operationAmount) / 100; // Долари (наприклад 745.32)
            const rate = await getNbuRate(t.time);
            
            const transactionSumUah = usdAmount * rate;
            totalUah += transactionSumUah;
            
            console.log(`[Transaction] Сума: $${usdAmount}, Курс НБУ: ${rate}, Разом: ${transactionSumUah.toFixed(2)} грн`);
        }
    }
    return totalUah;
}
