const axios = require('axios');
const ltApi = axios.create({
  baseURL: 'https://api.level.travel',
  timeout: 30000,
  headers: {
    'Authorization': 'Token token="61c4f62cef9bf005789f63624ad8fb4b"',
    'Accept': 'application/vnd.leveltravel.v3.7'
  }
});

(async () => {
  // Reuse existing search
  const enqRes = await ltApi.get('/search/enqueue', {
    params: {
      from_city: 'Moscow', to_country: 'TR', to_city: 'Alanya',
      adults: 2, start_date: '2026-05-05',
      nights: '8', hotel_ids: '9067545'
    }
  });
  const requestId = enqRes.data.request_id;
  console.log('request_id:', requestId);

  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await ltApi.get('/search/status', { params: { request_id: requestId } });
    const hasPending = Object.values(st.data.status || {}).some(s => s === 'pending' || s === 'performing');
    if (!hasPending) { console.log('Done after', i+1, 'polls'); break; }
  }

  const offersRes = await ltApi.get('/search/get_hotel_offers', {
    params: { request_id: requestId, hotel_id: '9067545' }
  });
  const offers = offersRes.data.hotel_offers || [];
  console.log('Total offers:', offers.length);

  // Check room_type_ru and nights_count
  console.log('\n=== SAMPLE OFFERS ===');
  for (let i = 0; i < Math.min(8, offers.length); i++) {
    const o = offers[i];
    console.log(`[${i}] room_type="${o.room_type}" | room_type_ru="${o.room_type_ru}" | nights=${o.nights_count} | meal=${o.pansion?.name} | price=${o.price} | operator=${o.operator_name} | instant=${o.extras?.instant_confirm} | early=${o.extras?.early_booking}`);
  }

  // Group by room_type to see distribution
  const roomGroups = {};
  offers.forEach(o => {
    const rt = o.room_type || 'N/A';
    if (!roomGroups[rt]) roomGroups[rt] = { count: 0, ru: o.room_type_ru, meals: new Set() };
    roomGroups[rt].count++;
    roomGroups[rt].meals.add(o.pansion?.name);
  });
  console.log('\n=== ROOM TYPE GROUPS ===');
  Object.entries(roomGroups).forEach(([rt, info]) => {
    console.log(`"${rt}" (ru: "${info.ru}") -> ${info.count} offers, meals: [${[...info.meals].join(', ')}]`);
  });

  // Try hotel info endpoint for room photos
  console.log('\n=== TRYING HOTEL INFO ENDPOINTS ===');
  
  const endpoints = [
    `/hotels/${9067545}`,
    `/hotels/${9067545}/rooms`, 
    `/hotel/${9067545}`,
    `/hotel/${9067545}/rooms`,
  ];
  
  for (const ep of endpoints) {
    try {
      const r = await ltApi.get(ep);
      console.log(`${ep} -> OK, keys:`, Object.keys(r.data));
      if (r.data.rooms) console.log('  rooms:', JSON.stringify(r.data.rooms).substring(0, 500));
      if (r.data.hotel?.rooms) console.log('  hotel.rooms:', JSON.stringify(r.data.hotel.rooms).substring(0, 500));
      console.log('  full:', JSON.stringify(r.data).substring(0, 800));
    } catch (e) {
      console.log(`${ep} -> ${e.response?.status || 'ERR'}`);
    }
  }
})().catch(e => console.error('Fatal:', e.response?.status, e.message));
