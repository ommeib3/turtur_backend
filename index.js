// === ЗАВИСИМОСТИ ===
const express = require('express')
const axios = require('axios')
const cors = require('cors')

// === НАСТРОЙКА СЕРВЕРА ===
const app = express()
app.use(cors())
app.use(express.json())

// === КОНФИГУРАЦИЯ API ===
// API ключ Level.Travel (нужно заменить на реальный)
const RAW_KEY = '61c4f62cef9bf005789f63624ad8fb4b'
const LT_API_KEY = RAW_KEY.trim()

// Создание axios инстанса для Level.Travel API
const ltApi = axios.create({
    baseURL: 'https://api.level.travel',
    timeout: 15000, // 15 секунд таймаут
    headers: {
        'Authorization': `Token token="${LT_API_KEY}"`,
        'Accept': 'application/vnd.leveltravel.v3.7'
    }
})

// === МАППИНГИ ГОРОДОВ И РЕГИОНОВ ===
// Маппинг русских названий городов в английские для API
const cityMap = {
    // Центральная Россия
    "Москва": "Moscow",
    "Санкт-Петербург": "St. Petersburg",
    "Воронеж": "Voronezh",
    "Ярославль": "Yaroslavl",
    "Белгород": "Belgorod",

    // Приволжье
    "Казань": "Kazan",
    "Нижний Новгород": "Nizhny Novgorod",
    "Самара": "Samara",
    "Уфа": "Ufa",
    "Пермь": "Perm",
    "Оренбург": "Orenburg",
    "Саратов": "Saratov",

    // Юг и Кавказ
    "Сочи": "Sochi",
    "Минеральные Воды": "Mineralnye Vody",
    "Волгоград": "Volgograd",
    "Ростов-на-Дону": "Rostov-on-Don",
    "Краснодар": "Krasnodar",

    // Урал и Сибирь
    "Екатеринбург": "Yekaterinburg",
    "Новосибирск": "Novosibirsk",
    "Тюмень": "Tyumen",
    "Челябинск": "Chelyabinsk",
    "Омск": "Omsk",
    "Красноярск": "Krasnoyarsk",
    "Иркутск": "Irkutsk",

    // Дальний Восток
    "Владивосток": "Vladivostok",
    "Хабаровск": "Khabarovsk"
}

// Маппинг регионов Турции
const regionMapLT = {
    // Анталийское побережье
    "Аланья": "Alanya",
    "Алания": "Alanya",
    "Анталия": "Antalya",
    "Анталия": "Antalya",
    "Кемер": "Kemer",
    "Сиде": "Side",
    "Белек": "Belek",

    // Эгейское побережье
    "Мармарис": "Marmaris",
    "Бодрум": "Bodrum",
    "Фетхие": "Fethiye",
    "Даламан": "Dalaman",
    "Кушадасы": "Kusadasi",

    // Другие
    "Стамбул": "Istanbul",
    "Измир": "Izmir"
}

