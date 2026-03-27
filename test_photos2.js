const axios = require('axios');
const lt = axios.create({
    baseURL: 'https://api.level.travel',
    headers: {
        'Authorization': 'Token token="61c4f62cef9bf005789f63624ad8fb4b"',
        'Accept': 'application/vnd.leveltravel.v3.7'
    }
});

(async () => {
    // Test hotel detail endpoints
    const paths = ['/hotels/9067545', '/hotels/9067545/rooms', '/hotel/9067545'];
    for (const p of paths) {
        try {
            const r = await lt.get(p);
            console.log(p, '=> OK', r.status, JSON.stringify(r.data).slice(0, 300));
        } catch (e) {
            console.log(p, '=>', e.response?.status);
        }
    }

    // Check get_grouped_hotels for images using existing request_id
    const rid = 'MjEzfDIyNXwwfDk4M3w5MDY3NTQ1fDIwMjYtMDgtMDEsMjAyNi0wOC0wMXwwfDcsN3wyfDB8fHwwfDB8fHwxMzI1';
    try {
        const g = await lt.get('/search/get_grouped_hotels', { params: { request_id: rid } });
        const hotels = g.data.hotels || [];
        if (hotels[0]) {
            const h = hotels[0];
            console.log('\nGrouped hotel keys:', Object.keys(h).join(', '));
            // Check for image fields
            if (h.images) console.log('images:', JSON.stringify(h.images).slice(0, 800));
            if (h.photos) console.log('photos:', JSON.stringify(h.photos).slice(0, 800));
            if (h.photo) console.log('photo:', JSON.stringify(h.photo).slice(0, 500));
            if (h.thumbnail) console.log('thumbnail:', h.thumbnail);
            // Look at ALL keys that might have URLs
            for (const [k, v] of Object.entries(h)) {
                if (typeof v === 'string' && v.includes('http') && v.includes('img')) {
                    console.log('  URL field:', k, '=', v.slice(0, 200));
                }
            }
        }
    } catch (e) {
        console.log('get_grouped_hotels =>', e.response?.status);
    }
})();
