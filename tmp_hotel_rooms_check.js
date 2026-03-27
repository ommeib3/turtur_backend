const axios = require('axios');

const lt = axios.create({
  baseURL: 'https://api.level.travel',
  timeout: 30000,
  headers: {
    Authorization: 'Token token="61c4f62cef9bf005789f63624ad8fb4b"',
    Accept: 'application/vnd.leveltravel.v3.7'
  }
});

(async () => {
  const enq = await lt.get('/search/enqueue', {
    params: {
      from_city: 'Moscow',
      to_country: 'TR',
      to_city: 'Kemer',
      adults: 2,
      start_date: '2026-05-12',
      nights: '7',
      hotel_ids: '9011809'
    }
  });

  const requestId = enq.data.request_id;
  console.log('request_id:', requestId);

  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await lt.get('/search/status', { params: { request_id: requestId } });
    const pending = Object.values(st.data.status || {}).some(s => s === 'pending' || s === 'performing');
    if (!pending) break;
  }

  const r = await lt.get('/search/hotel_rooms', { params: { request_id: requestId, hotel_id: '9011809' } });
  console.log('top keys:', Object.keys(r.data));

  const arr = r.data.hotel_rooms || r.data.rooms || r.data.results || [];
  const list = Array.isArray(arr) ? arr : Object.values(arr || {});
  console.log('items:', list.length);

  if (list.length > 0) {
    const first = list[0];
    console.log('first keys:', Object.keys(first));
    console.log('first sample:', JSON.stringify(first, null, 2).slice(0, 3500));
  } else {
    console.log('payload sample:', JSON.stringify(r.data, null, 2).slice(0, 3500));
  }
})().catch(e => {
  console.error('ERR:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 2000));
  process.exit(1);
});