// === ОСНОВНОЙ ENDPOINT ПОИСКА ТУРОВ ===
app.get('/api/tours', async (req, res) => {
    try {
        // === 1. ПАРАМЕТРЫ ЗАПРОСА ===
        const { category, city, adults, kids, nights, checkInFrom, regionName } = req.query

        // Преобразование города в английское название
        const fromCity = cityMap[city] || 'Moscow'

        // Получение списка регионов для поиска
        const selectedRegionsRu = regionName ? regionName.split(',') : []
        const targetRegionsEn = selectedRegionsRu
            .map(r => regionMapLT[r])
            .filter(Boolean)

        // По умолчанию Кемер, если ничего не выбрано
        if (targetRegionsEn.length === 0) targetRegionsEn.push('Kemer')

        // === 2. ФУНКЦИЯ ПАРАЛЛЕЛЬНОГО ПОИСКА ПО ОДНОМУ РЕГИОНУ ===
        // Эта функция делает полный цикл поиска для одного конкретного города
        const fetchRegionHotels = async (regionEn) => {
            try {
                const ltParams = { 
                    from_city: fromCity, 
                    to_country: 'TR', 
                    to_city: regionEn, // Ищем ТОЛЬКО в этом регионе (Кемер, Сиде и т.д.)
                    adults: adults || 2, 
                    start_date: checkInFrom || '15.05.2026', 
                    nights: String(nights || 7) 
                };

                const enqueueRes = await ltApi.get('/search/enqueue', { params: ltParams });
                const requestId = enqueueRes.data.request_id;
                
                let isSearchFinished = false;
                let attempts = 0;
                while (!isSearchFinished && attempts < 4) {
                    await new Promise(r => setTimeout(r, 1500)); 
                    try {
                        const statusRes = await ltApi.get('/search/status', { params: { request_id: requestId, show_size: true } });
                        const hasPending = Object.values(statusRes.data.status || {}).some(state => state === 'pending' || state === 'performing');
                        if (!hasPending) isSearchFinished = true;
                    } catch (e) {}
                    attempts++;
                }

                const resultsRes = await ltApi.get('/search/get_grouped_hotels', { params: { request_id: requestId } });
                const rawHotels = resultsRes.data.hotels || resultsRes.data.filtered_results || [];
                return Array.isArray(rawHotels) ? rawHotels : Object.values(rawHotels);
            } catch (e) {
                console.error(`Ошибка API для ${regionEn}:`, e.message);
                return []; // Если один регион упал, возвращаем пустоту, чтобы не сломать остальные
            }
        }

        // === 3. ЗАПУСК ПОИСКА ПО ВСЕМ ВЫБРАННЫМ РЕГИОНАМ ОДНОВРЕМЕННО ===
        // Promise.all запускает поиски параллельно. Время ожидания не увеличивается!
        const nestedHotels = await Promise.all(targetRegionsEn.map(reg => fetchRegionHotels(reg)))
        const allRawHotels = nestedHotels.flat()

        // Убираем возможные дубликаты (если отель вдруг попал в две выборки)
        const uniqueRawMap = new Map()
        allRawHotels.forEach(item => {
            const hId = item.hotel?.id || item.id
            if (hId && !uniqueRawMap.has(hId)) uniqueRawMap.set(hId, item)
        })
        const itemsToProcess = Array.from(uniqueRawMap.values()).slice(0, 400)

        // === 4. ПАРАЛЛЕЛЬНОЕ ОБОГАЩЕНИЕ ДАННЫМИ (Справочник) ===
        const hotelIds = itemsToProcess.map(i => (i.hotel?.id || i.id)).filter(Boolean)
        let detailedMap = {}

        if (hotelIds.length > 0) {
            const CHUNK_SIZE = 50; 
            const chunkPromises = [];
            for (let i = 0; i < hotelIds.length; i += CHUNK_SIZE) {
                const chunk = hotelIds.slice(i, i + CHUNK_SIZE);
                chunkPromises.push(
                    ltApi.get('/references/hotels', { params: { hotel_ids: chunk.join(',') } })
                    .then(refsRes => {
                        if (refsRes.data?.hotels) {
                            refsRes.data.hotels.forEach(h => { detailedMap[h.id] = h; });
                        }
                    })
                    .catch(e => console.error(`Ошибка справочника: ${e.message}`))
                );
            }
            await Promise.all(chunkPromises);
        }

        // === 5. ТРАНСФОРМАЦИЯ ДАННЫХ ===
        const hotels = itemsToProcess.map(item => {
            const h = item.hotel || item;
            if (!h) return null;
            
            const d = detailedMap[h.id] || {};
            const CDN = 'https://img.cdn.level.travel/';
            const feat = { ...(h.features || {}), ...(d.features || {}) };

            // УЛУЧШЕННЫЙ ПОИСК РЕГИОНА
            // Проверяем все возможные поля, где API может прятать название города
            const regionCandidate = 
                h.town_name || 
                h.region_name || 
                (h.city && h.city.name) || 
                (h.town && h.town.name) ||
                (d.city && d.city.name) || 
                (d.town && d.town.name) ||
                d.region_name || 
                d.town_name;

            let photoList = [];
            const allImgs = [...(d.images || []), ...(h.images || []), ...(h.photos || [])];
            allImgs.forEach(p => {
                const path = typeof p === 'string' ? p : (p.x900 || p.original || p.x620);
                if (path) photoList.push(path.startsWith('http') ? path : `${CDN}${path}`);
            });

            const buildYear = parseInt(d.build_year || h.build_year || 0);
            const renovationYear = parseInt(d.renovation_year || h.renovation_year || 0);
            const latestYear = Math.max(buildYear, renovationYear);
            
            const kidsFeatures = [feat.kids_club, feat.kids_pool, feat.kids_menu, feat.nanny];
            const hasKidsServices = kidsFeatures.some(f => f === true);
            const pansion = item.pansion_prices || {};

            return {
                id: h.id,
                name: h.name,
                price: item.min_price || item.price || 0,
                rating: h.rating || d.rating || 0,
                stars: parseInt(h.stars) || 0,
                city: h.city?.name || d.city?.name || "",
                
                // Используем найденного кандидата или оставляем пустым, если API ничего не дало
                region_name: regionCandidate || "",
                
                photos: photoList.length ? [...new Set(photoList)].slice(0, 15) : ["https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=800"],
                description: d.short_info || h.description || "Прекрасный отель для вашего отдыха.",
                beach_line: feat.line ? `${feat.line}-я линия` : "",
                tags: hasKidsServices ? ['Для детей'] : [],
                meal_label: pansion.UAI ? "Ultra All Inclusive" : (pansion.AI ? "All Inclusive" : ""),
                has_aquapark: !!(feat.aquapark || item.aquapark),
                is_family: hasKidsServices,
                special: {
                    adults_only: !!d.adults_only,
                    is_new_hotel: latestYear >= 2024,
                    display_year: latestYear > 0 ? latestYear : null
                },
                wifi_status: feat.wi_fi ? (feat.wi_fi === 'LOBBY_FREE' ? "В лобби" : "Бесплатный Wi-Fi") : ""
            };
        }).filter(Boolean);

        // === 6. ЛОГИКА КАТЕГОРИЙ ===
        // Фильтрация отелей по категориям (standard, standard_plus, comfort)
        const categoryRules = {
            standard: { stars: [3, 4, 5], minRating: 0 },
            standard_plus: { stars: [4, 5], minRating: 6 },
            comfort: { stars: [5], minRating: 7, requiresUAI: true }
        };

        const rule = categoryRules[category] || categoryRules.standard;

        const filteredHotels = hotels
        .filter(hotel => {
            if (!rule.stars.includes(hotel.stars)) return false;
            if (hotel.rating < rule.minRating) return false;
            if (rule.requiresUAI && hotel.meal_label !== "Ultra All Inclusive") return false;
            return true;
        })
        // ВОТ ОНА — МАГИЯ СОРТИРОВКИ:
        .sort((a, b) => a.price - b.price);
        res.json({ success: true, result: { tours: filteredHotels } });

    } catch (error) {
        console.error("Критическая ошибка:", error.message);
        res.status(500).json({ success: false });
    }
});

