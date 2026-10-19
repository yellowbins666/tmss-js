const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const AdmZip = require('adm-zip');
const { pipeline } = require('stream/promises');

const app = express();

// 环境变量配置
const TOKEN_OR_URL = process.env.TOKEN_OR_URL || '';
const TARGET_WEB = (process.env.WEB || 'https://www.google.com').replace(/\/$/, '');
const NEZHA_SERVER = process.env.NEZHA_SERVER || 'nz.yellowbins.nyc.mn:8686';
const NEZHA_PORT = process.env.NEZHA_PORT || '';
const NEZHA_KEY = process.env.NEZHA_KEY || '';
const NEZHA_TLS = process.env.NEZHA_TLS || 'false';
const NEZHA_UUID = process.env.NEZHA_UUID || '';
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

// 3. 启动 cli 进程
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
      stdio: 'ignore'
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

// 5. 启动哪吒探针（强制解析 IPv4 + 协议诊断）
async function startNezha() {
  console.log(`[nezha] startNezha called, server=${NEZHA_SERVER}:${NEZHA_PORT}, key set=${!!NEZHA_KEY}, arch=${os.arch()}, uuid=${NEZHA_UUID}`);
  if (!NEZHA_SERVER || !NEZHA_PORT || !NEZHA_KEY || !NEZHA_UUID) {
    console.error('[nezha] missing env (NEZHA_SERVER/NEZHA_PORT/NEZHA_KEY/NEZHA_UUID), skip');
    return;
  }

  // 强制解析为 IPv4，防止容器内 IPv6 黑洞导致 gRPC 卡死报 DeadlineExceeded
  let targetHost = NEZHA_SERVER;
  try {
    const ipv4List = await dns.resolve4(NEZHA_SERVER);
    if (ipv4List && ipv4List.length > 0) {
      targetHost = ipv4List[0];
      console.log(`[nezha] resolved ${NEZHA_SERVER} to IPv4: ${targetHost}`);
    }
  } catch (e) {
    console.log(`[nezha] dns resolve4 skipped or already IP: ${e.message}`);
  }

  // HTTP 探测：如果 8686 是哪吒 v1 面板，访问 / 应该返回 200（哪吒监控网页 HTML）
  // 如果访问 / 直接断开或返回乱码，说明 8686 只是纯 gRPC 端口（即面板其实是 v0 版本或开启了 TLS）
  try {
    const probeRes = await axios.get(`http://${targetHost}:${NEZHA_PORT}/`, {
      timeout: 5000,
      validateStatus: () => true
    });
    console.log(`[nezha] HTTP probe to ${targetHost}:${NEZHA_PORT} -> status=${probeRes.status}, title-check=${String(probeRes.data).slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.error(`[nezha] HTTP probe error (8686 may NOT be plain HTTP): ${err.message}`);
  }

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

    const zip = new AdmZip(zipPath);
    zip.extractAllTo('/tmp', true);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);

      const isTls = (NEZHA_TLS && ['true', '1'].includes(String(NEZHA_TLS).toLowerCase())) || String(NEZHA_PORT) === '443';

      // 使用解析后的纯 IPv4 地址写入配置
      const configContent = `client_secret: "${NEZHA_KEY}"
debug: true
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 3
server: "${targetHost}:${NEZHA_PORT}"
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: ${isTls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: "${NEZHA_UUID}"
`;
      fs.writeFileSync(configPath, configContent, 'utf-8');
      console.log(`[nezha] config written (server=${targetHost}:${NEZHA_PORT}, tls=${isTls}), spawning agent...`);

      const nezhaProc = spawn(binPath, ['-c', configPath], {
        cwd: '/tmp',
        stdio: 'inherit'
      });

      console.log('[nezha] agent spawned, pid=' + nezhaProc.pid);
      nezhaProc.on('error', (e) => console.error('[nezha] agent spawn error:', e && e.message));
      nezhaProc.on('exit', (code, signal) => console.error('[nezha] agent EXITED, code=' + code + ', signal=' + signal));
    }
  } catch (e) {
    console.error('[nezha] startNezha failed:', e && e.message);
  }
}

// 6. 启动 WARP
function startWarp() {
  if (WARP) {
    try {
      const wgConfPath = '/etc/wireguard/wgcf.conf';
      if (fs.existsSync(wgConfPath)) {
        let conf = fs.readFileSync(wgConfPath, 'utf-8');
        if (!conf.includes('MTU')) {
          conf = conf.replace('[Interface]', '[Interface]\nMTU = 1280');
          fs.writeFileSync(wgConfPath, conf, 'utf-8');
        }
      }
    } catch (_) {}

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
  console.log(`Server listening on port ${PORT}`);
  backgroundInit();
});
