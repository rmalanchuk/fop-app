app.get('/quarter-income', async (req, res) => {
    if (req.headers['x-secret-key'] !== SECRET_KEY) return res.status(401).send('No');
    const { accountId, year, quarter } = req.query;
    const q = parseInt(quarter);
    const y = parseInt(year);
    
    const startMonth = (q - 1) * 3;
    const from = Math.floor(new Date(y, startMonth, 1).getTime() / 1000);
    const to = Math.floor(new Date(y, startMonth + 3, 0, 23, 59, 59).getTime() / 1000);

    try {
        const r = await fetch(`https://api.monobank.ua/personal/statement/${accountId}/${from}/${to}`, {
            headers: { 'X-Token': MONO_TOKEN }
        });
        const data = await r.json();

        const results = { 0: 0, 1: 0, 2: 0 };

        if (Array.isArray(data)) {
            console.log(`Знайдено транзакцій: ${data.length}`);
            for (const t of data) {
                if (t.amount > 0) {
                    const tMonth = new Date(t.time * 1000).getMonth();
                    const resultIndex = tMonth - startMonth;
                    const usdAmount = Math.abs(t.operationAmount) / 100;
                    const rate = await getNbuRate(t.time);
                    
                    if (results[resultIndex] !== undefined) {
                        results[resultIndex] += (usdAmount * rate);
                    }
                }
            }
        } else {
            console.log("Моно повернув не масив:", data);
        }

        res.json({
            0: results[0].toFixed(2),
            1: results[1].toFixed(2),
            2: results[2].toFixed(2)
        });
    } catch (e) { res.status(500).send(e.message); }
});