// === ЗАПУСК СЕРВЕРА ===
app.listen(3000, () => console.log('Backend v5.0 Ready with Full Data Mapping'));

// === ENDPOINT ДЕТАЛЬНОЙ ИНФОРМАЦИИ ОБ ОТЕЛЕ ===
app.get('/api/hotel/:id', async (req, res) => {
    try {
        const hotelId = req.params.id;
        const { category, city, adults, kids, nights, checkInFrom, regionName } = req.query;

        // === 1. ПОЛУЧЕНИЕ ДЕТАЛЬНОЙ ИНФОРМАЦИИ ИЗ СПРАВОЧНИКА ===
        const detailedRes = await ltApi.get('/references/hotels', { 
            params: { hotel_ids: hotelId } 
        });
        
        if (!detailedRes.data?.hotels?.length) {
            return res.status(404).json({ success: false, message: 'Отель не найден' });
        }

        const hotel = detailedRes.data.hotels[0];
        const CDN = 'https://img.cdn.level.travel/';

        // === 2. ПОЛУЧЕНИЕ ЦЕН ДЛЯ ЭТОГО ОТЕЛЯ ===
        const priceParams = { 
            from_city: cityMap[city] || 'Moscow', 
            to_country: 'TR', 
            to_city: regionMapLT[regionName] || 'Kemer',
            adults: adults || 2, 
            start_date: checkInFrom || '15.05.2026', 
            nights: String(nights || 7),
            hotel_ids: hotelId // Фильтруем только по этому отелю
        };

        const priceRes = await ltApi.get('/search/enqueue', { params: priceParams });
        const requestId = priceRes.data.request_id;
        
        // Ждем завершения поиска
        let attempts = 0;
        while (attempts < 4) {
            await new Promise(r => setTimeout(r, 1500));
            const statusRes = await ltApi.get('/search/status', { params: { request_id: requestId } });
            const hasPending = Object.values(statusRes.data.status || {}).some(state => state === 'pending' || state === 'performing');
            if (!hasPending) break;
            attempts++;
        }

        const resultsRes = await ltApi.get('/search/get_grouped_hotels', { params: { request_id: requestId } });
        const priceData = resultsRes.data.hotels || resultsRes.data.filtered_results || [];
        const priceInfo = Array.isArray(priceData) ? priceData.find(h => h.hotel?.id == hotelId) : null;

        // === 3. ФОРМИРОВАНИЕ ДЕТАЛЬНОЙ ИНФОРМАЦИИ ОБ ОТЕЛЕ ===
        const features = hotel.features || {};
        const buildYear = parseInt(hotel.build_year || 0);
        const renovationYear = parseInt(hotel.renovation_year || 0);
        const latestYear = Math.max(buildYear, renovationYear);

        // Собираем все фотографии
        const photoList = [];
        const allImgs = hotel.images || [];
        allImgs.forEach(p => {
            const path = typeof p === 'string' ? p : (p.x900 || p.original || p.x620);
            if (path) photoList.push(path.startsWith('http') ? path : `${CDN}${path}`);
        });

        // === 4. СБОР УДОБСТВ И СЕРВИСОВ ===
        const amenities = {
            // Питание
            all_inclusive: features.all_inclusive || false,
            ultra_all_inclusive: features.ultra_all_inclusive || false,
            breakfast: features.breakfast || false,
            half_board: features.half_board || false,
            full_board: features.full_board || false,
            
            // Пляж
            beach: features.beach || false,
            private_beach: features.private_beach || false,
            sandy_beach: features.sandy_beach || false,
            pebble_beach: features.pebble_beach || false,
            line: features.line ? `${features.line}-я линия` : null,
            
            // Развлечения
            pool: features.pool || false,
            indoor_pool: features.indoor_pool || false,
            aquapark: features.aquapark || false,
            spa: features.spa || false,
            fitness: features.fitness || false,
            tennis: features.tennis || false,
            water_sports: features.water_sports || false,
            animation: features.animation || false,
            
            // Для детей
            kids_club: features.kids_club || false,
            kids_pool: features.kids_pool || false,
            kids_menu: features.kids_menu || false,
            playground: features.playground || false,
            nanny: features.nanny || false,
            
            // Удобства
            wifi: features.wi_fi || false,
            parking: features.parking || false,
            concierge: features.concierge || false,
            laundry: features.laundry || false,
            currency_exchange: features.currency_exchange || false,
            elevator: features.elevator || false,
            
            // Доступность
            disabled_friendly: features.disabled_friendly || false,
            adults_only: hotel.adults_only || false
        };

        // === 5. ФОРМИРОВАНИЕ ОТВЕТА С ПОЛНОЙ ИНФОРМАЦИЕЙ ===
        const hotelDetail = {
            id: hotel.id,
            name: hotel.name,
            description: hotel.short_info || hotel.description || '',
            long_description: hotel.description || '',
            
            location: {
                country: hotel.country?.name || 'Турция',
                region: hotel.region_name || hotel.town_name || '',
                city: hotel.city?.name || hotel.town?.name || '',
                address: hotel.address || ''
            },
            
            rating: hotel.rating || 0,
            stars: parseInt(hotel.stars) || 0,
            
            photos: photoList,
            
            amenities: amenities,
            
            info: {
                build_year: buildYear > 0 ? buildYear : null,
                renovation_year: renovationYear > 0 ? renovationYear : null,
                rooms_count: hotel.rooms_count || null,
                floors_count: hotel.floors_count || null,
                area: hotel.area || null
            },
            
            price: priceInfo ? {
                min_price: priceInfo.min_price || priceInfo.price || 0,
                currency: 'RUB',
                meal_type: priceInfo.pansion || '',
                per_person: Math.round((priceInfo.min_price || priceInfo.price || 0) / (parseInt(adults) + parseInt(kids || 0))),
                per_night: Math.round((priceInfo.min_price || priceInfo.price || 0) / parseInt(nights || 7))
            } : null
        };

        res.json({ success: true, hotel: hotelDetail });

    } catch (error) {
        console.error('Ошибка получения детальной информации об отеле:', error.message);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// === ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: ПОИСК ОТЕЛЯ ПО ДАТЕ ===
const searchHotelForDate = async (hotelId, date, fromCity, toCity, adultsNum, nightsNum) => {
    try {
        const enqRes = await ltApi.get('/search/enqueue', {
            params: {
                from_city: fromCity,
                to_country: 'TR',
                to_city: toCity,
                adults: adultsNum,
                start_date: date,
                nights: String(nightsNum),
                hotel_ids: hotelId
            }
        });
        const requestId = enqRes.data.request_id;
        if (!requestId) return { date, available: false, minPrice: null, pricePerNight: null, tours: [] };

        // Полноценный polling статуса поиска
        let attempts = 0;
        while (attempts < 5) {
            await new Promise(r => setTimeout(r, 1500));
            try {
                const statusRes = await ltApi.get('/search/status', { params: { request_id: requestId } });
                const hasPending = Object.values(statusRes.data.status || {}).some(s => s === 'pending' || s === 'performing');
                if (!hasPending) break;
            } catch {}
            attempts++;
        }

        const resultsRes = await ltApi.get('/search/get_grouped_hotels', { params: { request_id: requestId } });
        const rawHotels = resultsRes.data.hotels || resultsRes.data.filtered_results || [];
        const hotelArr = Array.isArray(rawHotels) ? rawHotels : Object.values(rawHotels);
        const match = hotelArr.find(h =>
            String(h.hotel?.id) === String(hotelId) || String(h.id) === String(hotelId)
        );

        if (match) {
            const rawTours = match.tours || [];
            const tours = rawTours.slice(0, 20).map(t => ({
                operator: t.operator || t.tour_operator || '',
                room: t.room || t.room_name || t.room_type || 'Standard',
                meal: t.meal || t.pansion || '',
                price: t.price || t.min_price || 0,
                nights: t.nights || nightsNum,
                instantConfirmation: t.instant_confirmation || false
            }));

            return {
                date,
                available: true,
                minPrice: match.min_price || 0,
                pricePerNight: Math.round((match.min_price || 0) / nightsNum),
                pansion: match.pansion_prices || {},
                tours
            };
        }
        return { date, available: false, minPrice: null, pricePerNight: null, tours: [] };
    } catch {
        return { date, available: false, minPrice: null, pricePerNight: null, tours: [] };
    }
};

// === ENDPOINT: КАЛЕНДАРЬ ЦЕН ДЛЯ СОСЕДНИХ ДАТ ===
app.get('/api/hotel/:id/calendar', async (req, res) => {
    try {
        const hotelId = req.params.id;
        const { city, regionName, adults, nights, startDate } = req.query;

        const fromCity = cityMap[city] || 'Moscow';
        const toCity = regionMapLT[regionName] || 'Kemer';
        const nightsNum = parseInt(nights) || 7;
        const adultsNum = parseInt(adults) || 2;

        // Генерируем 11 дат: выбранная ±5 дней
        const base = new Date(startDate + 'T12:00:00');
        const dates = [];
        for (let i = -5; i <= 5; i++) {
            const d = new Date(base);
            d.setDate(d.getDate() + i);
            dates.push(d.toISOString().split('T')[0]);
        }

        // Запускаем ВСЕ поиски параллельно с proper polling
        const calendar = await Promise.all(
            dates.map(date => searchHotelForDate(hotelId, date, fromCity, toCity, adultsNum, nightsNum))
        );

        res.json({
            success: true,
            calendar: calendar.sort((a, b) => a.date.localeCompare(b.date)),
            nights: nightsNum
        });
    } catch (error) {
        console.error('Calendar error:', error.message);
        res.status(500).json({ success: false });
    }
});

// === ENDPOINT: ПОИСК ЦЕНЫ ДЛЯ ОДНОЙ ДАТЫ ===
app.get('/api/hotel/:id/search-date', async (req, res) => {
    try {
        const hotelId = req.params.id;
        const { city, regionName, adults, nights, date } = req.query;

        const fromCity = cityMap[city] || 'Moscow';
        const toCity = regionMapLT[regionName] || 'Kemer';
        const nightsNum = parseInt(nights) || 7;
        const adultsNum = parseInt(adults) || 2;

        const result = await searchHotelForDate(hotelId, date, fromCity, toCity, adultsNum, nightsNum);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Search-date error:', error.message);
        res.status(500).json({ success: false });
    }
});

// === ENDPOINT: ROOMS MATRIX (SSE STREAMING — progressive loading) ===
// Uses Server-Sent Events to stream room data as each night-search completes.
// Photos from get_grouped_hotels. Meal filter: UAI > AI > fallback.

app.get('/api/hotel/:id/rooms-matrix', async (req, res) => {
    const hotelId = req.params.id;
    const { city, regionName, adults, nights, date } = req.query;

    const fromCity = cityMap[city] || 'Moscow';
    const toCity = regionMapLT[regionName] || 'Kemer';
    const baseNights = parseInt(nights) || 7;
    const adultsNum = parseInt(adults) || 2;

    // 5 night values centered on baseNights
    const nightsList = [];
    for (let i = -2; i <= 2; i++) {
        const n = baseNights + i;
        if (n >= 1) nightsList.push(n);
    }
    nightsList.sort((a, b) => a - b);

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let aborted = false;
    req.on('close', () => { aborted = true; });

    const sendSSE = (event, data) => {
        if (!aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        console.log(`[matrix-sse] Enqueuing ${nightsList.length} searches for hotel ${hotelId}, date ${date}`);

        // Step 1: Enqueue ALL searches in parallel
        const enqueueResults = await Promise.all(
            nightsList.map(n =>
                ltApi.get('/search/enqueue', {
                    params: {
                        from_city: fromCity, to_country: 'TR', to_city: toCity,
                        adults: adultsNum, start_date: date,
                        nights: String(n), hotel_ids: hotelId
                    }
                }).then(r => ({ nights: n, requestId: r.data.request_id, done: false, sent: false }))
                  .catch(() => ({ nights: n, requestId: null, done: true, sent: true }))
            )
        );

        if (aborted) return res.end();

        // Send init immediately (no waiting)
        sendSSE('init', { nightsList, baseNights, date });

        // Step 2: Try to get hotel photos (non-blocking, best effort)
        const baseSearch = enqueueResults.find(s => s.nights === baseNights && s.requestId);
        if (baseSearch && !aborted) {
            try {
                const g = await ltApi.get('/search/get_grouped_hotels', {
                    params: { request_id: baseSearch.requestId }
                });
                const hotel = (g.data.hotels || [])[0]?.hotel;
                if (hotel?.images && hotel.images.length > 0) {
                    const CDN = 'https://img.cdn.level.travel/';
                    const photos = hotel.images.map(img => {
                        const path = typeof img === 'string' ? img : (img.x500 || img.webp_x620 || img.original);
                        return path ? (path.startsWith('http') ? path : `${CDN}${path}`) : null;
                    }).filter(Boolean).slice(0, 12);
                    if (photos.length > 0) sendSSE('photos', { photos });
                }
            } catch (e) { /* photos are optional */ }
        }

        if (aborted) return res.end();

        // Step 3: Poll loop — stream each night's data as it completes
        // Reorder: base night first for priority
        const validSearches = [
            ...enqueueResults.filter(s => s.requestId && s.nights === baseNights),
            ...enqueueResults.filter(s => s.requestId && s.nights !== baseNights)
        ];

        const normalizeRoomImages = (room) => {
            const CDN = 'https://img.cdn.level.travel/';
            const imgs = Array.isArray(room?.images) ? room.images : [];
            const urls = imgs
                .map(img => {
                    const raw = typeof img === 'string'
                        ? img
                        : (img.x900 || img.x900x380 || img.x620 || img.x500 || img.webp_x620 || img.original);
                    if (!raw) return null;
                    const path = String(raw).trim();
                    if (!path) return null;
                    return path.startsWith('http') ? path : `${CDN}${path.replace(/^\/+/, '')}`;
                })
                .filter(Boolean);
            return [...new Set(urls)].slice(0, 12);
        };

        const flattenHotelRooms = (payload, fallbackNights) => {
            const result = Array.isArray(payload?.result) ? payload.result : [];
            const flat = [];

            for (const item of result) {
                const room = item?.room || {};
                const roomPhotos = normalizeRoomImages(room);
                const offersByMeal = item?.offers || {};

                for (const mealCode of Object.keys(offersByMeal)) {
                    const offers = Array.isArray(offersByMeal[mealCode]) ? offersByMeal[mealCode] : [];
                    for (const offer of offers) {
                        flat.push({
                            room_type_ru: room.name_ru || room.name || offer.room_type_ru || '',
                            room_type: room.name_en || room.name || offer.room_type || '',
                            room_photos: roomPhotos,
                            pansion_name: mealCode || offer.pansion?.name || '',
                            pansion_description: offer.pansion?.description || '',
                            price: offer.price,
                            operator: offer.operator_name || '',
                            instantConfirmation: offer.extras?.instant_confirm || false,
                            earlyBooking: offer.extras?.early_booking || false,
                            nights: offer.nights_count || fallbackNights
                        });
                    }
                }
            }

            return flat.filter(o => Number.isFinite(o.price));
        };

        for (let attempt = 0; attempt < 15; attempt++) {
            if (aborted) return res.end();
            await new Promise(r => setTimeout(r, 2500));
            if (aborted) return res.end();

            // Check all statuses in parallel
            const statusResults = await Promise.all(
                validSearches.map(s => {
                    if (s.done) return Promise.resolve(true);
                    return ltApi.get('/search/status', { params: { request_id: s.requestId } })
                        .then(r => !Object.values(r.data.status || {}).some(st => st === 'pending' || st === 'performing'))
                        .catch(() => true);
                })
            );

            // Fetch and stream offers for newly completed searches
            for (let i = 0; i < validSearches.length; i++) {
                const s = validSearches[i];
                if (statusResults[i] && !s.done) {
                    s.done = true;
                }
                if (s.done && !s.sent && !aborted) {
                    try {
                        const r = await ltApi.get('/search/hotel_rooms', {
                            params: { request_id: s.requestId, hotel_id: hotelId }
                        });
                        const offers = flattenHotelRooms(r.data, s.nights);
                        s.sent = true;
                        console.log(`[matrix-sse] Night ${s.nights}: ${offers.length} offers`);
                        sendSSE('night-data', { night: s.nights, offers });
                    } catch (e) {
                        s.sent = true;
                        sendSSE('night-data', { night: s.nights, offers: [] });
                    }
                }
            }

            const doneCount = validSearches.filter(s => s.sent).length;
            console.log(`[matrix-sse] Poll ${attempt + 1}: ${doneCount}/${validSearches.length} sent`);
            if (validSearches.every(s => s.sent)) break;
        }

        sendSSE('complete', {});
        res.end();
    } catch (error) {
        console.error('Rooms matrix SSE error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ success: false });
        } else {
            sendSSE('error', { message: 'Internal error' });
            res.end();
        }
    }
});