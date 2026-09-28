'use strict';
/*
 * 剪贴板 / 文件传输 / 自动重连 的端到端测试
 *
 * 和 test-h264-e2e.js 一样，跑的是真实控制端页面 + 真实中继，
 * 只不过被控端是本脚本假扮的，会逐条核对收到的指令和字节。
 *
 * 本脚本自己拉起一个中继（默认 8180/8181，不影响你在 8080 上跑的那个），
 * 所以不需要先手动开服务器。断线重连那一节会把中继真的杀掉再拉起来，
 * 这样才是真的断，而不是「假装断」。
 *
 *   node test-features.js
 *   E2E_HTTP_PORT=9000 E2E_TCP_PORT=9001 node test-features.js
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HTTP_PORT = parseInt(process.env.E2E_HTTP_PORT || '8180', 10);
const TCP_PORT = parseInt(process.env.E2E_TCP_PORT || '8181', 10);
const CDP_PORT = 9225;
const ROOM = 'FEA' + Math.floor(Math.random() * 90000 + 10000);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------------- 中继服务器进程 ---------------- */
let serverProc = null;

function startServer() {
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      HTTP_PORT: String(HTTP_PORT),
      TCP_PORT: String(TCP_PORT),
    }),
    stdio: 'ignore',
  });
  serverProc.on('error', () => {});
  return serverProc;
}

function killServer() {
  if (!serverProc) return Promise.resolve();
  const p = serverProc;
  serverProc = null;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    p.once('exit', done);
    try { p.kill(); } catch (e) { done(); }
    setTimeout(done, 3000);
  });
}

function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const h = await httpGetJson('/health');
      if (h && h.ok === true) return true;
    } catch (e) {}
    await sleep(200);
  }
  return false;
}

/** 等到房间里有被控端 */
async function waitAgentOnline(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const h = await httpGetJson('/health');
      const r = (h.rooms || []).find((x) => x.code === ROOM);
      if (r && r.agent) return true;
    } catch (e) {}
    await sleep(200);
  }
  return false;
}

/** 等到中继里同时有被控端和控制端 */
async function waitBothOnline(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const h = await httpGetJson('/health');
      const r = (h.rooms || []).find((x) => x.code === ROOM);
      if (r && r.agent && r.controllers >= 1) return true;
    } catch (e) {}
    await sleep(250);
  }
  return false;
}

/* ---------------- CDP ---------------- */
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

/** 用 CDP 派发一次真实触摸（可信事件，才会走浏览器的默认行为） */
async function touchTap(cdp, x, y, holdMs) {
  await cdp.cmd('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: x, y: y }],
  });
  await sleep(holdMs || 60);
  await cdp.cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function rectOf(cdp, id) {
  return JSON.parse(await cdp.evalJs(
    'JSON.stringify(document.getElementById("' + id + '").getBoundingClientRect())'));
}

/* ---------------- 假被控端 ---------------- */
function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}
const jsonFrame = (o) => frame(0x01, Buffer.from(JSON.stringify(o), 'utf8'));

/** 套上 10 字节统一帧头（kind: 0x01 JPEG / 0x02 H.264 / 0x03 文件分片） */
function wrapFrame(kind, payload) {
  const out = Buffer.alloc(10 + payload.length);
  out[0] = kind;
  out.writeUInt32BE(0, 2);
  out.writeUInt32BE(0, 6);
  payload.copy(out, 10);
  return out;
}

/* 从手机取文件用的假数据：长度故意不是 64KB 的整数倍 */
const PULL_SIZE = 300 * 1024 + 13;
const PULL_BYTE = (i) => (i * 31 + 7) & 0xFF;
const PULL_ITEMS = [
  { id: 't1', name: '照片一.jpg', size: PULL_SIZE, kind: 'image', mime: 'image/jpeg', date: '2026-09-20' },
  { id: 't2', name: '视频一.mp4', size: 4096, kind: 'video', mime: 'video/mp4', date: '2026-09-21' },
];

/** 把假文件分片推上去，复用二进制通道 */
function sendTestFile(sock, id) {
  const it = PULL_ITEMS.find((x) => x.id === id);
  if (!it) {
    sock.write(jsonFrame({ t: 'fdone', ok: false, msg: '没有这个文件' }));
    return;
  }
  sock.write(jsonFrame({ t: 'fbegin', name: it.name, size: it.size, mime: it.mime }));
  const CHUNK = 64 * 1024;
  let off = 0;
  (function step() {
    if (off >= it.size) {
      sock.write(jsonFrame({ t: 'fdone', ok: true, name: it.name }));
      return;
    }
    const n = Math.min(CHUNK, it.size - off);
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = PULL_BYTE(off + i);
    sock.write(frame(0x02, wrapFrame(0x03, buf)));
    off += n;
    setTimeout(step, 3);
  })();
}

