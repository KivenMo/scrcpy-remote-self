'use strict';
/*
 * 端到端自测：模拟一个被控端（TCP）+ 一个控制端（WebSocket），
 * 验证配对、画面下行、指令上行是否都能通。
 *
 *   node test-relay.js
 *
 * 需要先启动 server.js（脚本会自己拉起一个临时实例，端口用 18080/18081）。
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const HTTP_PORT = 18080;
const TCP_PORT = 18081;
const ROOM = 'TEST2345';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}
const jsonFrame = (o) => frame(0x01, Buffer.from(JSON.stringify(o), 'utf8'));

/* ---------- 极简 WebSocket 客户端 ---------- */
function wsConnect(port, onOpen, onMessage) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      port, host: '127.0.0.1', path: '/ws',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b0 = buf[0], b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const op = b0 & 0x0f;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);
          if (op === 0x09) { socket.write(wsFrame(0x0A, payload)); continue; }
          if (op === 0x01 || op === 0x02) onMessage(op, payload);
          if (!fin) continue;
        }
      });
      function wsFrame(opcode, payload) {
        const len = payload.length;
        let head;
        if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
        else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
        else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
        head[0] = 0x80 | opcode;
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        return Buffer.concat([head, mask, masked]);
      }
      const api = {
        socket,
        sendText(s) { socket.write(wsFrame(0x01, Buffer.from(s, 'utf8'))); },
        sendBinary(b) { socket.write(wsFrame(0x02, b)); },
        close() { socket.end(); },
      };
      onOpen(api);
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  console.log('启动临时服务器…');
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      HTTP_PORT: String(HTTP_PORT), TCP_PORT: String(TCP_PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await sleep(900);

  try {
    /* ---- 1. 被控端连接 ---- */
    console.log('\n[1] 被控端 TCP 接入');
    const agent = net.connect(TCP_PORT, '127.0.0.1');
    await new Promise((res, rej) => { agent.on('connect', res); agent.on('error', rej); });
    agent.setNoDelay(true);
    ok('TCP 已连接', true);

    let agentInbox = [];
    let agentBuf = Buffer.alloc(0);
    agent.on('data', (c) => {
      agentBuf = Buffer.concat([agentBuf, c]);
      while (agentBuf.length >= 5) {
        const len = agentBuf.readUInt32BE(0);
        if (agentBuf.length < 5 + len) break;
        const type = agentBuf.readUInt8(4);
        const payload = agentBuf.subarray(5, 5 + len);
        agentBuf = agentBuf.subarray(5 + len);
        agentInbox.push({ type, payload: Buffer.from(payload) });
      }
    });

    agent.write(jsonFrame({ t: 'hello', room: ROOM, name: '测试机 Pixel' }));
    await sleep(250);
    ok('被控端收到 paired 回执',
      agentInbox.some((m) => m.type === 1 && JSON.parse(m.payload.toString()).t === 'paired'));

    /* ---- 2. 控制端连接 ---- */
    console.log('\n[2] 控制端 WebSocket 接入');
    const ctlInbox = [];
    const ctl = await wsConnect(HTTP_PORT,
      () => {},
      (op, payload) => ctlInbox.push({ op, payload }));
    ok('WebSocket 握手成功', !!ctl.socket);

    ctl.sendText(JSON.stringify({ t: 'hello', room: ROOM }));
    await sleep(250);

    const welcome = ctlInbox.find((m) => m.op === 1 && JSON.parse(m.payload.toString()).t === 'welcome');
    ok('控制端收到 welcome', !!welcome);
    if (welcome) {
      const w = JSON.parse(welcome.payload.toString());
      ok('welcome 里报告被控端在线', w.agent === true);
      ok('welcome 带回设备名', w.device === '测试机 Pixel', w.device);
    }
    ok('被控端收到 controller-joined',
      agentInbox.some((m) => m.type === 1 && JSON.parse(m.payload.toString()).t === 'controller-joined'));

    /* ---- 3. 画面下行 ---- */
    console.log('\n[3] 画面（被控端 -> 控制端）');
    agentInbox = [];
    const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 0xFF, 0xD9]);
    agent.write(frame(0x02, fakeJpeg));
    await sleep(250);
    const gotBin = ctlInbox.find((m) => m.op === 2);
    ok('控制端收到二进制帧', !!gotBin);
    ok('画面字节完全一致', gotBin && gotBin.payload.equals(fakeJpeg));

    /* ---- 4. 指令上行 ---- */
    console.log('\n[4] 指令（控制端 -> 被控端）');
    agentInbox = [];
    ctl.sendText(JSON.stringify({ t: 'tap', x: 0.25, y: 0.75 }));
    await sleep(250);
    const tap = agentInbox.find((m) => {
      if (m.type !== 1) return false;
      try { return JSON.parse(m.payload.toString()).t === 'tap'; } catch (e) { return false; }
    });
    ok('被控端收到 tap 指令', !!tap);
    if (tap) {
      const o = JSON.parse(tap.payload.toString());
      ok('坐标没被改动', o.x === 0.25 && o.y === 0.75, JSON.stringify(o));
    }

    /* ---- 5. 多控制端广播 ---- */
    console.log('\n[5] 第二个控制端');
    const ctl2Inbox = [];
    const ctl2 = await wsConnect(HTTP_PORT, () => {},
      (op, payload) => ctl2Inbox.push({ op, payload }));
    ctl2.sendText(JSON.stringify({ t: 'hello', room: ROOM }));
    await sleep(250);
    ctlInbox.length = 0; ctl2Inbox.length = 0;
    agent.write(frame(0x02, fakeJpeg));
    await sleep(250);
    ok('两个控制端都收到画面',
      ctlInbox.some((m) => m.op === 2) && ctl2Inbox.some((m) => m.op === 2));

    /* ---- 6. 配对码错误 ---- */
    console.log('\n[6] 错误配对码');
    const badInbox = [];
    const bad = await wsConnect(HTTP_PORT, () => {}, (op, p) => badInbox.push({ op, payload: p }));
    bad.sendText(JSON.stringify({ t: 'hello', room: '!!!' }));
    await sleep(250);
    ok('非法配对码被拒绝',
      badInbox.some((m) => m.op === 1 && JSON.parse(m.payload.toString()).t === 'error'));
    bad.close();

    /* ---- 7. 掉线通知 ---- */
    console.log('\n[7] 被控端掉线');
    ctlInbox.length = 0;
    agent.destroy();
    await sleep(350);
    ok('控制端收到 agent-offline',
      ctlInbox.some((m) => m.op === 1 && JSON.parse(m.payload.toString()).t === 'agent-offline'));

    /* ---- 8. 健康检查 ---- */
    console.log('\n[8] /health 接口');
    const body = await new Promise((res) => {
      http.get({ port: HTTP_PORT, path: '/health' }, (r) => {
        let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d));
      });
    });
    const h = JSON.parse(body);
    ok('/health 可用', h.ok === true);

    /* ---- 9. 文字模式（无人值守）的 mode 透传 ---- */
    console.log('\n[9] mode 透传（文字模式 / 兼容老客户端）');
    ok('老客户端没声明 mode 时按 video 处理',
      JSON.parse(welcome.payload.toString()).mode === 'video',
      JSON.parse(welcome.payload.toString()).mode);

    const UA_ROOM = 'TEXT2345';

    // agent-online 只发给「已经在这个房间里等着」的控制端，
    // 所以要先让控制端进去、再让被控端上线，才能验到这条消息。
    const uaInbox = [];
    const uaCtl = await wsConnect(HTTP_PORT, () => {}, (op, payload) => uaInbox.push({ op, payload }));
    uaCtl.sendText(JSON.stringify({ t: 'hello', room: UA_ROOM }));
    await sleep(250);

    const ua = net.connect(TCP_PORT, '127.0.0.1');
    await new Promise((res, rej) => { ua.on('connect', res); ua.on('error', rej); });
    ua.write(jsonFrame({ t: 'hello', room: UA_ROOM, name: '办公室那台', mode: 'unattended' }));
    await sleep(300);

    const ao = uaInbox.find((m) => m.op === 1 && JSON.parse(m.payload.toString()).t === 'agent-online');
    ok('文字模式被控端上线后通知控制端', !!ao);
    if (ao) {
      const a = JSON.parse(ao.payload.toString());
      ok('agent-online 带 mode=unattended', a.mode === 'unattended', a.mode);
      ok('agent-online 仍带回设备名', a.device === '办公室那台', a.device);
    }

    // 后加入的控制端靠 welcome 拿到 mode
    const uaInbox2 = [];
    const uaCtl2 = await wsConnect(HTTP_PORT, () => {}, (op, payload) => uaInbox2.push({ op, payload }));
    uaCtl2.sendText(JSON.stringify({ t: 'hello', room: UA_ROOM }));
    await sleep(250);
    const uw2 = uaInbox2.find((m) => m.op === 1 && JSON.parse(m.payload.toString()).t === 'welcome');
    ok('后加入的控制端从 welcome 拿到 mode',
      !!uw2 && JSON.parse(uw2.payload.toString()).mode === 'unattended',
      uw2 ? JSON.parse(uw2.payload.toString()).mode : 'no welcome');

    const body2 = await new Promise((res) => {
      http.get({ port: HTTP_PORT, path: '/health' }, (r) => {
        let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d));
      });
    });
    const h2 = JSON.parse(body2);
    const uaRoom = h2.rooms.find((r) => r.code === UA_ROOM);
    ok('/health 里能看到文字模式的房间', !!uaRoom && uaRoom.mode === 'unattended',
      uaRoom ? uaRoom.mode : 'room not found');
    ok('/health 里视频房间仍是 video',
      h2.rooms.filter((r) => r.code === ROOM).every((r) => r.mode === 'video'));

    ua.destroy(); uaCtl.close(); uaCtl2.close();

    /* ---- 10. 控制端页面 ---- */
    const page = await new Promise((res) => {
      http.get({ port: HTTP_PORT, path: '/' }, (r) => {
        let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, d }));
      });
    });
    ok('控制端页面能返回', page.code === 200 && page.d.indexOf('远程协助') >= 0);

    ctl.close(); ctl2.close();
  } catch (e) {
    fail++;
    console.error('\n测试异常：', e);
  } finally {
    srv.kill();
  }

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})();
