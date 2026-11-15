
'use strict';

const API = 'https://api.telegram.org/bot';

const LIMITS = {
  maxCount: 10000000,
  minInterval: 1,
  maxInterval: 60
};

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const $ = id => document.getElementById(id);

let token = '';
let connected = false;
let running = false;
let stopRequested = false;
let ctl = null;

let activeMode = 'message';
let previewUrl = '';

const stats = { ok: 0, fail: 0, total: 0 };

function stamp() {
  return new Date().toLocaleTimeString('en-GB');
}

function scrub(value) {
  return token
    ? String(value).split(token).join('[REDACTED]')
    : String(value);
}

function log(message, level = 'info') {
  const box = $('log');
  const line = document.createElement('div');
  const time = document.createElement('time');
  const text = document.createElement('span');

  line.className = `line ${level}`;
  time.textContent = stamp();
  text.textContent = scrub(message);

  line.append(time, text);
  box.append(line);

  while (box.children.length > 200) {
    box.firstChild.remove();
  }

  box.scrollTop = box.scrollHeight;
}

function setStatus(state, label, detail) {
  $('badge').dataset.state = state;
  $('badge').textContent = label;

  if (detail !== undefined) {
    $('statusText').textContent = detail;
  }
}

function renderStats() {
  const done = stats.ok + stats.fail;

  $('okCount').textContent = stats.ok;
  $('failCount').textContent = stats.fail;
  $('sentCount').textContent = `${done} / ${stats.total}`;

  $('bar').style.width = stats.total
    ? `${done / stats.total * 100}%`
    : '0%';
}

function syncControls() {
  const locked = running;

  $('connectBtn').disabled = locked || connected;
  $('disconnectBtn').disabled = locked || !connected;
  $('token').disabled = locked || connected;
  $('toggleToken').disabled = connected || locked;

  $('startBtn').disabled = locked || !connected;
  $('stopBtn').disabled = !locked;

  [
    'chatId', 'message', 'caption', 'mediaFile',
    'count', 'interval', 'messageMode', 'mediaMode'
  ].forEach(id => {
    $(id).disabled = locked;
  });
}

function setMode(mode) {
  if (running) return;

  activeMode = mode;

  const isMessage = mode === 'message';

  $('messageMode').classList.toggle('active', isMessage);
  $('mediaMode').classList.toggle('active', !isMessage);

  $('messageMode').setAttribute('aria-pressed', String(isMessage));
  $('mediaMode').setAttribute('aria-pressed', String(!isMessage));

  $('messageMode').querySelector('.mode-state').textContent =
    isMessage ? 'ON' : 'OFF';

  $('mediaMode').querySelector('.mode-state').textContent =
    isMessage ? 'OFF' : 'ON';

  $('messagePanel').classList.toggle('hidden', !isMessage);
  $('mediaPanel').classList.toggle('hidden', isMessage);

  log(`Mode changed to ${isMessage ? 'Message Only' : 'Picture / Video + Message'}.`);
}

async function tg(method, payload = {}, signal) {
  const response = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  });

  try {
    return await response.json();
  } catch {
    return {
      ok: false,
      error_code: response.status,
      description: 'Invalid Telegram response.'
    };
  }
}

async function tgMedia(method, form, signal) {
  const response = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    body: form,
    signal,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  });

  try {
    return await response.json();
  } catch {
    return {
      ok: false,
      error_code: response.status,
      description: 'Invalid Telegram response.'
    };
  }
}

function describe(result) {
  switch (result.error_code) {
    case 400:
      return 'Invalid request or media file.';
    case 401:
      return 'Invalid bot token.';
    case 403:
      return 'The bot does not have permission to send messages.';
    case 429:
      return 'Telegram rate limit reached.';
    default:
      return scrub(result.description || 'Unknown error.');
  }
}

