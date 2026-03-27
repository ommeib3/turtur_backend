// check.js
const axios = require('axios'); // Используй axios, он стабильнее в Node для этих целей

async function getAllAttributes() {
  // ВАЖНО: Перепечатай это вручную или убедись, что нет русских букв
  const token = 'ТВОЙ_ТОКЕН'; 
  const authHeader = `Token auth=${token}`;

  try {
    const response = await axios.get('https://api-gateway.travelata.ru/partners/directory/hotelAttributes', {
      headers: { 
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    });

    const dictionary = {};
    response.data.result.forEach(item => {
      dictionary[item.id] = item.name;
    });

    console.log(JSON.stringify(dictionary, null, 2));
  } catch (e) {
    console.error("Ошибка:", e.response ? e.response.data : e.message);
  }
}

getAllAttributes();