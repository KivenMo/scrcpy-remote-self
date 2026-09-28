'use strict';
/*
 * 远程协助中继服务器
 *
 *   8080  HTTP + WebSocket  ->  浏览器控制端（iPhone Safari 直接打开）
 *   8081  原始 TCP 长连接    ->  安卓被控端 App
 *
 * 服务器只做“配对 + 转发”，不解码画面、不落盘。
 * 两端都是主动外连，所以不需要公网 IP，也不需要 NAT 打洞。
 *
 * 零第三方依赖：WebSocket 服务端按 RFC6455 自己实现。
 *
 *   node server.js                  # 默认 0.0.0.0:8080 / 8081
 *   HTTP_PORT=9000 node server.js   # 自定义端口
 *
 * ── 加密（放到公网前必须开）─────────────────────────────────────────
 *   不加任何环境变量时是明文。明文只适合局域网/本机调试：配对码、屏幕画面、
 *   你输入的密码全都在线上裸奔。要暴露到公网，必须给证书：
 *
 *   TLS_CERT=/etc/ssl/relay/fullchain.pem \
 *   TLS_KEY=/etc/ssl/relay/privkey.pem   node server.js
 *
 *   同一个证书会同时用于：
 *     · 控制端  https + wss      （浏览器看到的是 wss://，页面自己会切）
 *     · 被控端  TLS 包一层 TCP   （App 里要勾「加密连接」）
 *
 *   只想给控制端加密、被控端仍走明文（比如被控端在可信内网）：
 *   TLS_AGENT=0
 *
 *   被控端想用另一张证书：
 *   TLS_TCP_CERT=... TLS_TCP_KEY=...
 *
 *   自签证书也能用：App 端第一次连接会把指纹记下来（TOFU），之后严格比对。
 *   想省掉这个信任过程，就把 tools/make-cert.sh 打印的指纹填进 App。
 *
 *   TRUST_PROXY=1  当自己前面挂了 nginx/caddy 时打开，这样日志和 /health
 *                  里记的是真实客户端 IP，并且能识别 X-Forwarded-Proto。
 *
 * ── 猜配对码限流（放到公网前建议一起开）─────────────────────────────
 *   默认就是开着的，按 IP 计「窗口内试过多少个不同的错误配对码」，
 *   正常用户用同一个码反复重试永远踩不到。参数见下面 RATE_LIMIT_* 一节。
 *
 * ── /health 会泄露在线配对码（放到公网前必须处理）────────────────────
 *   默认 /health 是公开的，里面 rooms[].code 就是当前在线被控端的配对码。
 *   公网上等于把答案直接贴出来，务必设一个令牌：
 *
 *   HEALTH_TOKEN=<一段随机串>   node server.js
 *
 *   设了之后不带 ?token= 的请求拿不到 rooms（其它字段照常返回），
 *   这样 nginx 的健康检查还能用，猜码的人拿不到答案。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
const TCP_PORT = parseInt(process.env.TCP_PORT || '8081', 10);
const MAX_FRAME = 8 * 1024 * 1024; // 单帧上限 8MB，防止内存被撑爆

// 反向代理后面才敢信 X-Forwarded-*，否则客户端能随便伪造
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

// 设了之后 /health 不再返回 rooms[].code，除非带 ?token= 或 Authorization: Bearer
const HEALTH_TOKEN = process.env.HEALTH_TOKEN || '';

const CONTROLLER_DIR = path.join(__dirname, '..', 'controller');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------------ *
 * 证书加载
 *
 * 返回 { cert, key } 或 null。任何一步出问题都只警告、不崩溃 ——
 * 宁可退化成明文并大声提醒，也不要让服务器起不来把人挡在门外。
 * ------------------------------------------------------------------ */
