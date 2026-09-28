'use strict';
/*
 * H.264 端到端集成测试
 *
 * 验证的不是解码器单元，而是整条真实链路：
 *
 *   本脚本（假被控端，TCP:8081）
 *        │  发 vcfg + 真实 H.264 帧
 *        ▼
 *   中继服务器
 *        │  WebSocket
 *        ▼
 *   真实的 controller/index.html（无头 Chrome 里跑）
 *        │  用 h264-decoder.js 解码
 *        ▼
 *   canvas 真的画出东西
 *
 * 流程：
 *   1. 无头 Chrome 打开 test-h264.html，从页面里取出一段浏览器真实编出来的 H.264
 *   2. 本脚本以被控端身份接入服务器，等待控制端
 *   3. 无头 Chrome 打开 index.html?code=XXX 作为控制端
 *   4. 控制端请求 H.264 -> 本脚本回 vcfg + 循环推帧
 *   5. 读控制端页面上的编码标签、帧率、以及 canvas 像素，判断是否真的解出来了
 *
 *   node test-h264-e2e.js
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HTTP_PORT = parseInt(process.env.E2E_HTTP_PORT || '8080', 10);
const TCP_PORT = parseInt(process.env.E2E_TCP_PORT || '8081', 10);
const CDP_PORT = 9224;
const ROOM = 'E2E' + Math.floor(Math.random() * 9000 + 1000);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------------- CDP 小工具 ---------------- */
function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

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
            let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
            handlers.forEach((h) => h(m));
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

async function cdpConnect(port) {
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson(port, '/json/list');
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch (e) {}
    await sleep(250);
  }
  if (!page) throw new Error('Chrome 页面目标没出现');

  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on((msg) => {
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const cmd = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send({ id: myId, method, params: params || {} });
  });
  await cmd('Runtime.enable');

  async function evalJs(expr) {
    const r = await cmd('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面报错: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  return { cmd, evalJs, close: () => { try { ws.socket.end(); } catch (e) {} } };
}

/* ---------------- 被控端 ---------------- */
function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}
const jsonFrame = (o) => frame(0x01, Buffer.from(JSON.stringify(o), 'utf8'));

/* 把一段 H.264 分片按控制端要求的格式打包：10 字节头 + AVCC 数据 */
function buildH264Frame(nalBytes, isKey, pts) {
  const out = Buffer.alloc(10 + nalBytes.length);
  out[0] = 0x02;
  out[1] = isKey ? 1 : 0;
  out.writeUInt32BE(Math.floor(pts / 4294967296), 2);
  out.writeUInt32BE(pts >>> 0, 6);
  nalBytes.copy(out, 10);
  return out;
}

