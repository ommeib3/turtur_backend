// === ЗАВИСИМОСТИ ===
const express = require('express')
const axios = require('axios')
const cors = require('cors')
const crypto = require('crypto')
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const multer = require('multer')

// === НАСТРОЙКА СЕРВЕРА ===
const app = express()
app.use(cors())
app.use(express.json())

// === ЗАГРУЗКА ФОТО ===
const uploadsDir = path.join(__dirname, 'uploads', 'tourist-photos')
const excursionUploadsDir = path.join(__dirname, 'uploads', 'excursion-photos')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
if (!fs.existsSync(excursionUploadsDir)) fs.mkdirSync(excursionUploadsDir, { recursive: true })
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req._uploadDest || uploadsDir
    cb(null, dest)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg'
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|gif)$/i
    if (allowed.test(path.extname(file.originalname))) cb(null, true)
    else cb(new Error('Only image files allowed'))
  }
})

// === КОНФИГУРАЦИЯ API ===

// === ADMIN БД (SQLite) ===
const db = new Database(path.join(__dirname, 'admin.db'))
db.pragma('journal_mode = WAL')

// Создаём таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_hotels (
    hotel_id TEXT PRIMARY KEY,
    is_special INTEGER DEFAULT 0,
    reviews_url TEXT DEFAULT '',
    custom_description TEXT DEFAULT '',
    custom_tags TEXT DEFAULT '[]',
    pros TEXT DEFAULT '[]',
    cons TEXT DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS procon_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS tag_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '',
    bg_color TEXT DEFAULT 'bg-sea/10',
    text_color TEXT DEFAULT 'text-sea',
    border_color TEXT DEFAULT 'border-sea/30'
  );
  CREATE TABLE IF NOT EXISTS excursions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    photos TEXT DEFAULT '[]',
    regions TEXT DEFAULT '[]',
    section TEXT DEFAULT 'historical',
    price_usd REAL DEFAULT 0,
    duration TEXT DEFAULT '',
    short_description TEXT DEFAULT '',
    full_description TEXT DEFAULT '',
    is_recommended INTEGER DEFAULT 0,
    is_nearby INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  );