function loadTls(certVar, keyVar) {
  const certFile = process.env[certVar];
  const keyFile = process.env[keyVar];
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) {
    console.log(`[警告] ${certVar} 和 ${keyVar} 必须成对设置，只给了一个，已忽略。`);
    return null;
  }
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (e) {
    console.log(`[警告] 读证书失败（${certFile} / ${keyFile}）：${e.message}`);
    return null;
  }
}

const TLS_OPTS = { minVersion: 'TLSv1.2' };

/** 控制端（https/wss）用的证书 */
const WEB_TLS = loadTls('TLS_CERT', 'TLS_KEY');
/** 被控端（TLS over TCP）用的证书。没单独给就复用控制端那张。 */
const AGENT_TLS = process.env.TLS_AGENT === '0'
  ? null
  : (loadTls('TLS_TCP_CERT', 'TLS_TCP_KEY') || WEB_TLS);

/* ------------------------------------------------------------------ *
 * 房间：一个房间 = 一个安卓被控端 + N 个控制端
 * ------------------------------------------------------------------ */
const rooms = new Map(); // code -> { agent, controllers:Set, createdAt, device }

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
}

function makeCode() {
  // 去掉容易看错的 0/O/1/I，长度 8，暴力猜的成本足够高
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

/** 证书指纹，大写十六进制。和 App 端、tools/make-cert.sh 的格式保持一致。 */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

/**
 * 日志里记的客户端地址。
 * 挂了反代时 socket.remoteAddress 永远是 127.0.0.1，没意义，所以 TRUST_PROXY=1
 * 时改看 X-Forwarded-For。默认不看 —— 否则客户端随便编一个 IP 就能污染日志。
 */
function clientIp(req, socket) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return socket.remoteAddress;
}

/* ------------------------------------------------------------------ *
 * 猜配对码限流
 *
 * 为什么需要：TLS 保证的是「传输过程不被偷看篡改」，配对码本身还是可以被猜。
 * 控制端 join 一个不存在的码，服务器会顺手把房间建出来（这是为了兼容「先开
 * 控制端、后被控端才上线」的顺序），所以一次猜测的成本只是「一条 WebSocket
 * 连接 + 一个小 JSON」，非常便宜。被控端口子更糟：拿一个码连上来会**顶掉**
 * 原来在线的被控端（这是为了治僵尸连接留的机制），所以猜中一个码就等于把真
 * 被控端挤下线、并开始接管控制端发来的按键。
 *
 * 判「失败」的口径，两端不同（因为两端的「成功」定义不同）：
 *   · 控制端：连进去发现房间里没有在线被控端      —— 失败
 *   · 被控端：连上去把原来在线的被控端顶掉了      —— 失败
 *
 * 闸门卡的是「窗口内试过的**不同**配对码个数」，不是「总次数」。
 * 原因是正常用户和攻击者的行为特征正好相反：正常用户是拿**同一个**码反复重试
 * （被控端还没上线、打错了又改回来），攻击者必须试**很多个不同的**码。
 * 按「不同码」计数，正常用户永远踩不到闸，攻击者几十秒就撞墙。
 *
 * 环境变量：
 *   RATE_LIMIT_DISTINCT   窗口内允许试多少个不同的错误配对码（默认 6）
 *   RATE_LIMIT_TRIES      窗口内允许的总尝试次数（默认 80，防拿同一个码刷连接）
 *   RATE_LIMIT_WINDOW_MS  统计窗口（默认 300000，即 5 分钟）
 *   RATE_LIMIT_BLOCK_MS   触发后封禁多久（默认 600000，即 10 分钟）
 *   RATE_LIMIT=0          完全关掉（只在可信内网调试时用）
 *
 * ⚠ 这里按 IP 计数。前面挂了反代就**必须** TRUST_PROXY=1，否则所有客户端在
 *   服务器眼里都是 127.0.0.1，一个人触发封禁会把所有人一起封掉。
 *   被控端那条链路走的是裸 TCP/TLS，没有 HTTP 头可以取，反代下只能看到
 *   反代自己的 IP —— 这一点没法在应用层解决，公网部署请给被控端端口做 IP 白名单。
 * ------------------------------------------------------------------ */