const got = { commands: [], fileBytes: Buffer.alloc(0) };
let agentSock = null;
let agentWanted = false;

function connectAgent() {
  const s = net.connect(TCP_PORT, '127.0.0.1');
  s.on('connect', () => {
    s.setNoDelay(true);
    s.write(jsonFrame({ t: 'hello', room: ROOM, name: '功能测试机' }));
  });
  let abuf = Buffer.alloc(0);
  s.on('data', (c) => {
    abuf = Buffer.concat([abuf, c]);
    while (abuf.length >= 5) {
      const len = abuf.readUInt32BE(0);
      if (abuf.length < 5 + len) break;
      const type = abuf.readUInt8(4);
      const payload = abuf.subarray(5, 5 + len);
      abuf = abuf.subarray(5 + len);
      if (type === 0x01) {
        let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
        got.commands.push(m);
        if (m.t === 'clipget') {
          s.write(jsonFrame({ t: 'clip', src: 'clipboard', v: '手机上的验证码 8899' }));
        }
        if (m.t === 'fend') {
          s.write(jsonFrame({ t: 'status', msg: '假被控端已保存文件' }));
        }
        if (m.t === 'flist') {
          s.write(jsonFrame({ t: 'flist', items: PULL_ITEMS }));
        }
        if (m.t === 'fget') {
          sendTestFile(s, m.id);
        }
        if (m.t === 'controller-joined') {
          // 报一个确定的屏幕尺寸，好让控制端算出画布大小、方便验坐标
          s.write(jsonFrame({ t: 'meta', w: 360, h: 780, sw: 360, sh: 780, name: '功能测试机' }));
        }
        if (m.t === 'codec') {
          // 只支持 JPEG，控制端别干等 3 秒回退
          s.write(jsonFrame({ t: 'codec', v: 'jpeg' }));
        }
      } else if (type === 0x02) {
        got.fileBytes = Buffer.concat([got.fileBytes, Buffer.from(payload)]);
      }
    }
  });
  s.on('error', () => {});
  s.on('close', () => {
    // 真被控端 App 也会自己重连，这里模拟同样的行为
    if (agentWanted) setTimeout(connectAgent, 300);
  });
  agentSock = s;
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  console.log('=== 剪贴板 / 文件传输 / 自动重连 端到端测试 ===\n');

  const profile = path.join(os.tmpdir(), 'ra-feat-' + Date.now());
  let chrome = null, cdp = null;

  try {
    /* ---- 0 ---- */
    console.log('[0] 拉起中继服务器（' + HTTP_PORT + '/' + TCP_PORT + '）');
    startServer();
    ok('服务器已就绪', await waitHealth(15000), '健康检查超时');

    /* ---- 1 ---- */
    console.log('\n[1] 假被控端接入');
    agentWanted = true;
    connectAgent();
    await sleep(500);
    ok('已配对', await waitAgentOnline(8000));

    /* ---- 2 ---- */
    console.log('\n[2] 控制端页面接入');
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      'http://127.0.0.1:' + HTTP_PORT + '/?code=' + ROOM,
    ], { stdio: 'ignore' });

    cdp = await cdpConnect(CDP_PORT);
    await sleep(1000);
    await cdp.evalJs('document.getElementById("go").click(); true');
    await sleep(1500);
    ok('已进入会话页',
      await cdp.evalJs('document.getElementById("session").classList.contains("on")'));

    /* ---- 3. 剪贴板：控制端 -> 被控端 ---- */
    console.log('\n[3] 剪贴板：控制端 -> 被控端');
    await cdp.evalJs(`(function(){
      document.getElementById('bClip').click();
      document.getElementById('clipText').value = '从 iPhone 发过来的文本 ABC-123';
      document.getElementById('clipSend').click();
      return true;
    })()`);
    await sleep(700);

    const clipCmd = got.commands.filter((c) => c.t === 'clip').pop();
    ok('被控端收到剪贴板写入指令', !!clipCmd);
    ok('内容一致', clipCmd && clipCmd.v === '从 iPhone 发过来的文本 ABC-123',
      clipCmd ? JSON.stringify(clipCmd.v) : '没收到');
    ok('未要求粘贴时不带 paste 标记', clipCmd && clipCmd.paste !== true);

    // 再试一次「并粘贴」
    got.commands.length = 0;
    await cdp.evalJs(`(function(){
      document.getElementById('clipText').value = '要粘贴的内容';
      document.getElementById('clipPaste').click();
      return true;
    })()`);
    await sleep(700);
    const pasteCmd = got.commands.filter((c) => c.t === 'clip').pop();
    ok('「并粘贴」带上了 paste 标记', pasteCmd && pasteCmd.paste === true,
      pasteCmd ? JSON.stringify(pasteCmd) : '没收到');

    /* ---- 4. 剪贴板：被控端 -> 控制端 ---- */
    console.log('\n[4] 剪贴板：被控端 -> 控制端');
    await cdp.evalJs('document.getElementById("clipGet").click(); true');
    await sleep(800);

    const shown = await cdp.evalJs(
      'document.getElementById("clipResult").textContent');
    ok('控制端显示了取回的内容', shown && shown.indexOf('8899') >= 0, JSON.stringify(shown));
    ok('「复制」按钮出现了',
      await cdp.evalJs('document.getElementById("clipCopy").style.display !== "none"'));

    /* ---- 5. 文件传输 ---- */
    console.log('\n[5] 文件传输（控制端 -> 被控端）');
    const FILE_SIZE = 200 * 1024 + 37;      // 故意不是分片大小的整数倍
    got.fileBytes = Buffer.alloc(0);
    got.commands.length = 0;

    // 在页面里造一个确定内容的文件，塞进 file input，再点发送
    await cdp.evalJs(`(function(){
      var n = ${FILE_SIZE};
      var a = new Uint8Array(n);
      for (var i = 0; i < n; i++) a[i] = (i * 7 + 13) & 0xFF;
      var dt = new DataTransfer();
      dt.items.add(new File([a], '测试文件.bin', { type: 'application/octet-stream' }));
      var inp = document.getElementById('fileInput');
      inp.files = dt.files;
      document.getElementById('fileSend').click();
      return true;
    })()`);

    let done = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (got.commands.some((c) => c.t === 'fend')) { done = true; break; }
    }

    const fstart = got.commands.find((c) => c.t === 'fstart');
    ok('被控端收到 fstart', !!fstart);
    ok('文件名正确', fstart && fstart.name === '测试文件.bin',
      fstart ? fstart.name : '没有');
    ok('文件大小正确', fstart && fstart.size === FILE_SIZE,
      fstart ? String(fstart.size) : '没有');
    ok('收到 fend 收尾', done);

    ok('字节数完全一致', got.fileBytes.length === FILE_SIZE,
      '收到 ' + got.fileBytes.length + '，期望 ' + FILE_SIZE);

    let contentOK = got.fileBytes.length === FILE_SIZE;
    if (contentOK) {
      for (let i = 0; i < FILE_SIZE; i++) {
        if (got.fileBytes[i] !== ((i * 7 + 13) & 0xFF)) { contentOK = false; break; }
      }
    }
    ok('文件内容逐字节一致', contentOK,
      contentOK ? '' : '内容对不上（可能是分片错位或丢包）');

    const endCount = got.commands.filter((c) => c.t === 'fend').length;
    ok('只发了一次 fend', endCount === 1, '收到 ' + endCount + ' 次');

    /* ---- 6. 从手机取文件（被控端 -> 控制端） ---- */
    console.log('\n[6] 从手机取文件（被控端 -> 控制端）');

    // 拦截 URL.createObjectURL，把控制端组好的 Blob 截下来自己验
    await cdp.evalJs(`(function(){
      window.__pulled = null;
      if (!URL.__hooked) {
        var orig = URL.createObjectURL;
        URL.createObjectURL = function (b) { window.__pulled = b; return orig.call(URL, b); };
        URL.__hooked = true;
      }
      return true;
    })()`);

    await cdp.evalJs('document.getElementById("bPull").click(); true');
    await sleep(1000);
    ok('控制端列出了手机上的文件',
      (await cdp.evalJs('document.querySelectorAll("#pullList .app").length')) === PULL_ITEMS.length,
      '拿到 ' + (await cdp.evalJs('document.querySelectorAll("#pullList .app").length')) + ' 条');

    // 点第一条，触发拉取
    await cdp.evalJs('document.querySelector("#pullList .app").click(); true');

    let pulled = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      pulled = await cdp.evalJs(`(async function(){
        if (!window.__pulled) return null;
        var buf = await window.__pulled.arrayBuffer();
        var u8 = new Uint8Array(buf);
        var ok = true;
        for (var i = 0; i < u8.length; i++) {
          if (u8[i] !== ((i * 31 + 7) & 0xFF)) { ok = false; break; }
        }
        return JSON.stringify({ size: u8.length, ok: ok, type: window.__pulled.type });
      })()`);
      if (pulled) break;
    }

    const p = pulled ? JSON.parse(pulled) : null;
    ok('取回的文件大小正确', !!p && p.size === PULL_SIZE,
      p ? String(p.size) + '（期望 ' + PULL_SIZE + '）' : '没取到');
    ok('取回的文件内容逐字节一致', !!p && p.ok === true);
    ok('MIME 类型带过来了', !!p && p.type === 'image/jpeg', p ? p.type : '没有');
    ok('进度提示显示已取回',
      (await cdp.evalJs('document.getElementById("pullProg").textContent')).indexOf('已取回') >= 0,
      await cdp.evalJs('document.getElementById("pullProg").textContent'));

    // 再取第二个文件，验证接收状态被正确清掉了（不会卡在"上一个还在传"）
    await cdp.evalJs('window.__pulled = null; true');
    await cdp.evalJs('document.querySelectorAll("#pullList .app")[1].click(); true');

    let pulled2 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      pulled2 = await cdp.evalJs(`(async function(){
        if (!window.__pulled) return null;
        var buf = await window.__pulled.arrayBuffer();
        return JSON.stringify({ size: buf.byteLength });
      })()`);
      if (pulled2) break;
    }
    ok('连取第二个文件也正常（接收状态已重置）',
      !!pulled2 && JSON.parse(pulled2).size === 4096,
      pulled2 || '没取到');

    // 文件分片不应该把画面解码器搞挂
    ok('取文件过程中页面没报错',
      (await cdp.evalJs('document.getElementById("err").textContent')).length === 0,
      await cdp.evalJs('document.getElementById("err").textContent'));

    /* ---- 7. 触摸坐标 / 旋转 / 震动层 ---- */
    console.log('\n[7] 触摸坐标、旋转、震动层');
    // 抽屉是盖在画面上的（z-index 5），先关掉，不然触摸会打在抽屉上
    await cdp.evalJs('document.getElementById("pullClose").click(); true');
    await sleep(300);
    ok('抽屉已关闭，画面露出来了',
      await cdp.evalJs('document.getElementById("pullSheet").classList.contains("on")') === false);

    await cdp.cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await sleep(400);

    const r1 = await rectOf(cdp, 'surface');
    // setSize 会把被控端报的尺寸写到 canvas 的 width/height 上，
    // 用它判断 meta 到底有没有被处理（光看 rect 大小会被 canvas 默认的 300x150 骗过）
    const vw = await cdp.evalJs('document.getElementById("view").width');
    ok('被控端报的屏幕尺寸已生效', vw === 360, 'view.width=' + vw);
    ok('画布已按尺寸布局', r1.width > 20 && r1.height > 20,
      Math.round(r1.width) + 'x' + Math.round(r1.height));

    // 未旋转：在画布 (0.25, 0.75) 处点一下
    got.commands.length = 0;
    const tx = r1.left + r1.width * 0.25, ty = r1.top + r1.height * 0.75;
    await touchTap(cdp, tx, ty);
    await sleep(500);
    const tap1 = got.commands.filter((c) => c.t === 'tap').pop();
    ok('未旋转：轻点坐标正确',
      !!tap1 && Math.abs(tap1.x - 0.25) < 0.02 && Math.abs(tap1.y - 0.75) < 0.02,
      tap1 ? '(' + tap1.x.toFixed(3) + ', ' + tap1.y.toFixed(3) + ') 期望 (0.25, 0.75)' : '没收到 tap');

    // 打开震动反馈：会盖上一层透明 label，触摸必须照常工作
    await cdp.evalJs('document.getElementById("bHaptic").click(); true');
    await sleep(200);
    ok('震动层已显示',
      await cdp.evalJs('document.getElementById("hapticLayer").classList.contains("on")'));

    got.commands.length = 0;
    await touchTap(cdp, r1.left + r1.width * 0.25, r1.top + r1.height * 0.75);
    await sleep(500);
    const tap2 = got.commands.filter((c) => c.t === 'tap').pop();
    ok('开了震动层之后轻点依然有效',
      !!tap2 && Math.abs(tap2.x - 0.25) < 0.02 && Math.abs(tap2.y - 0.75) < 0.02,
      tap2 ? '(' + tap2.x.toFixed(3) + ', ' + tap2.y.toFixed(3) + ')' : '没收到 tap');

    // 这一条是 iOS 震动能生效的前提：点击必须真的落到隐藏的 switch 上。
    // 如果我们在 touchstart 里 preventDefault 把它吃掉了，这里就是 false。
    ok('点击转发到了隐藏开关（iOS 震动的前提）',
      await cdp.evalJs('document.getElementById("hapticSwitch").checked') === true,
      '开关没被切换，说明 preventDefault 把默认行为吃掉了');

    // 滑动依然要能识别（不能被震动层变成一串点击）
    got.commands.length = 0;
    await cdp.cmd('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: r1.left + r1.width * 0.2, y: r1.top + r1.height * 0.8 }],
    });
    await sleep(40);
    await cdp.cmd('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: r1.left + r1.width * 0.6, y: r1.top + r1.height * 0.3 }],
    });
    await sleep(40);
    await cdp.cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const sw = got.commands.filter((c) => c.t === 'swipe').pop();
    ok('开了震动层之后滑动依然识别为滑动', !!sw,
      '收到的指令：' + JSON.stringify(got.commands.map((c) => c.t)));

    // 旋转 90°：坐标要按逆变换算回去
    await cdp.evalJs('document.getElementById("bRotate").click(); true');
    await sleep(400);
    const r2 = await rectOf(cdp, 'surface');

    // 想要视觉上的画布 (0.25, 0.75)：按 rotate(90deg) 正变换算出该点客户区坐标
    const cx2 = r2.left + r2.width / 2, cy2 = r2.top + r2.height / 2;
    const px2 = cx2 - (0.75 - 0.5) * r2.width;
    const py2 = cy2 + (0.25 - 0.5) * r2.height;
    got.commands.length = 0;
    await touchTap(cdp, px2, py2);
    await sleep(500);
    const tap3 = got.commands.filter((c) => c.t === 'tap').pop();
    ok('旋转 90° 后轻点坐标依然正确',
      !!tap3 && Math.abs(tap3.x - 0.25) < 0.03 && Math.abs(tap3.y - 0.75) < 0.03,
      tap3 ? '(' + tap3.x.toFixed(3) + ', ' + tap3.y.toFixed(3) + ') 期望 (0.25, 0.75)' : '没收到 tap');

    // 转回去，别影响后面的用例
    await cdp.evalJs('document.getElementById("bRotate").click(); true');
    await sleep(200);

    /* ---- 8. 断线自动重连（真的把中继杀掉） ---- */
    console.log('\n[8] 断线自动重连');
    ok('断线前是已连接状态',
      (await cdp.evalJs('document.getElementById("status").textContent')).indexOf('已连接') >= 0);

    await killServer();
    await sleep(1400);   // 等第一次重连尝试失败、状态切成「重连中」

    const statusOffline = await cdp.evalJs('document.getElementById("status").textContent');
    ok('中继挂掉后控制端进入重连状态',
      statusOffline.indexOf('重连') >= 0, '当前: ' + statusOffline);

    const agentGone = await (async () => {
      try { await httpGetJson('/health'); return false; } catch (e) { return true; }
    })();
    ok('中继确实已经停了', agentGone);

    // 把中继拉起来，两端都应该自己连回来
    startServer();
    ok('中继重新启动', await waitHealth(15000));
    ok('两端都自动重连回房间', await waitBothOnline(20000));

    let statusBack = '';
    for (let i = 0; i < 30; i++) {
      statusBack = await cdp.evalJs('document.getElementById("status").textContent');
      if (statusBack.indexOf('已连接') >= 0) break;
      await sleep(400);
    }
    ok('控制端状态恢复为已连接', statusBack.indexOf('已连接') >= 0, '当前: ' + statusBack);

    // 重连后指令还能通
    got.commands.length = 0;
    await cdp.evalJs(`(function(){
      document.getElementById('clipText').value = '重连之后还能用';
      document.getElementById('clipSend').click();
      return true;
    })()`);
    await sleep(900);
    const afterReconnect = got.commands.filter((c) => c.t === 'clip').pop();
    ok('重连后指令依然通畅',
      afterReconnect && afterReconnect.v === '重连之后还能用',
      afterReconnect ? JSON.stringify(afterReconnect.v) : '没收到');

  } catch (e) {
    fail++;
    console.error('\n测试异常:', e.message);
  } finally {
    agentWanted = false;
    try { if (agentSock) agentSock.destroy(); } catch (e) {}
    try { if (cdp) cdp.close(); } catch (e) {}
    try { if (chrome) chrome.kill(); } catch (e) {}
    await killServer();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})();
