const axios = require('axios');
const lt = axios.create({
    baseURL: 'https://api.level.travel',
    headers: {
        'Authorization': 'Token token="61c4f62cef9bf005789f63624ad8fb4b"',
        'Accept': 'application/vnd.leveltravel.v3.7'
    }
});

(async () => {
    const rid = 'MjEzfDIyNXwwfDk4M3w5MDY3NTQ1fDIwMjYtMDgtMDEsMjAyNi0wOC0wMXwwfDcsN3wyfDB8fHwwfDB8fHwxMzI1';
    const g = await lt.get('/search/get_grouped_hotels', { params: { request_id: rid } });
    const hotels = g.data.hotels || [];
    if (hotels[0]) {
        const item = hotels[0];
        const h = item.hotel || {};
        console.log('=== hotel object keys ===');
        console.log(Object.keys(h).join(', '));
        // Check nested image fields
        if (h.images) console.log('\nhotel.images:', JSON.stringify(h.images).slice(0, 1000));
        if (h.photos) console.log('\nhotel.photos:', JSON.stringify(h.photos).slice(0, 1000));
        if (h.photo) console.log('\nhotel.photo:', JSON.stringify(h.photo).slice(0, 500));
        if (h.thumbnail) console.log('\nhotel.thumbnail:', JSON.stringify(h.thumbnail).slice(0, 500));
        // Print any URL fields
        for (const [k, v] of Object.entries(h)) {
            if (typeof v === 'string' && (v.includes('http') || v.includes('img'))) {
                console.log('  URL:', k, '=', v.slice(0, 200));
            }
            if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
                console.log('  Array field:', k, '- first:', JSON.stringify(v[0]).slice(0, 300));
            }
        }
    }
})().catch(e => console.error(e.response?.status, e.message));
