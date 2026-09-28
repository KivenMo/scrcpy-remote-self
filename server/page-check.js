'use strict';
/*
 * 用 Chrome DevTools Protocol 驱动无头浏览器打开一个页面，做一步操作，
 * 等真实时间，再把页面里的状态读回来。开发和排查用。
 *
 *   node page-check.js <url> [等待毫秒] [操作表达式] [读取表达式]
 *
 * 例：打开控制端并点「连接」，然后看编码标签和帧率
 *   node page-check.js "http://127.0.0.1:8080/?code=DEMO1234" 6000 \
 *     'document.getElementById("go").click(); true' \
 *     'document.getElementById("codecTag").textContent'
 *
 * 之所以不用 --dump-dom + --virtual-time-budget：虚拟时钟会把 setTimeout 快进，
 * 但 WebCodecs 的解码是真线程上跑的真活儿，等不到。
 */

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = process.argv[2];
const WAIT_MS = parseInt(process.argv[3] || '9000', 10);
const ACTION = process.argv[4] || '';
const EXPR = process.argv[5]
  || 'JSON.stringify({summary:document.getElementById("summary").textContent,'
   + 'rows:Array.from(document.querySelectorAll(".row")).map(function(r){'
   + 'return r.querySelector(".tag").textContent+" | "+r.querySelector(".msg").textContent;})})';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

/* 极简 WebSocket 客户端（只用来发 CDP 命令） */
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new global.URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      const handlers = [];
      socket.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 2) {
          const b0 = buf[0], b1 = buf[1];
          const op = b0 & 0x0f;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);
          if (op === 0x01) {
            let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
            handlers.forEach((h) => h(msg));
          }
        }
      });
      resolve({
        socket,
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const len = payload.length;
          let head;
          if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
          else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
          else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
          head[0] = 0x81;
          const mask = crypto.randomBytes(4);
          const m = Buffer.from(payload);
          for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
          socket.write(Buffer.concat([head, mask, m]));
        },
        on(h) { handlers.push(h); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async function main() {
  const profile = path.join(os.tmpdir(), 'ra-cdp-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    URL_,
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    // 等页面目标出现，并且拿到它自己的调试地址（Runtime 域只在页面级可用）
    let page = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await getJson('/json/list');
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) break;
      } catch (e) { /* 还没起来 */ }
      await sleep(250);
    }
    if (!page) throw new Error('Chrome 页面目标没出现');

    ws = await wsConnect(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.on((msg) => {
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    function cmd(method, params) {
      const myId = ++id;
      return new Promise((resolve) => {
        pending.set(myId, resolve);
        ws.send({ id: myId, method, params: params || {} });
      });
    }

    await cmd('Runtime.enable');
    await sleep(1200);

    if (ACTION) {
      // awaitPromise：操作表达式可以写成 async IIFE，做「点一下 -> 等 -> 再点一下」
      // 这种多步动作。不加的话表达式返回的 Promise 不会被等待。
      const ar = await cmd('Runtime.evaluate', {
        expression: ACTION, returnByValue: true, awaitPromise: true,
      });
      if (ar.result && ar.result.exceptionDetails) {
        throw new Error('操作表达式报错: '
          + JSON.stringify(ar.result.exceptionDetails).slice(0, 300));
      }
    }

    await sleep(WAIT_MS);

    const res = await cmd('Runtime.evaluate', { expression: EXPR, returnByValue: true });

    const val = res.result && res.result.result && res.result.result.value;
    if (val === undefined || val === null) {
      throw new Error('拿不到结果: ' + JSON.stringify(res).slice(0, 400));
    }
    console.log(val);
  } catch (e) {
    console.error('驱动失败:', e.message);
    process.exitCode = 2;
  } finally {
    try { if (ws) ws.socket.end(); } catch (e) {}
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