function sleep(ms) {
  return new Promise(resolve => {
    if (!ctl || ctl.signal.aborted) {
      resolve(false);
      return;
    }

    const signal = ctl.signal;

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function connect() {
  const value = $('token').value.trim();

  if (!TOKEN_RE.test(value)) {
    log('Invalid bot token format.', 'err');
    return;
  }

  token = value;
  $('connectBtn').disabled = true;

  log('Checking bot connection...');

  try {
    const result = await tg('getMe');

    if (!result.ok) {
      log(`Connection failed: ${describe(result)}`, 'err');
      token = '';
      syncControls();
      return;
    }

    connected = true;
    $('token').value = '';
    $('token').placeholder = 'Token active in memory';

    $('botInfo').textContent =
      `Connected as @${result.result.username}`;

    setStatus('connected', 'Connected', 'Bot connected successfully.');

    log(`Connected as @${result.result.username}.`, 'ok');
  } catch {
    token = '';
    log('Unable to connect to Telegram.', 'err');
  }

  syncControls();
}

function disconnect() {
  if (running) return;

  token = '';
  connected = false;

  $('token').value = '';
  $('token').placeholder = 'Enter your bot token';
  $('botInfo').textContent = 'Not connected.';

  setStatus('idle', 'Offline', 'Connect your bot to begin.');

  log('Bot disconnected.');
  syncControls();
}

function getMediaFile() {
  return $('mediaFile').files[0] || null;
}

function getMediaType(file) {
  if (!file) return null;

  if (file.type.startsWith('image/')) return 'photo';
  if (file.type.startsWith('video/')) return 'video';

  return null;
}

async function sendOne(chatId, message) {
  let result;

  try {
    if (activeMode === 'message') {
      result = await tg('sendMessage', {
        chat_id: chatId,
        text: message
      }, ctl.signal);
    } else {
      const file = getMediaFile();
      const type = getMediaType(file);

      if (!file || !type) {
        throw new Error('Select a valid image or video.');
      }

      const form = new FormData();

      form.append('chat_id', chatId);
      form.append(type, file);

      if ($('caption').value.trim()) {
        form.append('caption', $('caption').value.trim());
      }

      result = await tgMedia(
        type === 'photo' ? 'sendPhoto' : 'sendVideo',
        form,
        ctl.signal
      );
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;

    stats.fail++;
    renderStats();

    log(error.message || 'Sending failed.', 'err');
    return 'failed';
  }

  if (result.ok) {
    stats.ok++;
    renderStats();

    log('Test message sent successfully.', 'ok');
    return 'ok';
  }

  if (result.error_code === 429) {
    log('Telegram rate limit reached. Stopping the test.', 'warn');
    return 'rate-limited';
  }

  stats.fail++;
  renderStats();

  log(`Sending failed: ${describe(result)}`, 'err');

  return [400, 401, 403, 404].includes(result.error_code)
    ? 'fatal'
    : 'failed';
}

function reject(message) {
  log(message, 'warn');
  $('statusText').textContent = message;
}

async function start() {
  if (running || !connected) return;

  const chatId = $('chatId').value.trim();
  const message = $('message').value.trim();
  const caption = $('caption').value.trim();

  if (!/^-?\d{3,}$/.test(chatId)) {
    return reject('Enter a valid numeric Chat ID.');
  }

  if (activeMode === 'message' && !message) {
    return reject('Please enter a message.');
  }

  if (activeMode === 'media' && !getMediaFile()) {
    return reject('Please select a photo or video.');
  }

  if (activeMode === 'media' && !getMediaType(getMediaFile())) {
    return reject('Only image and video files are supported.');
  }

  const count = Number($('count').value);
  const interval = Number($('interval').value);

  if (!Number.isInteger(count) ||
      count < 1 ||
      count > LIMITS.maxCount) {
    return reject('Test count must be between 1 and 5.');
  }

  if (!Number.isInteger(interval) ||
      interval < LIMITS.minInterval ||
      interval > LIMITS.maxInterval) {
    return reject('Interval must be between 3 and 60 seconds.');
  }

  running = true;
  stopRequested = false;
  ctl = new AbortController();

  stats.ok = 0;
  stats.fail = 0;
  stats.total = count;

  renderStats();
  syncControls();

  log(`Test started in ${activeMode} mode.`);

  let end = 'done';

  try {
    for (let i = 1; i <= count; i++) {
      if (stopRequested) break;

      setStatus(
        'sending',
        'Sending',
        `Processing test ${i} of ${count}.`
      );

      const result = await sendOne(
        chatId,
        activeMode === 'message' ? message : caption
      );

      if (result === 'fatal' || result === 'rate-limited') {
        end = 'error';
        break;
      }

      if (stopRequested) break;

      if (i < count) {
        setStatus(
          'sending',
          'Waiting',
          `Waiting ${interval} seconds.`
        );

        if (!(await sleep(interval * 1000))) break;
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      end = 'error';
      log(error.message || 'Unexpected error.', 'err');
    }
  }

  if (stopRequested) end = 'stopped';

  running = false;
  ctl = null;

  const labels = {
    done: ['done', 'Completed', 'Test completed.'],
    stopped: ['stopped', 'Stopped', 'Test stopped.'],
    error: ['error', 'Error', 'Test stopped because of an error.']
  };

  setStatus(...labels[end]);

  log(
    `Results: ${stats.ok} successful, ${stats.fail} failed.`,
    end === 'done' ? 'ok' : 'warn'
  );

  syncControls();
}

function stop() {
  if (!running) return;

  stopRequested = true;

  if (ctl) ctl.abort();

  log('Stop requested.', 'warn');
}

function updatePreview() {
  const file = getMediaFile();

  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }

  $('previewBox').classList.add('hidden');
  $('imagePreview').classList.add('hidden');
  $('videoPreview').classList.add('hidden');

  if (!file) {
    $('fileInfo').textContent = 'No file selected.';
    return;
  }

  const type = getMediaType(file);

  if (!type) {
    $('fileInfo').textContent = 'Unsupported file type.';
    return;
  }

  previewUrl = URL.createObjectURL(file);

  $('fileInfo').textContent =
    `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;

  $('previewBox').classList.remove('hidden');

  if (type === 'photo') {
    $('imagePreview').src = previewUrl;
    $('imagePreview').classList.remove('hidden');
  } else {
    $('videoPreview').src = previewUrl;
    $('videoPreview').classList.remove('hidden');
  }
}

function init() {
  $('connectBtn').addEventListener('click', connect);
  $('disconnectBtn').addEventListener('click', disconnect);
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', stop);

  $('messageMode').addEventListener('click', () => {
    setMode('message');
  });

  $('mediaMode').addEventListener('click', () => {
    setMode('media');
  });

  $('toggleToken').addEventListener('click', event => {
    const input = $('token');
    const show = input.type === 'password';

    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? 'Hide' : 'Show';
  });

  $('clearLog').addEventListener('click', () => {
    $('log').textContent = '';
  });

  $('mediaFile').addEventListener('change', updatePreview);

  $('message').addEventListener('input', () => {
    $('charCount').textContent =
      `${$('message').value.length} / 4000`;
  });

  $('caption').addEventListener('input', () => {
    $('captionCount').textContent =
      `${$('caption').value.length} / 1024`;
  });

  window.addEventListener('beforeunload', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  });

  setMode('message');
  syncControls();

  log('Application initialized. Enter your bot token.');
}

init();