const RL_DISTINCT = parseInt(process.env.RATE_LIMIT_DISTINCT || '6', 10);
const RL_TRIES = parseInt(process.env.RATE_LIMIT_TRIES || '80', 10);
const RL_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '300000', 10);
const RL_BLOCK = parseInt(process.env.RATE_LIMIT_BLOCK_MS || '600000', 10);
const RL_OFF = process.env.RATE_LIMIT === '0' || process.env.RATE_LIMIT === 'false';

const guards = new Map(); // ip -> { codes:Map<code,ts>, tries, first, blockedUntil, refusedAt }

function guardCheck(ip) {
  if (RL_OFF) return null;
  const g = guards.get(ip);
  if (!g) return null;
  const now = Date.now();
  if (g.blockedUntil > now) {
    // 封禁期间客户端会带着退避一直重连，这里限流打印，别把日志刷爆
    if (now - (g.refusedAt || 0) > 10000) {
      g.refusedAt = now;
      log(`⛔ 拒绝配对请求 ${ip}（封禁中，还剩 ${Math.ceil((g.blockedUntil - now) / 1000)} 秒）`);
    }
    return g.blockedUntil - now;
  }
  if (g.blockedUntil) guards.delete(ip); // 封禁刚过，重新开一个干净窗口
  return null;
}

/** 记一次失败。同一个码重复试只算一个「不同码」。返回是否刚好触发封禁。 */
function guardFail(ip, code) {
  if (RL_OFF) return false;
  const now = Date.now();
  let g = guards.get(ip);
  if (!g) { g = { codes: new Map(), tries: 0, first: now, blockedUntil: 0, refusedAt: 0 }; guards.set(ip, g); }
  if (now - g.first > RL_WINDOW) { g.codes.clear(); g.tries = 0; g.first = now; }

  g.codes.set(code, now);
  g.tries++;

  const hitDistinct = g.codes.size >= RL_DISTINCT;
  const hitTries = g.tries >= RL_TRIES;
  if (!hitDistinct && !hitTries) return false;

  g.blockedUntil = now + RL_BLOCK;
  g.refusedAt = 0;
  const why = hitDistinct
    ? `窗口内试了 ${g.codes.size} 个不同的配对码`
    : `窗口内试了 ${g.tries} 次`;
  log(`⛔ 疑似在猜配对码，封禁 ${Math.round(RL_BLOCK / 1000)} 秒：${ip}（${why}）`);
  return true;
}

/** 成功一次就把这个 IP 的账清掉 —— 正常用户不该被历史失败拖着。 */
function guardOk(ip) {
  if (RL_OFF) return;
  guards.delete(ip);
}

/** 定期回收，别让 guards 无限长。unref 让它不挡着进程退出。 */
setInterval(() => {
  const now = Date.now();
  const ttl = Math.max(RL_WINDOW, RL_BLOCK) * 2;
  for (const [ip, g] of guards) {
    const last = Math.max(g.first, g.blockedUntil, ...g.codes.values());
    if (now - last > ttl) guards.delete(ip);
  }
}, 60000).unref();

function sendJson(sock, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(0x01, 4);
  try { sock.write(Buffer.concat([head, payload])); } catch (_) {}
}

function sendBinary(sock, buf) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(buf.length, 0);
  head.writeUInt8(0x02, 4);
  try { sock.write(Buffer.concat([head, buf])); } catch (_) {}
}

