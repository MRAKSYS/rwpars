
// rw.js
const mineflayer = require('mineflayer');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');

const donaters = {
  E: 'GOD', F: 'RABBIT', G: 'COBRA', H: 'DRACULA',
  I: 'HYDRA', J: 'BUNNY', K: 'TIGER', M: 'DRAGON',
  N: 'IMPERATOR', O: 'MAGISTER', P: 'OVERLORD',
  R: 'TITAN', S: 'HERO', '=': 'D.HELPER',
};

// Конфигурация через env-vars (удобно в Амвера)
const AUTH_USERNAME = process.env.AUTH_USERNAME || '124667';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '5555551';
const TARGET_NICKNAME = process.env.TARGET_NICKNAME || 'ЦелевойНик';
const DATA_DIR = process.env.DATA_DIR || '/data';
const MC_HOST = process.env.MC_HOST || 'mc.reallyworld.ru';
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_VERSION = process.env.MC_VERSION || '1.20.1';
const CYCLE_DELAY_MS = Number(process.env.CYCLE_DELAY_MS || 5000); // пауза между циклами анархий
const ANARCHY_COUNT = Number(process.env.ANARCHY_COUNT || 54);
const SLEEP_IN_ANARCHY_MS = Number(process.env.SLEEP_IN_ANARCHY_MS || 15000);
const PORT = Number(process.env.PORT || 80);

let bot = null;
let runLoopActive = false;
let reconnectDelay = 1000; // ms, экспоненциальный backoff
const MAX_RECONNECT_DELAY = 5 * 60 * 1000;

// in-memory sets для предотвращения дубликатов записи в рамках сессии
const parsedSet = new Set();
const unknownSet = new Set();

function now() {
  return new Date().toISOString();
}

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Ошибка при создании DATA_DIR:', err);
  }
}

async function appendUnique(fileName, item, setRef) {
  if (setRef.has(item)) return false;
  try {
    const filePath = path.join(DATA_DIR, fileName);
    await fs.appendFile(filePath, item + '\n', 'utf8');
    setRef.add(item);
    return true;
  } catch (err) {
    console.error(`Ошибка записи в ${fileName}:`, err);
    return false;
  }
}

async function appendLog(msg) {
  const line = `[${now()}] ${msg}\n`;
  try {
    await fs.appendFile(path.join(DATA_DIR, 'log.txt'), line, 'utf8');
  } catch (err) {
    console.error('Ошибка записи в log.txt:', err);
  }
  console.log(line.trim());
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startHealthServer() {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
  }).listen(PORT, () => {
    console.log(`Health server listening on ${PORT}`);
  });
}