`)

// Миграция: добавляем новые колонки если их нет
try { db.exec(`ALTER TABLE admin_hotels ADD COLUMN pros TEXT DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE admin_hotels ADD COLUMN cons TEXT DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE tag_presets ADD COLUMN color TEXT DEFAULT '#0891b2'`) } catch {}
try { db.exec(`ALTER TABLE admin_hotels ADD COLUMN quotes TEXT DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE admin_hotels ADD COLUMN tourist_photos TEXT DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE admin_hotels ADD COLUMN hotel_name TEXT DEFAULT ''`) } catch {}

// Создаём admin пользователя если нет
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex')
}
const existingAdmin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin')
if (!existingAdmin) {
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('admin', hashPassword('turtur2026'))
  console.log('Admin user created: admin / turtur2026')
}

// Middleware проверки токена
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = authHeader.slice(7)
  const session = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token)
  if (!session) {
    return res.status(401).json({ error: 'Invalid token' })
  }
  // Сессия живёт 24 часа
  if (Date.now() - session.created_at > 24 * 60 * 60 * 1000) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
    return res.status(401).json({ error: 'Token expired' })
  }
  req.userId = session.user_id
  next()
}

// === AUTH ENDPOINTS ===
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username)
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO admin_sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, Date.now())
  res.json({ success: true, token })
})

app.post('/api/admin/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization.slice(7)
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
  res.json({ success: true })
})

app.get('/api/admin/check', requireAuth, (req, res) => {
  res.json({ success: true })
})

// === ADMIN HOTELS CRUD ===
function parseHotelRow(row) {
  return {
    hotelId: row.hotel_id,
    hotelName: row.hotel_name || '',
    isSpecial: !!row.is_special,
    reviewsUrl: row.reviews_url,
    customDescription: row.custom_description,
    customTags: JSON.parse(row.custom_tags || '[]'),
    pros: JSON.parse(row.pros || '[]'),
    cons: JSON.parse(row.cons || '[]'),
    quotes: JSON.parse(row.quotes || '[]'),
    touristPhotos: JSON.parse(row.tourist_photos || '[]')
  }
}

app.get('/api/admin/hotels', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM admin_hotels').all()
  const hotels = {}
  for (const row of rows) hotels[row.hotel_id] = parseHotelRow(row)
  res.json({ success: true, hotels })
})

// Публичный эндпоинт — все данные без авторизации (для отображения на фронте)
app.get('/api/admin/hotels/public', (req, res) => {
  const rows = db.prepare('SELECT * FROM admin_hotels').all()
  const hotels = {}
  for (const row of rows) hotels[row.hotel_id] = parseHotelRow(row)
  // Также отдаём категории и пресеты тегов
  const categories = db.prepare('SELECT * FROM procon_categories ORDER BY id').all()
  const tagPresets = db.prepare('SELECT * FROM tag_presets ORDER BY id').all()
  res.json({ success: true, hotels, categories, tagPresets })
})

app.post('/api/admin/hotels', requireAuth, (req, res) => {
  const { hotelId, hotelName, isSpecial, reviewsUrl, customDescription, customTags, pros, cons, quotes } = req.body
  if (!hotelId) return res.status(400).json({ error: 'hotelId required' })
  db.prepare(`
    INSERT INTO admin_hotels (hotel_id, hotel_name, is_special, reviews_url, custom_description, custom_tags, pros, cons, quotes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hotel_id) DO UPDATE SET
      hotel_name = excluded.hotel_name,
      is_special = excluded.is_special,
      reviews_url = excluded.reviews_url,
      custom_description = excluded.custom_description,
      custom_tags = excluded.custom_tags,
      pros = excluded.pros,
      cons = excluded.cons,
      quotes = excluded.quotes
  `).run(
    String(hotelId),
    (hotelName || '').trim(),
    isSpecial ? 1 : 0,
    reviewsUrl || '',
    customDescription || '',
    JSON.stringify(customTags || []),
    JSON.stringify(pros || []),
    JSON.stringify(cons || []),
    JSON.stringify(quotes || [])
  )
  res.json({ success: true })
})

// === ЗАГРУЗКА ФОТОГРАФИЙ ТУРИСТОВ ===
app.post('/api/admin/hotels/:id/tourist-photos', requireAuth, upload.array('photos', 20), (req, res) => {
  const hotelId = req.params.id
  const row = db.prepare('SELECT tourist_photos FROM admin_hotels WHERE hotel_id = ?').get(hotelId)
  const existing = JSON.parse(row?.tourist_photos || '[]')
  const newPhotos = (req.files || []).map(f => ({
    id: crypto.randomBytes(8).toString('hex'),
    url: `/uploads/tourist-photos/${f.filename}`,
    filename: f.filename
  }))
  const updated = [...existing, ...newPhotos]
  db.prepare('UPDATE admin_hotels SET tourist_photos = ? WHERE hotel_id = ?').run(JSON.stringify(updated), hotelId)
  res.json({ success: true, photos: updated })
})

app.delete('/api/admin/hotels/:id/tourist-photos/:photoId', requireAuth, (req, res) => {
  const { id: hotelId, photoId } = req.params
  const row = db.prepare('SELECT tourist_photos FROM admin_hotels WHERE hotel_id = ?').get(hotelId)
  const photos = JSON.parse(row?.tourist_photos || '[]')
  const photo = photos.find(p => p.id === photoId)
  if (photo) {
    const filePath = path.join(__dirname, photo.url)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  const updated = photos.filter(p => p.id !== photoId)
  db.prepare('UPDATE admin_hotels SET tourist_photos = ? WHERE hotel_id = ?').run(JSON.stringify(updated), hotelId)
  res.json({ success: true, photos: updated })
})

app.delete('/api/admin/hotels/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM admin_hotels WHERE hotel_id = ?').run(req.params.id)
  res.json({ success: true })
})

// === PROCON CATEGORIES CRUD ===
app.get('/api/admin/categories', requireAuth, (req, res) => {
  const categories = db.prepare('SELECT * FROM procon_categories ORDER BY id').all()
  res.json({ success: true, categories })
})

app.post('/api/admin/categories', requireAuth, (req, res) => {
  const { name, icon } = req.body
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
  const result = db.prepare('INSERT INTO procon_categories (name, icon) VALUES (?, ?)').run(name.trim(), (icon || '').trim())
  res.json({ success: true, id: result.lastInsertRowid })
})

app.put('/api/admin/categories/:id', requireAuth, (req, res) => {
    const { name, icon } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
    db.prepare('UPDATE procon_categories SET name = ?, icon = ? WHERE id = ?').run(name.trim(), (icon || '').trim(), req.params.id)
    res.json({ success: true })
})

app.delete('/api/admin/categories/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM procon_categories WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// === TAG PRESETS CRUD ===
app.get('/api/admin/tag-presets', requireAuth, (req, res) => {
  const presets = db.prepare('SELECT * FROM tag_presets ORDER BY id').all()
  res.json({ success: true, presets })
})

app.post('/api/admin/tag-presets', requireAuth, (req, res) => {
  const { name, icon, color } = req.body
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
  const result = db.prepare('INSERT INTO tag_presets (name, icon, color) VALUES (?, ?, ?)').run(
    name.trim(),
    (icon || '').trim(),
    (color || '#0891b2').trim()
  )
  res.json({ success: true, id: result.lastInsertRowid })
})

app.put('/api/admin/tag-presets/:id', requireAuth, (req, res) => {
    const { name, icon, color } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
    db.prepare('UPDATE tag_presets SET name = ?, icon = ?, color = ? WHERE id = ?').run(
        name.trim(),
        (icon || '').trim(),
        (color || '#0891b2').trim(),
        req.params.id
    )
    res.json({ success: true })
})

app.delete('/api/admin/tag-presets/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tag_presets WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

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

// === EXCURSIONS CRUD ===
function parseExcursionRow(row) {
  return {
    id: row.id,
    title: row.title,
    photos: JSON.parse(row.photos || '[]'),
    regions: JSON.parse(row.regions || '[]'),
    section: row.section || 'historical',
    priceUsd: row.price_usd || 0,
    duration: row.duration || '',
    shortDescription: row.short_description || '',
    fullDescription: row.full_description || '',
    isRecommended: !!row.is_recommended,
    isNearby: !!row.is_nearby,
    createdAt: row.created_at || 0
  }
}

// Public list (for frontend)
app.get('/api/excursions', (req, res) => {
  const rows = db.prepare('SELECT * FROM excursions ORDER BY created_at DESC').all()
  res.json({ success: true, excursions: rows.map(parseExcursionRow) })
})

// Admin list
app.get('/api/admin/excursions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM excursions ORDER BY created_at DESC').all()
  res.json({ success: true, excursions: rows.map(parseExcursionRow) })
})

// Create / Update excursion
app.post('/api/admin/excursions', requireAuth, (req, res) => {
  const { id, title, regions, section, priceUsd, duration, shortDescription, fullDescription, isRecommended, isNearby } = req.body
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' })

  if (id) {
    db.prepare(`UPDATE excursions SET title=?, regions=?, section=?, price_usd=?, duration=?, short_description=?, full_description=?, is_recommended=?, is_nearby=? WHERE id=?`).run(
      title.trim(), JSON.stringify(regions || []), section || 'historical', priceUsd || 0, (duration || '').trim(),
      (shortDescription || '').trim(), (fullDescription || '').trim(), isRecommended ? 1 : 0, isNearby ? 1 : 0, id
    )
    res.json({ success: true, id })
  } else {
    const result = db.prepare(`INSERT INTO excursions (title, regions, section, price_usd, duration, short_description, full_description, is_recommended, is_nearby, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      title.trim(), JSON.stringify(regions || []), section || 'historical', priceUsd || 0, (duration || '').trim(),
      (shortDescription || '').trim(), (fullDescription || '').trim(), isRecommended ? 1 : 0, isNearby ? 1 : 0, Date.now()
    )
    res.json({ success: true, id: result.lastInsertRowid })
  }
})