/** 给 WebSocket 控制端发 JSON —— 注意用的是 WS 帧，不是 TCP 帧。 */
function wsSendJson(client, obj) {
  try {
    if (client && client.sock && client.sock.writable) {
      client.sock.write(textWsFrame(JSON.stringify(obj)));
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * 安卓被控端：TCP 长连接（配了证书就是 TLS over TCP）
 *
 * 这个回调对 net 和 tls 是通用的：TLS 握手在拿到 socket 之前就完成了，
 * 所以下面的收发逻辑一个字都不用改。
 * ------------------------------------------------------------------ */
function onAgentSocket(sock) {
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 15000);
  let buf = Buffer.alloc(0);
  let room = null;
  let helloSent = false;

  // TLS 下把「我们出示的是哪张证书」记进日志，排查「App 里指纹对不上」时能直接比对。
  // 注意用 getCertificate() 而不是 getPeerCertificate()：后者返回的是**对端**的证书，
  // 我们没要求客户端证书，所以它永远是空的（第一版就写错在这里，日志一条都不出）。
  if (typeof sock.getCertificate === 'function') {
    try {
      const c = sock.getCertificate();
      if (c && c.raw) {
        log(`被控端 TLS 已建立，服务器证书指纹 ${sha256Hex(c.raw)}`);
      }
    } catch (_) {}
  }

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) { sock.destroy(); return; }
      if (buf.length < 5 + len) break;
      const type = buf.readUInt8(4);
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      handleAgentFrame(sock, type, payload);
    }
  });

  function handleAgentFrame(sock, type, payload) {
    // 第一帧必须是 hello
    if (!helloSent) {
      if (type !== 0x01) { sock.destroy(); return; }
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { sock.destroy(); return; }
      if (msg.t !== 'hello') { sock.destroy(); return; }

      const code = String(msg.room || '').toUpperCase().trim();
      if (!/^[A-Z0-9]{4,16}$/.test(code)) { sock.destroy(); return; }

      const ip = sock.remoteAddress || '?';
      const wait = guardCheck(ip);
      if (wait) {
        sendJson(sock, { t: 'error', msg: `配对尝试次数过多，请等 ${Math.ceil(wait / 1000)} 秒后再试` });
        sock.destroy();
        return;
      }

      room = code;
      helloSent = true;
      let r = rooms.get(code);
      if (!r) { r = { agent: null, controllers: new Set(), createdAt: Date.now(), device: '', mode: 'video' }; rooms.set(code, r); }
      // 「顶掉旧被控端」是治僵尸连接的必要机制（手机换网时旧 socket 可能半死着，
      // 不顶掉就永远连不回来），所以保留；但它同时是猜码的判定信号 ——
      // 只有猜中一个**真的在线**的码，才会走到这里。
      const kicked = !!(r.agent && r.agent !== sock);
      if (kicked) {
        try { r.agent.destroy(); } catch (_) {}
        log(`⚠ 同一配对码来了第二个被控端，已顶掉旧的 room=${code} (${ip})`);
        guardFail(ip, code);
      }
      r.agent = sock;
      r.device = msg.name || 'android';
      // 被控端可以声明自己是什么模式：
      //   video      = 有录屏，控制端能看到画面（默认，兼容老客户端）
      //   unattended = 只跑无障碍指令、没有录屏，控制端看到的是界面文字
      r.mode = msg.mode === 'unattended' ? 'unattended' : 'video';
      log(`被控端上线 room=${code} device=${r.device} mode=${r.mode} (${sock.remoteAddress})`);
      sendJson(sock, { t: 'paired', room: code });
      for (const c of r.controllers) {
        wsSendJson(c, { t: 'agent-online', device: r.device, mode: r.mode });
      }
      return;
    }

    const r = rooms.get(room);
    if (!r) return;

    if (type === 0x02) {                       // JPEG 画面 -> 广播给所有控制端
      for (const c of r.controllers) {
        if (c.sock.writable) {
          try { c.sock.write(binaryWsFrame(payload)); } catch (_) {}
        }
      }
    } else {                                    // JSON -> 广播
      const text = payload.toString('utf8');
      for (const c of r.controllers) {
        if (c.sock.writable) {
          try { c.sock.write(textWsFrame(text)); } catch (_) {}
        }
      }
    }
  }

  const cleanup = () => {
    if (room) {
      const r = rooms.get(room);
      if (r && r.agent === sock) {
        r.agent = null;
        log(`被控端下线 room=${room}`);
        for (const c of r.controllers) wsSendJson(c, { t: 'agent-offline' });
        if (r.controllers.size === 0) rooms.delete(room);
      }
    }
  };
  sock.on('close', cleanup);
  sock.on('error', cleanup);
}

