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
  // Step 1: Enqueue search with night RANGE (6,10 = from 6 to 10 nights)
  console.log('=== Enqueue with night range 6,10 ===');
  const enqRes = await ltApi.get('/search/enqueue', {
    params: {
      from_city: 'Moscow', to_country: 'TR', to_city: 'Alanya',
      adults: 2, start_date: '2026-05-05',
      nights: '6,10', hotel_ids: '9067545'
    }
  });
  const requestId = enqRes.data.request_id;
  console.log('request_id:', requestId);
  
  // Step 2: Wait for completion
  let done = false;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await ltApi.get('/search/status', { params: { request_id: requestId } });
    const statuses = st.data.status || {};
    const pending = Object.values(statuses).some(s => s === 'pending' || s === 'performing');
    console.log('Status poll', i+1, ':', JSON.stringify(statuses).substring(0, 200));
    if (!pending) { done = true; break; }
  }
  console.log('Search done:', done);
  
  // Step 3: Try get_hotel_offers endpoint
  console.log('\n=== Trying get_hotel_offers ===');
  try {
    const offersRes = await ltApi.get('/search/get_hotel_offers', {
      params: { request_id: requestId, hotel_id: '9067545' }
    });
    const offers = offersRes.data;
    console.log('Response keys:', Object.keys(offers));
    const tours = offers.tours || offers.offers || offers.results || [];
    const arr = Array.isArray(tours) ? tours : Object.values(tours);
    console.log('Tours count:', arr.length);
    if (arr.length > 0) {
      for (let i = 0; i < Math.min(3, arr.length); i++) {
        console.log('\nTour', i, 'keys:', Object.keys(arr[i]));
        console.log('Tour', i, ':', JSON.stringify(arr[i]).substring(0, 600));
      }
      const rooms = [...new Set(arr.map(t => t.room || t.room_name || t.room_type || 'NONE'))];
      console.log('\nUnique rooms:', rooms.slice(0, 15));
      const meals = [...new Set(arr.map(t => t.meal || t.pansion || t.meal_type || 'NONE'))];
      console.log('Unique meals:', meals);
      const nightsSet = [...new Set(arr.map(t => t.nights || t.night_count || 'NONE'))];
      console.log('Unique nights:', nightsSet);
      
      // Check for room photos
      const photosFields = arr.slice(0, 5).map(t => {
        return { room: t.room, photos: t.room_photos || t.photos || t.images || 'NO_FIELD' };
      });
      console.log('\nPhotos check:', JSON.stringify(photosFields).substring(0, 500));
    }
  } catch (e) {
    console.log('get_hotel_offers error:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data).substring(0, 300) : e.message);
    
    // Try alternative: get_grouped_hotels with detailed data
    console.log('\n=== Trying get_grouped_hotels ===');
    try {
      const ghRes = await ltApi.get('/search/get_grouped_hotels', {
        params: { request_id: requestId }
      });
      const rawHotels = ghRes.data.hotels || ghRes.data.filtered_results || [];
      const hotelArr = Array.isArray(rawHotels) ? rawHotels : Object.values(rawHotels);
      const match = hotelArr.find(h => String(h.hotel?.id) === '9067545' || String(h.id) === '9067545');
      if (match) {
        console.log('Match keys:', Object.keys(match));
        console.log('hotel keys:', match.hotel ? Object.keys(match.hotel) : 'no hotel obj');
        console.log('tours count:', (match.tours || []).length);
        console.log('min_price:', match.min_price);
        console.log('pansion_prices:', JSON.stringify(match.pansion_prices));
        // Check for rooms/room_types
        console.log('rooms:', match.rooms || 'NO');
        console.log('room_types:', match.room_types || 'NO');  
        console.log('Full match (first 1500 chars):', JSON.stringify(match).substring(0, 1500));
      }
    } catch (e2) {
      console.log('get_grouped_hotels error:', e2.message);
    }
  }
})().catch(e => console.error('Fatal:', e.message));
