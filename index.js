const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const AdmZip = require('adm-zip');
const { pipeline } = require('stream/promises');

const app = express();

// 环境变量配置
const TOKEN_OR_URL = process.env.TOKEN_OR_URL || ''; // 在 Kubeletto 的 ENVIRONMENT 里填 TOKEN_OR_URL
const TARGET_WEB = (process.env.WEB || 'https://www.google.com').replace(/\/$/, '');
const NEZHA_SERVER = process.env.NEZHA_SERVER || 'nz.yellowbins.nyc.mn';
const NEZHA_PORT = process.env.NEZHA_PORT || '8686';
const NEZHA_KEY = process.env.NEZHA_KEY || ''; // 在 Kubeletto 的 ENVIRONMENT 里填 NEZHA_KEY
const NEZHA_TLS = process.env.NEZHA_TLS || 'false';
const WARP = process.env.WARP;
const PORT = parseInt(process.env.PORT || '8080', 10);

const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  timeout: 30000
});

let currentToken = '';
let cliProcess = null;
let cliPath = '';

// 1. 获取最新 Token
async function getToken() {
  if (TOKEN_OR_URL.startsWith('http://') || TOKEN_OR_URL.startsWith('https://')) {
    try {
      const res = await axios.get(TOKEN_OR_URL, { timeout: 10000 });
      return String(res.data).trim();
    } catch (_) {
      return null;
    }
  }
  return TOKEN_OR_URL;
}

// 2. 检查并下载 cli 二进制文件
async function ensureCli() {
  const candidates = ['/app/cli', '/app/Cli', path.join(process.cwd(), 'cli'), '/tmp/cli'];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
        cliPath = p;
        return;
      } catch (_) {}
    }
  }

  const downloadUrl = 'https://raw.githubusercontent.com/yellowbins666/yellowbins666/refs/heads/main/cli';
  const dest = '/tmp/cli';

  try {
    const res = await axios({ method: 'GET', url: downloadUrl, responseType: 'stream', timeout: 30000 });
    await pipeline(res.data, fs.createWriteStream(dest));
    fs.chmodSync(dest, 0o755);
    cliPath = dest;
  } catch (_) {}
}

// 3. 启动 cli 进程（静默模式）
function runCli(token) {
  if (!cliPath || !fs.existsSync(cliPath)) return;

  if (cliProcess && !cliProcess.killed) {
    cliProcess.kill('SIGTERM');
  }

  const args = ['start', 'accept', '--token', token];
  const env = {
    ...process.env,
    HOME: '/tmp',
    TMPDIR: '/tmp'
  };

  try {
    cliProcess = spawn(cliPath, args, {
      cwd: '/tmp',
      env: env,
      stdio: 'ignore' // 静默忽略输出
    });
    cliProcess.on('error', () => {});
  } catch (_) {}
}

// 4. 定时轮询 Token
function startTokenWatcher() {
  setInterval(async () => {
    const newToken = await getToken();
    if (newToken && newToken !== currentToken) {
      currentToken = newToken;
      runCli(currentToken);
    }
  }, 10 * 60 * 1000);
}

// 5. 启动哪吒探针（带分段打点：在平台日志里搜 [nezha] 就能定位卡点）
async function startNezha() {
  console.log('[nezha] startNezha called, server=' + NEZHA_SERVER + ':' + NEZHA_PORT + ', key set=' + (!!NEZHA_KEY) + ', arch=' + os.arch());
  if (!NEZHA_SERVER || !NEZHA_PORT || !NEZHA_KEY) {
    console.error('[nezha] missing env (NEZHA_SERVER/NEZHA_PORT/NEZHA_KEY), skip');
    return;
  }

  // 先测到哪吒面板的 TCP 通不通，区分“网络不通”和“探针自身问题”
  await new Promise((resolve) => {
    const sock = net.connect({ host: NEZHA_SERVER, port: parseInt(NEZHA_PORT, 10), timeout: 8000 });
    sock.on('connect', () => { console.log('[nezha] tcp connect to panel OK'); sock.destroy(); resolve(); });
    sock.on('timeout', () => { console.error('[nezha] tcp connect to panel TIMEOUT'); sock.destroy(); resolve(); });
    sock.on('error', (e) => { console.error('[nezha] tcp connect to panel FAILED:', e && e.message); resolve(); });
  });

  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const targetArch = archMap[os.arch()] || os.arch();
  const nezhaUrl = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${targetArch}.zip`;
  const zipPath = '/tmp/nezha-agent.zip';
  const binPath = '/tmp/nezha-agent';
  const configPath = '/tmp/nezha-config.yaml';

  try {
    console.log('[nezha] downloading agent zip...');
    const response = await axios({ method: 'GET', url: nezhaUrl, responseType: 'stream', timeout: 30000 });
    await pipeline(response.data, fs.createWriteStream(zipPath));
    console.log('[nezha] download done, bytes=' + fs.statSync(zipPath).size);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo('/tmp', true);
    console.log('[nezha] extracted, bin exists=' + fs.existsSync(binPath));

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);

      const isTls = NEZHA_TLS && ['true', '1'].includes(String(NEZHA_TLS).toLowerCase());
      const configContent = `client_secret: "${NEZHA_KEY}"
server: "${NEZHA_SERVER}:${NEZHA_PORT}"
tls: ${isTls}
`;
      fs.writeFileSync(configPath, configContent, 'utf-8');
      console.log('[nezha] config written, spawning agent...');

      const nezhaProc = spawn(binPath, ['-c', configPath], {
        cwd: '/tmp',
        stdio: 'inherit' // 探针输出直接进平台日志
      });
      console.log('[nezha] agent spawned, pid=' + nezhaProc.pid);
      nezhaProc.on('error', (e) => console.error('[nezha] agent spawn error:', e && e.message));
      nezhaProc.on('exit', (code, signal) => console.error('[nezha] agent EXITED, code=' + code + ', signal=' + signal));
    } else {
      console.error('[nezha] agent binary NOT found after extract');
    }
  } catch (e) { console.error('startNezha failed:', e && e.message); }
}

// 6. 启动 WARP（静默模式）
function startWarp() {
  if (WARP) {
    const warpProc = spawn('wg-quick', ['up', 'wgcf'], { stdio: 'ignore' });
    warpProc.on('error', () => {});
  }
}

// 异步后台初始化
async function backgroundInit() {
  startWarp();
  startNezha();

  await ensureCli();
  currentToken = (await getToken()) || TOKEN_OR_URL;
  runCli(currentToken);

  if (TOKEN_OR_URL.startsWith('http://') || TOKEN_OR_URL.startsWith('https://')) {
    startTokenWatcher();
  }
}

// ================= Express 路由与反代 =================
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.all('*', async (req, res) => {
  const reqUrl = req.originalUrl || req.url;
  const targetUrl = `${TARGET_WEB}${reqUrl}`;
  const targetUrlObj = new URL(TARGET_WEB);

  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];

  headers['accept-encoding'] = 'identity';
  headers['host'] = targetUrlObj.host;
  headers['referer'] = targetUrlObj.origin;

  if (!headers['user-agent']) {
    headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      headers: headers,
      data: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      responseType: 'stream',
      validateStatus: () => true,
      maxRedirects: 5,
      timeout: 30000,
      httpsAgent: httpsAgent
    });

    const excludedHeaders = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];
    Object.keys(response.headers).forEach((key) => {
      if (!excludedHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, response.headers[key]);
      }
    });

    res.status(response.status);
    response.data.pipe(res);
  } catch (_) {
    res.status(502).send('Bad Gateway');
  }
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  backgroundInit();
});