const tcpServer = AGENT_TLS
  ? tls.createServer(Object.assign({}, TLS_OPTS, AGENT_TLS), onAgentSocket)
  : net.createServer(onAgentSocket);

if (AGENT_TLS) {
  // 握手失败通常就是「App 没勾加密」或者「指纹对不上」，值得单独报出来。
  //
  // 但要限流：被控端会以指数退避重连，一个配错的客户端能稳定刷出
  // 每秒一条的错误（实测旧版明文 APK 打 TLS 口，1 秒 1 条刷了 5 分钟）。
  // 这里每 30 秒最多报一条，中间攒下的条数合并成一句。
  let tlsErrAt = 0, tlsErrCount = 0;
  tcpServer.on('tlsClientError', (err, sock) => {
    tlsErrCount++;
    const now = Date.now();
    if (now - tlsErrAt < 30000) return;
    const extra = tlsErrCount > 1 ? `（另有 ${tlsErrCount - 1} 次同样的失败被合并）` : '';
    tlsErrAt = now;
    tlsErrCount = 0;
    log(`被控端 TLS 握手失败：${err.message.trim()} (${sock && sock.remoteAddress})${extra}`);
    log('  → 多半是被控端 App 没勾「加密连接」，或者里面填的证书指纹和服务器对不上。');
  });
}

/* ------------------------------------------------------------------ *
 * WebSocket 服务端（RFC6455 最小实现：文本 + 二进制 + ping/pong + close）
 * ------------------------------------------------------------------ */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([head, payload]);
}
const textWsFrame = (s) => wsFrame(0x01, Buffer.from(s, 'utf8'));
const binaryWsFrame = (b) => wsFrame(0x02, b);
const closeWsFrame = () => wsFrame(0x08, Buffer.alloc(0));
const pongWsFrame = (b) => wsFrame(0x0A, b);

/* ------------------------------------------------------------------ *
 * HTTP：托管控制端页面 + WebSocket 升级
 * ------------------------------------------------------------------ */