(async function main() {
  console.log('=== H.264 端到端集成测试 ===\n');

  const profile = path.join(os.tmpdir(), 'ra-e2e-' + Date.now());
  let chrome = null, cdp = null, agent = null;

  try {
    /* ---- 0. 确认服务器在跑 ---- */
    console.log('[0] 检查服务器');
    try {
      const h = await new Promise((res, rej) => {
        const r = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/health' },
          (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res(JSON.parse(d))); });
        r.on('error', rej);
      });
      ok('服务器在线', h.ok === true);
    } catch (e) {
      ok('服务器在线', false, '请先运行 node server.js');
      throw new Error('服务器没起来');
    }

    /* ---- 1. 用浏览器真实编一段 H.264 ---- */
    console.log('\n[1] 生成真实 H.264 测试流');
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      'http://127.0.0.1:' + HTTP_PORT + '/test-h264.html',
    ], { stdio: 'ignore' });

    cdp = await cdpConnect(CDP_PORT);

    let stream = null;
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evalJs('window.__streamReady === true');
      if (ready) { stream = await cdp.evalJs('JSON.stringify(window.__stream)'); break; }
      await sleep(300);
    }
    ok('取到 H.264 测试流', !!stream);
    if (!stream) throw new Error('页面没能生成测试流');

    stream = JSON.parse(stream);
    const frames = stream.frames.map((f) => ({
      key: f.key, ts: f.ts, data: Buffer.from(f.b64, 'base64'),
    }));
    ok('流内容合理', frames.length > 0 && frames[0].key === true,
      frames.length + ' 帧，首帧' + (frames[0] && frames[0].key ? '是' : '不是') + '关键帧');

    /* ---- 2. 以被控端身份接入 ---- */
    console.log('\n[2] 被控端接入中继');
    agent = net.connect(TCP_PORT, '127.0.0.1');
    await new Promise((res, rej) => { agent.on('connect', res); agent.on('error', rej); });
    agent.setNoDelay(true);
    agent.write(jsonFrame({ t: 'hello', room: ROOM, name: 'E2E 假被控端' }));

    let ctrlCount = 0;
    let agentBuf = Buffer.alloc(0);
    agent.on('data', (c) => {
      agentBuf = Buffer.concat([agentBuf, c]);
      while (agentBuf.length >= 5) {
        const len = agentBuf.readUInt32BE(0);
        if (agentBuf.length < 5 + len) break;
        const type = agentBuf.readUInt8(4);
        const payload = agentBuf.subarray(5, 5 + len);
        agentBuf = agentBuf.subarray(5 + len);
        if (type !== 0x01) continue;
        let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
        if (m.t === 'controller-joined') ctrlCount++;
        if (m.t === 'codec') {
          if (m.v === 'h264') {
            // 先把画面尺寸和编码参数发过去
            agent.write(jsonFrame({
              t: 'meta', w: stream.w, h: stream.h,
              sw: stream.w, sh: stream.h, codec: 'h264',
              name: 'E2E 假被控端',
            }));
            agent.write(jsonFrame({
              t: 'vcfg', codec: stream.codec, desc: stream.desc,
              w: stream.w, h: stream.h,
            }));
          }
        }
      }
    });
    await sleep(300);
    ok('被控端已配对', true);

    /* ---- 3. 打开真实控制端页面 ---- */
    console.log('\n[3] 控制端页面接入');
    await cdp.cmd('Page.navigate', {
      url: 'http://127.0.0.1:' + HTTP_PORT + '/?code=' + ROOM,
    });
    await sleep(1200);

    // 点「连接」按钮
    await cdp.evalJs('document.getElementById("go").click(); true');
    await sleep(1500);
    ok('控制端已进入会话页',
      await cdp.evalJs('document.getElementById("session").classList.contains("on")'));
    ok('被控端收到 controller-joined', ctrlCount > 0, '收到 ' + ctrlCount + ' 次');

    /* ---- 4. 持续推帧 ---- */
    console.log('\n[4] 推送 H.264 画面');
    let sent = 0;
    const pushTimer = setInterval(() => {
      for (const f of frames) {
        agent.write(frame(0x02, buildH264Frame(f.data, f.key, f.ts)));
        sent++;
      }
    }, 200);

    await sleep(4000);

    const tag = await cdp.evalJs('document.getElementById("codecTag").textContent');
    const stats = await cdp.evalJs('document.getElementById("stats").textContent');
    const overlayHidden = await cdp.evalJs(
      'document.getElementById("overlay").classList.contains("hide")');

    ok('控制端切到了 H.264', tag === 'H.264', '当前标签: ' + tag);
    ok('遮罩已隐藏（说明画面到了）', overlayHidden === true);

    const fpsNum = parseInt((stats || '0').split(' ')[0], 10) || 0;
    ok('画面帧率大于 0', fpsNum > 0, 'stats = "' + stats + '"');

    /* ---- 5. canvas 真的被画上了吗 ---- */
    console.log('\n[5] 画面内容检查');
    const px = await cdp.evalJs(`(function(){
      var c = document.getElementById('view');
      var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      var nonBlack = 0, total = 0;
      for (var i = 0; i < d.length; i += 4*211) {
        total++;
        if (d[i] > 10 || d[i+1] > 10 || d[i+2] > 10) nonBlack++;
      }
      return JSON.stringify({w:c.width, h:c.height, nonBlack:nonBlack, total:total});
    })()`);
    const info = JSON.parse(px);
    ok('canvas 尺寸正确', info.w === stream.w && info.h === stream.h,
      info.w + 'x' + info.h + '（期望 ' + stream.w + 'x' + stream.h + '）');
    ok('canvas 上确实有画面', info.nonBlack > info.total * 0.5,
      info.nonBlack + '/' + info.total + ' 个采样点非黑');

    /* ---- 6. 切换回 JPEG 也要能工作 ---- */
    console.log('\n[6] 切回 JPEG');
    await cdp.evalJs(`(function(){
      var b = document.querySelector('#qSheet [data-codec="jpeg"]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(1500);
    const tag2 = await cdp.evalJs('document.getElementById("codecTag").textContent');
    ok('能切回 JPEG', tag2 === 'JPEG', '当前标签: ' + tag2);

    clearInterval(pushTimer);
    console.log('\n推送了 ' + sent + ' 帧 H.264');
  } catch (e) {
    fail++;
    console.error('\n测试异常:', e.message);
  } finally {
    try { if (agent) agent.destroy(); } catch (e) {}
    try { if (cdp) cdp.close(); } catch (e) {}
    try { if (chrome) chrome.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})();
