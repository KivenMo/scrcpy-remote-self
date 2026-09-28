'use strict';
/*
 * verify-real-device.js —— 拿真机跑一遍端到端。
 *
 * 和 test-*.js 的区别：那些用假被控端（demo-agent），这个连的是真插在电脑上的安卓手机。
 * 验证的是「浏览器控制端能不能真的把真机画面解出来并画到 canvas 上」——
 * 这是 Node 里测不出来的（Node 没有 WebCodecs / Canvas）。
 *
 * 用法：
 *   node server/verify-real-device.js JC484UQK
 *   node server/verify-real-device.js JC484UQK http://127.0.0.1:8080
 *
 * 前提：中继在跑，手机上的被控端已启动并连上（adb reverse 通了）。
 */

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOM = (process.argv[2] || '').toUpperCase().trim();
const BASE = (process.argv[3] || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PORT = 9227;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!ROOM) {
  console.error('用法: node server/verify-real-device.js <配对码> [http://中继地址]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '  -> ' + detail : '')); }
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

/* 极简 WebSocket 客户端，只用来发 CDP 命令 */
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
  const profile = path.join(os.tmpdir(), 'ra-real-' + Date.now());
  const url = BASE + '/?code=' + ROOM;
  console.log('打开控制端页面: ' + url);

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    url,
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 80 && !page; i++) {
      try {
        const list = await getJson('/json/list');
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (e) {}
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('等不到 Chrome 的 page 目标');

    ws = await wsConnect(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.on((msg) => {
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    function cmd(method, params) {
      return new Promise((resolve, reject) => {
        const myId = ++id;
        pending.set(myId, (m) => m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result));
        ws.send({ id: myId, method, params: params || {} });
        setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(method + ' 超时')); } }, 20000);
      });
    }
    async function evalJs(expr, awaitPromise) {
      const r = await cmd('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: !!awaitPromise,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
      return r.result.value;
    }

    await cmd('Runtime.enable');
    await sleep(1200);

    /* ---------- 1. 页面上真的能开 H.264 解码器吗 ---------- */
    console.log('\n[1] 这个 Chrome 支持 WebCodecs H.264 吗');
    const h264 = await evalJs(`(async function(){
      if (!('VideoDecoder' in window)) return 'no-videodecoder';
      try {
        var s = await VideoDecoder.isConfigSupported({ codec: 'avc1.42C020', codedWidth: 720, codedHeight: 1552 });
        return s.supported ? 'yes' : 'unsupported';
      } catch (e) { return 'error:' + e.message; }
    })()`, true);
    console.log('  H.264 解码支持: ' + h264);
    check('VideoDecoder 可用', h264 === 'yes', h264);

    /* ---------- 2. 连上真机 ---------- */
    console.log('\n[2] 连接真机 room=' + ROOM);
    // 注意：#connect 是「连接页」这个 section，#go 才是那个「连接」按钮。
    // #status 在会话页里，没连上时读它永远是「未连接」，所以要看 #session 有没有 on。
    await evalJs(`(function(){
      var c = document.getElementById('code'); if (c) c.value = ${JSON.stringify(ROOM)};
      var h = document.getElementById('host'); if (h) h.value = ${JSON.stringify(BASE.replace(/^https?:\/\//, ''))};
      var b = document.getElementById('go'); if (b) b.click();
      return true;
    })()`);

    // 等画面真的画出来
    let px = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      px = JSON.parse(await evalJs(`(function(){
        var c = document.getElementById('view');
        if (!c || !c.width || !c.height) return JSON.stringify({w:0,h:0,nonBlack:0,total:0});
        var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        var n = 0, t = 0;
        for (var i = 0; i < d.length; i += 4*211) { t++; if (d[i]>10||d[i+1]>10||d[i+2]>10) n++; }
        return JSON.stringify({w:c.width, h:c.height, nonBlack:n, total:t});
      })()`));
      if (px && px.nonBlack > 0) break;
    }

    const sessOn = await evalJs(`document.getElementById('session').classList.contains('on')`);
    const status = await evalJs(`(document.getElementById('status')||{}).textContent || ''`);
    const codecTag = await evalJs(`(document.getElementById('codecTag')||{}).textContent || ''`);
    const errText = await evalJs(`(document.getElementById('err')||{}).textContent || ''`);
    console.log('  会话页已打开: ' + sessOn);
    console.log('  状态栏: ' + JSON.stringify(status));
    console.log('  编码标签: ' + JSON.stringify(codecTag));
    if (errText) console.log('  错误提示: ' + JSON.stringify(errText));
    console.log('  canvas: ' + JSON.stringify(px));

    check('已进入会话页（说明 WebSocket 连上了）', sessOn === true, String(sessOn));
    check('canvas 有尺寸', px && px.w > 0 && px.h > 0, JSON.stringify(px));
    check('canvas 真的画上了画面（非黑像素 > 0）',
      px && px.nonBlack > 0, JSON.stringify(px));
    check('画面内容不是全黑（占比 > 5%）',
      px && px.total > 0 && (px.nonBlack / px.total) > 0.05,
      px ? (100 * px.nonBlack / px.total).toFixed(1) + '%' : 'n/a');

    /* ---------- 3. 触摸坐标映射（真机是 1080x2340，采集 720x1552） ---------- */
    console.log('\n[3] 触摸坐标映射');
    await evalJs(`(function(){
      window.__sent = [];
      var orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function(d){
        try { if (typeof d === 'string') window.__sent.push(JSON.parse(d)); } catch(e){}
        return orig.apply(this, arguments);
      };
      // 顺便数一下事件到底有没有落到 #surface 上 ——
      // 没有这两个计数就说明触摸压根没进 surface，别去查坐标换算。
      window.__ev = {start:0, end:0, changedTouchesOnEnd:-1, dur:null, dist:null, moved:null};
      var s = document.getElementById('surface');
      var st = null;
      s.addEventListener('touchstart', function(e){
        window.__ev.start++;
        var t = (e.touches && e.touches[0]) || e;
        st = { x: t.clientX, y: t.clientY, ts: e.timeStamp };
      }, true);
      s.addEventListener('touchend', function(e){
        window.__ev.end++;
        var ct = e.changedTouches || [];
        window.__ev.changedTouchesOnEnd = ct.length;
        var t = ct[0] || e;
        if (st) {
          window.__ev.dur = Math.round(e.timeStamp - st.ts);
          window.__ev.dist = Math.round(Math.hypot(t.clientX - st.x, t.clientY - st.y));
        }
      }, true);
      return true;
    })()`);

    await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const box = JSON.parse(await evalJs(`(function(){
      var s = document.getElementById('surface');
      var r = s.getBoundingClientRect();
      return JSON.stringify({x:r.left, y:r.top, w:r.width, h:r.height});
    })()`));
    // 点表面 50% / 50% 处。
    // 刻意避开下半屏：被控端 App 自己的「停止」按钮就落在 y≈0.75 那一带，
    // 早期版本在这里点了一下，直接把会话停了，看起来像 touch 有 bug，其实是点中了停止。
    const tx = box.x + box.w * 0.50, ty = box.y + box.h * 0.50;
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
    await sleep(70);
    await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);

    // 轻点和长按都带 x/y，都能验坐标。只认 tap 的话，机器一忙（CDP 往返变慢、
    // 按住超过阈值）就会偶发失败 —— 那是测试脆，不是产品坏。
    const taps = JSON.parse(await evalJs(
      `JSON.stringify((window.__sent||[]).filter(function(m){return m.t==='tap'||m.t==='long';}))`));
    const ev = JSON.parse(await evalJs(`JSON.stringify(window.__ev || {})`));
    const at = await evalJs(`(function(){
      var el = document.elementFromPoint(${tx}, ${ty});
      return el ? (el.id || el.tagName) : 'null';
    })()`);
    const allSent = JSON.parse(await evalJs(`JSON.stringify(window.__sent || [])`));
    console.log('  发出去的 tap: ' + JSON.stringify(taps));
    // 全量打出来：如果发的是 swipe 而不是 tap，说明 dur/dist 越界了（两个分支都没进就什么都不发）
    console.log('  这段时间页面发出的全部消息: ' +
      JSON.stringify(allSent.filter(function (m) { return m.t !== 'apps'; })));
    console.log('  surface 事件计数: ' + JSON.stringify(ev));
    console.log('  触摸点落在: ' + at + '   (坐标 ' + Math.round(tx) + ',' + Math.round(ty) + ')');
    check('touchstart 落到了 #surface 上', ev.start >= 1, JSON.stringify(ev));
    check('touchend 落到了 #surface 上', ev.end >= 1, JSON.stringify(ev));
    check('touchend 带着 changedTouches（否则 dist 会算成 NaN）',
      ev.changedTouchesOnEnd >= 1, JSON.stringify(ev));
    check('真的发了轻点/长按指令（不是什么都不发）', taps.length >= 1,
      '收到 ' + taps.length + ' 条，全部消息=' + JSON.stringify(allSent.map(function (m) { return m.t; })));
    if (taps.length) {
      const t = taps[taps.length - 1];
      check('x 在 0..1 之间', t.x >= 0 && t.x <= 1, String(t.x));
      check('y 在 0..1 之间', t.y >= 0 && t.y <= 1, String(t.y));
      // 点的是正中心，允许一两个像素的取整误差
      check('x 接近 0.50（坐标映射准）', Math.abs(t.x - 0.5) < 0.02, String(t.x));
      check('y 接近 0.50（坐标映射准）', Math.abs(t.y - 0.5) < 0.02, String(t.y));
    }

    /* ---------- 3.5 切换编码：H.264 -> JPEG -> H.264 ---------- */
    // 这段专门盯 releasePipeline()：里面会清掉 avcC / codecString / 缓存的关键帧。
    // 换编码、改画质、旋转屏幕都会走重建，清得对不对、重建后能不能恢复，
    // 只有真机能验 —— 假被控端（demo-agent）根本不会重建管线。
    console.log('\n[3.5] 切换编码方式');
    async function switchCodec(v) {
      await evalJs(`(function(){
        var b = document.querySelector('#qSheet [data-codec=${JSON.stringify(v)}]');
        if (b) b.click();
        return true;
      })()`);
      // 等新管线起来 + 第一帧到达
      let out = null;
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        out = JSON.parse(await evalJs(`(function(){
          var c = document.getElementById('view');
          if (!c || !c.width || !c.height) return JSON.stringify({w:0,h:0,nonBlack:0,total:0});
          var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          var n = 0, t = 0;
          for (var i = 0; i < d.length; i += 4*211) { t++; if (d[i]>10||d[i+1]>10||d[i+2]>10) n++; }
          return JSON.stringify({w:c.width, h:c.height, nonBlack:n, total:t,
            tag:(document.getElementById('codecTag')||{}).textContent||''});
        })()`));
        if (out && out.nonBlack > 0 && /JPEG/i.test(out.tag || '')) break;
      }
      return out;
    }

    const jpegState = await switchCodec('jpeg');
    console.log('  切到 JPEG: ' + JSON.stringify(jpegState));
    check('切到 JPEG 后画面还在（没黑屏）', jpegState && jpegState.nonBlack > 0, JSON.stringify(jpegState));
    check('编码标签变成 JPEG', jpegState && /JPEG/i.test(jpegState.tag || ''), jpegState && jpegState.tag);

    async function switchBackH264() {
      await evalJs(`(function(){
        var b = document.querySelector('#qSheet [data-codec="auto"]');
        if (b) b.click();
        return true;
      })()`);
      let out = null;
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        out = JSON.parse(await evalJs(`(function(){
          var c = document.getElementById('view');
          if (!c || !c.width || !c.height) return JSON.stringify({w:0,h:0,nonBlack:0,total:0});
          var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          var n = 0, t = 0;
          for (var i = 0; i < d.length; i += 4*211) { t++; if (d[i]>10||d[i+1]>10||d[i+2]>10) n++; }
          return JSON.stringify({w:c.width, h:c.height, nonBlack:n, total:t,
            tag:(document.getElementById('codecTag')||{}).textContent||''});
        })()`));
        if (out && out.nonBlack > 0 && /H\.264/i.test(out.tag || '')) break;
      }
      return out;
    }

    const h264State = await switchBackH264();
    console.log('  切回 H.264: ' + JSON.stringify(h264State));
    check('切回 H.264 后画面恢复', h264State && h264State.nonBlack > 0, JSON.stringify(h264State));
    check('编码标签变回 H.264', h264State && /H\.264/i.test(h264State.tag || ''), h264State && h264State.tag);
    check('切回后 canvas 尺寸仍是 720x1552（重建没把尺寸弄丢）',
      h264State && h264State.w === 720 && h264State.h === 1552, JSON.stringify(h264State));

    /* ---------- 4. 点完之后会话还活着吗 ---------- */
    // 这条是回归防线：曾经在 y=0.75 处点了一下，正好命中被控端 App 的「停止」按钮，
    // 会话被自己停掉。坐标映射没问题，是测试选点不谨慎 —— 但值得用断言钉住。
    console.log('\n[4] 点完之后被控端还在线吗');
    await sleep(1500);
    const stillOn = await evalJs(`document.getElementById('session').classList.contains('on')`);
    const after = await evalJs(`(document.getElementById('status')||{}).textContent || ''`);
    console.log('  状态栏: ' + JSON.stringify(after));
    check('触摸没有把会话搞掉', stillOn === true, String(stillOn));
    check('状态栏仍显示已连接', /已连接/.test(after), JSON.stringify(after));

  } catch (e) {
    console.error('\n运行出错: ' + (e && e.message));
    fail++;
  } finally {
    try { if (ws) ws.socket.destroy(); } catch (_) {}
    try { chrome.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail > 0 ? 1 : 0);
})();