function handleHttp(req, res) {
  const url = (req.url || '/').split('?')[0];

  if (url === '/health') {
    // rooms[].code 就是当前在线被控端的配对码。公网不设令牌等于把答案贴出来，
    // 那样再好的限流也没意义 —— 猜都不用猜。
    const auth = req.headers.authorization || '';
    const token = (req.url || '').match(/[?&]token=([^&]+)/);
    const okToken = HEALTH_TOKEN
      ? ((token && decodeURIComponent(token[1]) === HEALTH_TOKEN)
         || auth === 'Bearer ' + HEALTH_TOKEN)
      : true;

    const body = {
      ok: true,
      tls: { web: !!WEB_TLS, agent: !!AGENT_TLS },
      rateLimit: RL_OFF
        ? { enabled: false }
        : { enabled: true, distinct: RL_DISTINCT, tries: RL_TRIES,
            windowMs: RL_WINDOW, blockMs: RL_BLOCK, tracked: guards.size },
      uptime: Math.floor(process.uptime()),
    };
    if (okToken) {
      body.rooms = [...rooms.entries()].map(([code, r]) => ({
        code,
        device: r.device,
        agent: !!r.agent,
        mode: r.mode || 'video',
        controllers: r.controllers.size,
      }));
    } else {
      // 不报 401，免得告诉扫描器「这里有个要口令的东西」
      body.roomsHidden = true;
      body.rooms = [];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (url === '/' || url === '/index.html') {
    return serveStatic('/index.html', res);
  }

  // controller/ 目录下的其它静态文件（h264-decoder.js、自测页等）
  if (/^\/[A-Za-z0-9_.-]+$/.test(url)) {
    return serveStatic(url, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

const httpServer = WEB_TLS
  ? https.createServer(Object.assign({}, TLS_OPTS, WEB_TLS), handleHttp)
  : http.createServer(handleHttp);

function serveStatic(url, res) {
  const name = url.replace(/^\/+/, '');
  const full = path.join(CONTROLLER_DIR, name);
  // 防止 ../ 越界
  if (!full.startsWith(CONTROLLER_DIR)) {
    res.writeHead(403); res.end('403'); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到 ' + name);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const client = { sock: socket, room: null, alive: true, wants: 'controller' };
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragParts = [];

  function sendToAgent(obj) {
    const r = rooms.get(client.room);
    if (r && r.agent && r.agent.writable) sendJson(r.agent, obj);
  }

  /** 控制端发来的二进制（文件分片）原样转给被控端 */
  function sendBinaryToAgent(buf) {
    const r = rooms.get(client.room);
    if (r && r.agent && r.agent.writable) sendBinary(r.agent, buf);
  }

  function onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }

    if (msg.t === 'hello') {
      const code = String(msg.room || '').toUpperCase().trim();
      if (!/^[A-Z0-9]{4,16}$/.test(code)) {
        socket.write(textWsFrame(JSON.stringify({ t: 'error', msg: '配对码格式不对' })));
        return;
      }
      const ip = clientIp(req, socket);
      const wait = guardCheck(ip);
      if (wait) {
        // 带上 retryAfterMs：控制端会据此把重连推迟到解封之后。
        // 不带的话它会 800ms 一次地一直撞墙（WebSocket 握手是成功的，
        // 所以它的退避计数每次都被清零，退避形同虚设）。
        socket.write(textWsFrame(JSON.stringify({
          t: 'error',
          msg: `配对尝试次数过多，请等 ${Math.ceil(wait / 1000)} 秒后再试`,
          retryAfterMs: wait,
        })));
        socket.end();
        return;
      }
      // 离开旧房间
      if (client.room && rooms.has(client.room)) {
        const old = rooms.get(client.room);
        old.controllers.delete(client);
        if (!old.agent && old.controllers.size === 0) rooms.delete(client.room);
      }
      client.room = code;
      let r = rooms.get(code);
      if (!r) { r = { agent: null, controllers: new Set(), createdAt: Date.now(), device: '', mode: 'video' }; rooms.set(code, r); }
      r.controllers.add(client);

      // 连进来时房间里有没有在线被控端，就是「这个码对不对」的判据。
      // 有 -> 正常用户，清掉这个 IP 的历史失败；没有 -> 记一次，够多就封。
      if (r.agent) guardOk(ip); else guardFail(ip, code);

      log(`控制端加入 room=${code} (${ip})  共 ${r.controllers.size} 个控制端`);

      socket.write(textWsFrame(JSON.stringify({
        t: 'welcome',
        room: code,
        agent: !!r.agent,
        device: r.device,
        mode: r.mode || 'video',
      })));
      if (r.agent) sendJson(r.agent, { t: 'controller-joined' });
      return;
    }

    if (msg.t === 'bye') { socket.end(); return; }

    // 其余一律转发给被控端
    sendToAgent(msg);
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) { socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;

      let mask = null;
      if (masked) { mask = buf.subarray(off, off + 4); off += 4; }
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(need);

      if (opcode === 0x08) { socket.end(); return; }
      if (opcode === 0x09) { socket.write(pongWsFrame(payload)); continue; }
      if (opcode === 0x0A) { client.alive = true; continue; }

      if (opcode === 0x00) { // continuation
        fragParts.push(payload);
        if (fin) {
          const full = Buffer.concat(fragParts);
          fragParts = [];
          if (fragOpcode === 0x01) onText(full.toString('utf8'));
          fragOpcode = 0;
        }
        continue;
      }
      if (!fin) { fragOpcode = opcode; fragParts = [payload]; continue; }
      if (opcode === 0x01) onText(payload.toString('utf8'));
      else if (opcode === 0x02) sendBinaryToAgent(payload);
    }
  });

  const cleanup = () => {
    if (client.room && rooms.has(client.room)) {
      const r = rooms.get(client.room);
      r.controllers.delete(client);
      log(`控制端离开 room=${client.room}  剩 ${r.controllers.size} 个`);
      if (!r.agent && r.controllers.size === 0) rooms.delete(client.room);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('end', cleanup);
}

httpServer.on('upgrade', handleUpgrade);

/* 心跳：踢掉死连接 */
setInterval(() => {
  for (const [, r] of rooms) {
    for (const c of r.controllers) {
      if (!c.alive) { try { c.sock.destroy(); } catch (_) {} continue; }
      c.alive = false;
      try { c.sock.write(wsFrame(0x09, Buffer.alloc(0))); } catch (_) {}
    }
  }
}, 30000);

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  if (AGENT_TLS) {
    log(`被控端接入端口  TLS   0.0.0.0:${TCP_PORT}   （App 里要勾「加密连接」）`);
  } else {
    log(`被控端接入端口  TCP   0.0.0.0:${TCP_PORT}   ⚠ 明文`);
  }
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  const scheme = WEB_TLS ? 'https' : 'http';
  log(`控制端访问地址  ${scheme.toUpperCase().padEnd(5)} 0.0.0.0:${HTTP_PORT}`);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        log(`  局域网可用： ${scheme}://${ni.address}:${HTTP_PORT}`);
      }
    }
  }
  log('在安卓手机上打开被控端 App 拿到配对码，然后在 iPhone Safari 里输入即可。');

  if (RL_OFF) {
    log('⚠ 猜配对码限流已关闭（RATE_LIMIT=0）。只在可信内网这么干。');
  } else {
    log(`猜配对码限流：窗口 ${Math.round(RL_WINDOW / 1000)} 秒内试满 `
      + `${RL_DISTINCT} 个不同的错码（或累计 ${RL_TRIES} 次）就封 ${Math.round(RL_BLOCK / 1000)} 秒。`);
    if (!TRUST_PROXY) {
      log('  · 按 IP 计数。前面挂了反代的话记得 TRUST_PROXY=1，否则所有人共用一个 IP 计数。');
    }
  }

  if (!HEALTH_TOKEN) {
    log('');
    log('┌────────────────────────────────────────────────────────────┐');
    log('│  ⚠  /health 是公开的，里面 rooms[].code 就是在线配对码。    │');
    log('│     局域网调试无所谓；放到公网请设 HEALTH_TOKEN=<随机串>，  │');
    log('│     否则猜码的人直接读一下就知道答案了。                    │');
    log('└────────────────────────────────────────────────────────────┘');
    log('');
  } else {
    log('/health 已加令牌：不带 ?token= 拿不到 rooms（健康检查仍可用）。');
  }

  if (!WEB_TLS || !AGENT_TLS) {
    const missing = [];
    if (!WEB_TLS) missing.push('控制端 http/ws');
    if (!AGENT_TLS) missing.push('被控端 tcp');
    log('');
    log('┌────────────────────────────────────────────────────────────┐');
    log('│  ⚠  以下链路没有加密：' + missing.join('、').padEnd(38) + '│');
    log('│                                                            │');
    log('│  只适合局域网或本机调试。放到公网之前请设置 TLS_CERT /      │');
    log('│  TLS_KEY，否则配对码、屏幕画面、你输入的密码都是明文传输，  │');
    log('│  同网络里的人可以直接看到。                                │');
    log('│  自签证书也行：bash tools/make-cert.sh                     │');
    log('└────────────────────────────────────────────────────────────┘');
    log('');
  }
});
