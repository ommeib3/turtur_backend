const axios = require('axios');
const lt = axios.create({
    baseURL: 'https://api.level.travel',
    headers: {
        'Authorization': 'Token token="61c4f62cef9bf005789f63624ad8fb4b"',
        'Accept': 'application/vnd.leveltravel.v3.7'
    }
});

(async () => {
    // Enqueue search
    const e = await lt.get('/search/enqueue', {
        params: {
            from_city: 'Moscow', to_country: 'TR', to_city: 'Kemer',
            adults: 2, start_date: '2026-08-01', nights: '7', hotel_ids: '9067545'
        }
    });
    const rid = e.data.request_id;
    console.log('request_id:', rid);

    // Poll until done
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const s = await lt.get('/search/status', { params: { request_id: rid } });
        const vals = Object.values(s.data.status || {});
        if (!vals.some(v => v === 'pending' || v === 'performing')) {
            console.log('Done at attempt', i + 1);
            break;
        }
        console.log('Polling...', i + 1);
    }

    // Get offers
    const r = await lt.get('/search/get_hotel_offers', {
        params: { request_id: rid, hotel_id: '9067545' }
    });
    const offers = r.data.hotel_offers || [];
    console.log('Total offers:', offers.length);

    if (offers[0]) {
        // Collect ALL unique keys across all offers
        const allKeys = new Set();
        offers.forEach(o => {
            const collect = (obj, prefix) => {
                for (const k of Object.keys(obj)) {
                    allKeys.add(prefix ? prefix + '.' + k : k);
                    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
                        collect(obj[k], prefix ? prefix + '.' + k : k);
                    }
                }
            };
            collect(o, '');
        });
        console.log('\nALL UNIQUE KEYS (nested):', JSON.stringify([...allKeys].sort(), null, 2));

        // Print full first offer
        console.log('\nFIRST OFFER:', JSON.stringify(offers[0], null, 2));

        // Check for image/photo references
        const imgKeys = [...allKeys].filter(k => 
            /image|photo|img|pic|thumb|gallery|room_id/i.test(k)
        );
        console.log('\nIMAGE-RELATED KEYS:', imgKeys);
    }
})().catch(e => console.error('ERR:', e.response?.status, e.message));
