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
  // Reuse or create a search
  console.log('=== Enqueue ===');
  const enqRes = await ltApi.get('/search/enqueue', {
    params: {
      from_city: 'Moscow', to_country: 'TR', to_city: 'Alanya',
      adults: 2, start_date: '2026-05-05',
      nights: '6,10', hotel_ids: '9067545'
    }
  });
  const requestId = enqRes.data.request_id;
  console.log('request_id:', requestId);

  // Wait for completion
  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await ltApi.get('/search/status', { params: { request_id: requestId } });
    const statuses = st.data.status || {};
    const pending = Object.values(statuses).some(s => s === 'pending' || s === 'performing');
    if (!pending) { console.log('Done after', i+1, 'polls'); break; }
  }

  // Get hotel offers
  const offersRes = await ltApi.get('/search/get_hotel_offers', {
    params: { request_id: requestId, hotel_id: '9067545' }
  });
  
  const data = offersRes.data;
  const offers = data.hotel_offers || [];
  const arr = Array.isArray(offers) ? offers : Object.values(offers);
  console.log('Total offers:', arr.length);
  
  if (arr.length > 0) {
    // Print first offer in full detail
    console.log('\n=== FIRST OFFER (all keys) ===');
    console.log('Keys:', Object.keys(arr[0]));
    console.log(JSON.stringify(arr[0], null, 2).substring(0, 2000));
    
    // Print 2nd offer briefly
    if (arr.length > 1) {
      console.log('\n=== SECOND OFFER ===');
      console.log(JSON.stringify(arr[1], null, 2).substring(0, 1000));
    }
    
    // Unique values analysis
    const rooms = [...new Set(arr.map(t => t.room || t.room_name || t.room_type || 'N/A'))];
    console.log('\n=== UNIQUE ROOMS ===', rooms.length, 'total');
    rooms.forEach(r => console.log(' -', r));
    
    const meals = [...new Set(arr.map(t => t.meal || t.pansion || t.meal_type || 'N/A'))];
    console.log('\n=== UNIQUE MEALS ===', meals);
    
    const nights = [...new Set(arr.map(t => t.nights || t.night_count || 'N/A'))];
    console.log('=== UNIQUE NIGHTS ===', nights);
    
    const operators = [...new Set(arr.map(t => t.operator || t.tour_operator || 'N/A'))];
    console.log('=== UNIQUE OPERATORS ===', operators.slice(0, 15));
    
    // Check for photos
    const firstWithPhotos = arr.find(t => (t.room_photos || t.photos || t.images || []).length > 0);
    if (firstWithPhotos) {
      console.log('\n=== PHOTOS FOUND ===');
      console.log('Room:', firstWithPhotos.room || firstWithPhotos.room_name);
      const photos = firstWithPhotos.room_photos || firstWithPhotos.photos || firstWithPhotos.images;
      console.log('Photos:', JSON.stringify(photos).substring(0, 500));
    } else {
      console.log('\nNo photos found in any offer. Checking photo-related fields...');
      const photoKeys = new Set();
      arr.slice(0, 5).forEach(t => {
        Object.keys(t).forEach(k => {
          if (k.toLowerCase().includes('photo') || k.toLowerCase().includes('image') || k.toLowerCase().includes('room')) {
            photoKeys.add(k);
          }
        });
      });
      console.log('Photo/room related keys:', [...photoKeys]);
    }
  }
})().catch(e => {
  console.error('Fatal:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data).substring(0, 500) : e.message);
});