// Upload excursion photos
app.post('/api/admin/excursions/:id/photos', requireAuth, (req, res, next) => {
  req._uploadDest = excursionUploadsDir
  next()
}, upload.array('photos', 20), (req, res) => {
  const excId = req.params.id
  const row = db.prepare('SELECT photos FROM excursions WHERE id = ?').get(excId)
  if (!row) return res.status(404).json({ error: 'Excursion not found' })
  const existing = JSON.parse(row.photos || '[]')
  const newPhotos = (req.files || []).map(f => ({
    id: crypto.randomBytes(8).toString('hex'),
    url: `/uploads/excursion-photos/${f.filename}`,
    filename: f.filename
  }))
  const updated = [...existing, ...newPhotos]
  db.prepare('UPDATE excursions SET photos = ? WHERE id = ?').run(JSON.stringify(updated), excId)
  res.json({ success: true, photos: updated })
})

// Delete excursion photo
app.delete('/api/admin/excursions/:id/photos/:photoId', requireAuth, (req, res) => {
  const { id: excId, photoId } = req.params
  const row = db.prepare('SELECT photos FROM excursions WHERE id = ?').get(excId)
  if (!row) return res.status(404).json({ error: 'Excursion not found' })
  const photos = JSON.parse(row.photos || '[]')
  const photo = photos.find(p => p.id === photoId)
  if (photo) {
    const filePath = path.join(__dirname, photo.url)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  const updated = photos.filter(p => p.id !== photoId)
  db.prepare('UPDATE excursions SET photos = ? WHERE id = ?').run(JSON.stringify(updated), excId)
  res.json({ success: true, photos: updated })
})

// Reorder excursion photos
app.put('/api/admin/excursions/:id/photos/reorder', requireAuth, (req, res) => {
  const excId = req.params.id
  const { photoIds } = req.body
  if (!Array.isArray(photoIds)) return res.status(400).json({ error: 'photoIds must be an array' })
  const row = db.prepare('SELECT photos FROM excursions WHERE id = ?').get(excId)
  if (!row) return res.status(404).json({ error: 'Excursion not found' })
  const photos = JSON.parse(row.photos || '[]')
  const reordered = photoIds.map(id => photos.find(p => p.id === id)).filter(Boolean)
  // Add any photos not in the reorder list at the end
  photos.forEach(p => { if (!photoIds.includes(p.id)) reordered.push(p) })
  db.prepare('UPDATE excursions SET photos = ? WHERE id = ?').run(JSON.stringify(reordered), excId)
  res.json({ success: true, photos: reordered })
})

// Delete excursion
app.delete('/api/admin/excursions/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT photos FROM excursions WHERE id = ?').get(req.params.id)
  if (row) {
    const photos = JSON.parse(row.photos || '[]')
    photos.forEach(p => {
      const filePath = path.join(__dirname, p.url)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    })
  }
  db.prepare('DELETE FROM excursions WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// === ЗАПУСК СЕРВЕРА ===
app.listen(3000, () => console.log('Backend v6.0 Ready with Excursions'));

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
            
            // Поля для тегов (совместимость с /api/tours)
            beach_line: features.line ? `${features.line}-я линия` : "",
            sandy_beach: features.sandy_beach || false,
            pebble_beach: features.pebble_beach || false,
            meal_label: features.ultra_all_inclusive ? "Ultra All Inclusive" : (features.all_inclusive ? "All Inclusive" : ""),
            has_aquapark: !!features.aquapark,
            is_family: !!(features.kids_club || features.kids_pool || features.kids_menu || features.playground),
            wifi_status: features.wi_fi ? (features.wi_fi === 'LOBBY_FREE' ? "В лобби" : "Бесплатный Wi-Fi") : "",
            special: {
                adults_only: !!hotel.adults_only,
                is_new_hotel: latestYear >= 2024,
                display_year: latestYear > 0 ? latestYear : null
            },

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

        // Step 1: Enqueue ALL searches in parallel (with retries)
        const enqueueWithRetry = async (n, maxAttempts = 3) => {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const r = await ltApi.get('/search/enqueue', {
                        params: {
                            from_city: fromCity, to_country: 'TR', to_city: toCity,
                            adults: adultsNum, start_date: date,
                            nights: String(n), hotel_ids: hotelId
                        }
                    });
                    if (r.data?.request_id) {
                        return { nights: n, requestId: r.data.request_id, done: false, sent: false };
                    }
                } catch (e) {
                    if (attempt === maxAttempts) {
                        console.warn(`[matrix-sse] Enqueue failed for ${n} nights after ${maxAttempts} attempts`);
                    }
                }
                await new Promise(r => setTimeout(r, 350));
            }
            return { nights: n, requestId: null, done: true, sent: false };
        };

        const enqueueResults = await Promise.all(
            nightsList.map(n => enqueueWithRetry(n, n === baseNights ? 4 : 3))
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

        // Mark failed enqueues as loaded to prevent endless skeletons on frontend.
        for (const failed of enqueueResults.filter(s => !s.requestId && !s.sent)) {
            failed.sent = true;
            sendSSE('night-data', { night: failed.nights, offers: [] });
        }

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

        // Helper: poll a single search until done, fetch and send its data
        const pollAndSend = async (search, maxAttempts = 15) => {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (aborted || search.sent) return;
                await new Promise(r => setTimeout(r, 1500));
                if (aborted) return;
                if (!search.done) {
                    try {
                        const statusRes = await ltApi.get('/search/status', { params: { request_id: search.requestId } });
                        const pending = Object.values(statusRes.data.status || {}).some(st => st === 'pending' || st === 'performing');
                        if (!pending) search.done = true;
                    } catch { search.done = true; }
                }
                if (search.done && !search.sent) {
                    try {
                        const r = await ltApi.get('/search/hotel_rooms', {
                            params: { request_id: search.requestId, hotel_id: hotelId }
                        });
                        const offers = flattenHotelRooms(r.data, search.nights);
                        search.sent = true;
                        console.log(`[matrix-sse] Night ${search.nights}: ${offers.length} offers`);
                        sendSSE('night-data', { night: search.nights, offers });
                    } catch (e) {
                        search.sent = true;
                        sendSSE('night-data', { night: search.nights, offers: [] });
                    }
                    return;
                }
            }
            // Timed out — send empty
            if (!search.sent) {
                search.sent = true;
                sendSSE('night-data', { night: search.nights, offers: [] });
            }
        };

        // Phase 1: Poll ONLY the base night first
        const baseNightSearch = validSearches.find(s => s.nights === baseNights);
        if (baseNightSearch && !aborted) {
            console.log(`[matrix-sse] Phase 1: waiting for base night ${baseNights}`);
            await pollAndSend(baseNightSearch, 25);
        }

        // Phase 2: Poll remaining nights in parallel
        if (!aborted) {
            const remaining = validSearches.filter(s => !s.sent);
            console.log(`[matrix-sse] Phase 2: loading ${remaining.length} remaining nights`);
            await Promise.all(remaining.map(s => pollAndSend(s)));
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