function createBot() {
  appendLog('Создаём бота...');
  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: AUTH_USERNAME,
    password: AUTH_PASSWORD,
    version: MC_VERSION,
    keepalive: true,
  });

  bot.on('resourcePack', () => {
    bot.acceptResourcePack();
    appendLog('Бот принял ресурспак.');
  });

  bot.on('kicked', (reason) => {
    appendLog('Бот кикнут с сервера: ' + String(reason));
    // не завершаем процесс, попытаемся переподключиться
    safeEndBot();
  });

  bot.on('end', () => {
    appendLog('Соединение закрыто (end). Попытка переподключения через ' + reconnectDelay + ' ms');
    safeEndBot();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    appendLog('Bot error: ' + (err && err.message ? err.message : String(err)));
  });

  bot.on('message', async (message) => {
    const msg = message.toString();
    await appendLog('[MSG] ' + msg);

    if (msg.includes('https://')) {
      const urlMatch = msg.match(/https:\/\/\S+/);
      if (urlMatch) {
        await appendLog('Капча: ' + urlMatch[0]);
      }
    }

    if (msg.includes('Авторизация » /login')) {
      bot.chat(`/login ${AUTH_PASSWORD}`);
      await appendLog('Бот ввёл пароль для входа.');
    } else if (msg.includes('Авторизация успешна')) {
      await appendLog('Авторизация успешна!');
    } else if (msg.includes('Неверный пароль') || msg.includes('Неверный логин или пароль')) {
      await appendLog('Неверный пароль! Прекращаем работу.');
      try { bot.quit(); } catch (e) {}
      process.exit(1);
    } else if (msg.includes('Добро пожаловать на сервер ReallyWorld!')) {
      await appendLog('Бот зашёл в лобби.');
      // начинаем цикл парсинга, если ещё не начат
      if (!runLoopActive) {
        runLoopActive = true;
        runLoop().catch(err => appendLog('Ошибка в runLoop: ' + String(err)));
      }
    }
  });

  // Обработка низкоуровневых пакетов (анализ команд/плееров)
  bot._client.on('packet', async (packet) => {
    try {
      if (packet && packet.team && Array.isArray(packet.players)) {
        const teamFirstChar = packet.team.charAt(0);
        if (/\d/.test(teamFirstChar)) return;

        for (const nickname of packet.players) {
          const donaterStatus = donaters[teamFirstChar] || 'Unknown';
          if (donaterStatus === 'Unknown') {
            const added = await appendUnique('unknown.txt', nickname, unknownSet);
            if (added) {
              await appendLog(`Записан в unknown.txt: ${nickname}`);
            }
          } else {
            const line = `${nickname} : ${donaterStatus}`;
            const added = await appendUnique('parsed.txt', line, parsedSet);
            if (added) {
              await appendLog(`Записан в parsed.txt: ${line}`);
            }
          }
        }
      }
    } catch (err) {
      await appendLog('Ошибка при обработке пакета: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

function safeEndBot() {
  try {
    if (bot) {
      bot.removeAllListeners();
      try { bot.quit(); } catch (e) {}
      bot = null;
    }
  } catch (e) {
    console.error('Ошибка при завершении бота:', e);
  }
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    appendLog('Попытка реконнекта...');
    createBot();
  }, reconnectDelay);
}

async function runLoop() {
  // бесконечный цикл: парсим анархии, потом снова с 1
  reconnectDelay = 1000; // сброс при успешном старте
  while (true) {
    try {
      await appendLog('Начинаем полный цикл анархий (1..' + ANARCHY_COUNT + ')');
      await runAllAnarchies();
      await appendLog('Цикл завершён. Ждём ' + CYCLE_DELAY_MS + ' ms до нового цикла.');
      await delay(CYCLE_DELAY_MS);
      // очищаем in-memory множества, чтобы при новом цикле заново записывать (если нужно)
      parsedSet.clear();
      unknownSet.clear();
    } catch (err) {
      await appendLog('Ошибка в runLoop: ' + (err && err.message ? err.message : String(err)));
      // при ошибке небольшая пауза
      await delay(5000);
    }
  }
}

async function runAllAnarchies() {
  if (!bot) {
    await appendLog('Бот не подключён, прерываем runAllAnarchies.');
    return;
  }
  await appendLog('Обход всех анархий запущен.');
  for (let i = 1; i <= ANARCHY_COUNT; i++) {
    try {
      await appendLog(`Подключаемся к анархии №${i}...`);
      await swap(i);
      await appendLog(`В анархии №${i}, спим ${SLEEP_IN_ANARCHY_MS} ms...`);
      await delay(SLEEP_IN_ANARCHY_MS);
      await appendLog('Отправляем команду /hub...');
      try { bot.chat('/hub'); } catch (e) { await appendLog('Ошибка отправки /hub: ' + String(e)); }
      await appendLog('Ждем 5 секунд после /hub...');
      await delay(5000);
    } catch (err) {
      await appendLog(`Ошибка при обработке анархии №${i}: ${err && err.message ? err.message : String(err)}`);
    }
  }
  await appendLog('Обход всех анархий завершён.');
}

// swap: пытаемся открыть меню и кликаем нужные слоты
async function swap(griefNumber) {
  if (!bot) {
    await appendLog('swap: bot не инициализирован');
    return;
  }
  // Попытки открыть меню (например, активировать компас). Если меню не откроется за timeout, пробуем заново.
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await appendLog(`swap: попытка ${attempt} открыть меню для анархии ${griefNumber}`);
    // нажимаем активный предмет
    try {
      bot.activateItem();
    } catch (e) {
      await appendLog('Ошибка при activateItem: ' + String(e));
    }

    // ждём события windowOpen с таймаутом
    const windowOpenPromise = new Promise((resolve, reject) => {
      let timeout = setTimeout(() => {
        bot.removeListener('windowOpen', onOpen);
        reject(new Error('Timeout waiting for windowOpen'));
      }, 3500);

      function onOpen(window) {
        clearTimeout(timeout);
        bot.removeListener('windowOpen', onOpen);
        resolve(window);
      }

      bot.once('windowOpen', onOpen);
    });

    try {
      const window = await windowOpenPromise;
      await appendLog('Меню открыто, выбираем пункты...');
      // сперва открываем grief menu: кликаем слот 21 (по вашему старому коду)
      await clickSlotWithLogging(21, 'grief menu');
      await delay(1200);

      const slotIndex = griefNumber - 1;
      await clickSlotWithLogging(slotIndex, `анархия №${griefNumber} (слот ${slotIndex})`);
      await delay(800);
      return; // успешно
    } catch (err) {
      await appendLog('swap: не удалось открыть меню или выполнить клики: ' + err.message);
      await delay(1200 + attempt * 300);
      // попробовать ещё раз
    }
  }
  await appendLog(`swap: все попытки неудачны для анархии ${griefNumber}`);
}

// click slot helper
async function clickSlotWithLogging(slot, description) {
  if (!bot || !bot.currentWindow) {
    await appendLog(`clickSlot: нет текущего окна, слот ${slot} (${description})`);
    return;
  }
  if (!bot.currentWindow.slots || !bot.currentWindow.slots[slot]) {
    await appendLog(`clickSlot: слот ${slot} (${description}) не найден!`);
    return;
  }
  try {
    await bot.clickWindow(slot, 0, 0);
    await appendLog(`clickSlot: Нажат слот ${slot} (${description}).`);
  } catch (err) {
    await appendLog(`clickSlot: Ошибка при клике по слоту ${slot}: ${err && err.message ? err.message : String(err)}`);
  }
}

// Инициализация
(async () => {
  await ensureDataDir();
  startHealthServer();
  createBot();

  // graceful shutdown
  process.on('SIGINT', async () => {
    await appendLog('Получен SIGINT, завершаем работу...');
    safeEndBot();
    process.exit(0);
  });
})();
