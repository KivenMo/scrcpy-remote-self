'use strict';
/*
 * TLS / WSS 端到端自测
 *
 *   node test-tls.js
 *
 * 脚本自己拉起一个开了 TLS 的 server.js 实例（端口 18443/18444），然后验证：
 *   · https + wss 能正常用
 *   · 证书校验是真的在生效 —— 换一张 CA 就必须连不上
 *   · 被控端 TLS 能连，明文连同一个端口必须连不上
 *   · 加密之后指令、JSON、二进制画面照样能过
 *
 * 为什么要专门测「连不上」：加密功能最容易出的一种假成功，是服务器
 * 配了证书但客户端把校验关掉了。那种情况下所有正常路径的用例都会绿，
 * 但中间人照样能解密。所以这里必须有反向断言。
 *
 * 用自签证书跑，证书在 server/certs/ 下；没有就现场生成一张。
 */

const { spawn, execFileSync } = require('child_process');
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HTTP_PORT = 18443;
const TCP_PORT = 18444;
const ROOM = 'TLSROOM1';

const CERT_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 帧 ---------- */
function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}
const jsonFrame = (o) => frame(0x01, Buffer.from(JSON.stringify(o), 'utf8'));

/** 和 App 端、tools/make-cert.sh 用同一种算法：对证书 DER 做 SHA-256 */
function fingerprintOf(rawDer) {
  return crypto.createHash('sha256').update(rawDer).digest('hex').toUpperCase();
}

/**
 * SNI 不能填 IP（RFC 6066 不允许，Node 会报 DEP0123）。
 * 但主机名校验还是要做的：不传 servername 时 Node 会用 host 去比对 SAN，
 * 所以传 IP 时省掉 servername 反而校验得更严。
 */
function tlsOptions({ port, ca, host }) {
  const h = host || '127.0.0.1';
  const o = { port, host: h, ca, rejectUnauthorized: true };
  if (!/^[0-9.]+$/.test(h)) o.servername = h;
  return o;
}

/* ---------- 极简 WebSocket 客户端（走 https） ---------- */
function wssConnect({ port, ca, host, onMessage }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request(Object.assign(tlsOptions({ port, ca, host }), {
      path: '/ws',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    }), (res) => {
      // 走到这里说明没升级成功，多半是握手被拒
      reject(new Error('未升级为 WebSocket，状态码 ' + res.statusCode));
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
      resolve({
        socket,
        sendText(s) { socket.write(wsFrame(0x01, Buffer.from(s, 'utf8'))); },
        sendBinary(b) { socket.write(wsFrame(0x02, b)); },
        peerFingerprint() {
          const c = socket.getPeerCertificate();
          return c && c.raw ? fingerprintOf(c.raw) : null;
        },
        close() { socket.end(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 连接失败也要能拿到错误，所以把 reject 转成 resolve(null, err) */
function wssConnectExpectFailure(opts) {
  return new Promise((resolve) => {
    wssConnect(opts).then(
      (api) => { try { api.close(); } catch (_) {} resolve({ ok: true, err: null }); },
      (err) => resolve({ ok: false, err })
    );
  });
}

/** 被控端：TLS over TCP */
function agentTlsConnect({ port, ca, host }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(Object.assign(tlsOptions({ port, ca, host }), {}), () => {
      const c = sock.getPeerCertificate();
      sock.setNoDelay(true);
      let buf = Buffer.alloc(0);
      const inbox = [];
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 5 + len) break;
          const type = buf.readUInt8(4);
          const payload = Buffer.from(buf.subarray(5, 5 + len));
          buf = buf.subarray(5 + len);
          inbox.push({ type, payload });
        }
      });
      resolve({
        sock, inbox,
        fingerprint: c && c.raw ? fingerprintOf(c.raw) : null,
        authorized: sock.authorized,
        authorizationError: sock.authorizationError,
        sendJson(o) { sock.write(jsonFrame(o)); },
        sendBinary(b) { sock.write(frame(0x02, b)); },
        close() { sock.end(); },
      });
    });
    sock.on('error', reject);
  });
}

(async function main() {
  /* ---- 0. 准备证书 ---- */
  console.log('[0] 准备证书');
  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    console.log('  没有现成证书，现场生成…');
    try {
      execFileSync('bash', [path.join(__dirname, '..', 'tools', 'make-cert.sh')], { stdio: 'ignore' });
    } catch (e) {
      console.log('  生成失败：' + e.message);
    }
  }
  ok('证书文件存在', fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE));
  if (!fs.existsSync(CERT_FILE)) { console.log('\n没有证书，无法继续。'); process.exit(1); }

  const certPem = fs.readFileSync(CERT_FILE);
  const expectedFpr = fingerprintOf(
    Buffer.from(
      certPem.toString('utf8')
        .replace(/-----BEGIN CERTIFICATE-----/, '')
        .replace(/-----END CERTIFICATE-----/, '')
        .replace(/\s+/g, ''),
      'base64'
    )
  );
  ok('能算出证书指纹', /^[0-9A-F]{64}$/.test(expectedFpr), expectedFpr);

  /* 再造一张无关的证书，用来验证「换 CA 就连不上」 */
  let otherCertPem = null;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-tls-'));
    const oKey = path.join(tmp, 'k.pem'), oCert = path.join(tmp, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', oKey, '-out', oCert, '-days', '1',
      '-subj', '/CN=definitely-not-our-relay',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    otherCertPem = fs.readFileSync(oCert);
    ok('已生成一张无关证书用于反向测试', true);
  } catch (e) {
    ok('已生成一张无关证书用于反向测试', false, e.message);
  }

  /* ---- 启动 TLS 服务器 ---- */
  console.log('\n启动临时 TLS 服务器…');
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      HTTP_PORT: String(HTTP_PORT),
      TCP_PORT: String(TCP_PORT),
      TLS_CERT: CERT_FILE,
      TLS_KEY: KEY_FILE,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d.toString(); });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await sleep(1200);

  try {
    /* ---- 1. 服务器自己报的加密状态 ---- */
    console.log('\n[1] /health 反映加密状态');
    const health = await new Promise((resolve, reject) => {
      https.get({ port: HTTP_PORT, host: '127.0.0.1', path: '/health', ca: certPem, rejectUnauthorized: true },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => resolve(JSON.parse(s))); }
      ).on('error', reject);
    });
    ok('https 能取到 /health', health.ok === true);
    ok('health.tls.web = true', health.tls && health.tls.web === true, JSON.stringify(health.tls));
    ok('health.tls.agent = true', health.tls && health.tls.agent === true, JSON.stringify(health.tls));
    ok('启动日志说明被控端走 TLS', /被控端接入端口\s+TLS/.test(srvOut), srvOut.split('\n')[0]);
    ok('启动日志没有出现明文警告', !/没有加密/.test(srvOut));

    /* ---- 2. 明文访问 https 端口必须失败 ---- */
    console.log('\n[2] 明文请求 https 端口应失败');
    const plainHttp = await new Promise((resolve) => {
      const req = require('http').get({ port: HTTP_PORT, host: '127.0.0.1', path: '/health' }, (res) => {
        resolve({ ok: true, status: res.statusCode });
      });
      req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
      req.setTimeout(2500, () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    });
    ok('明文 HTTP 拿不到正常响应', plainHttp.ok === false, JSON.stringify(plainHttp));

    /* ---- 3. 证书校验确实在生效 ---- */
    console.log('\n[3] 证书校验生效性（反向断言）');
    if (otherCertPem) {
      const wrongCa = await wssConnectExpectFailure({
        port: HTTP_PORT, ca: otherCertPem, host: '127.0.0.1', onMessage: () => {},
      });
      ok('用无关 CA 连 wss 必须失败', wrongCa.ok === false,
        wrongCa.ok ? '居然连上了 —— 说明证书校验被绕过了' : (wrongCa.err && wrongCa.err.code));

      const wrongCaAgent = await new Promise((resolve) => {
        agentTlsConnect({ port: TCP_PORT, ca: otherCertPem, host: '127.0.0.1' })
          .then((a) => { try { a.close(); } catch (_) {} resolve({ ok: true }); },
                (e) => resolve({ ok: false, err: e.code || e.message }));
      });
      ok('用无关 CA 连被控端 TLS 端口必须失败', wrongCaAgent.ok === false,
        wrongCaAgent.ok ? '居然连上了' : wrongCaAgent.err);
    }

    const selfSignedUntrusted = await wssConnectExpectFailure({
      port: HTTP_PORT, ca: undefined, host: '127.0.0.1', onMessage: () => {},
    });
    ok('不提供 CA（自签证书）时系统信任库应拒绝', selfSignedUntrusted.ok === false,
      selfSignedUntrusted.ok ? '居然被系统信任了' : (selfSignedUntrusted.err && selfSignedUntrusted.err.code));

    /* ---- 4. 控制端 wss 正常路径 ---- */
    console.log('\n[4] 控制端 wss 正常路径');
    const ctrlInbox = [];
    const ctrl = await wssConnect({
      port: HTTP_PORT, ca: certPem, host: '127.0.0.1',
      onMessage: (op, payload) => ctrlInbox.push({ op, payload }),
    });
    ok('wss 升级成功', !!ctrl.socket);
    ok('拿到对端证书指纹', !!ctrl.peerFingerprint());
    ok('指纹与证书文件一致', ctrl.peerFingerprint() === expectedFpr,
      ctrl.peerFingerprint() + ' vs ' + expectedFpr);
    ok('TLS 已授权（authorized）', ctrl.socket.authorized === true,
      String(ctrl.socket.authorizationError));

    /* ---- 5. 被控端 TLS 正常路径 ---- */
    console.log('\n[5] 被控端 TLS 正常路径');
    const agent = await agentTlsConnect({ port: TCP_PORT, ca: certPem, host: '127.0.0.1' });
    ok('被控端 TLS 握手成功', agent.authorized === true, String(agent.authorizationError));
    ok('被控端看到的指纹一致', agent.fingerprint === expectedFpr, String(agent.fingerprint));
    agent.sendJson({ t: 'hello', room: ROOM, name: 'TLS-Test-Phone', mode: 'unattended' });
    await sleep(400);
    const paired = agent.inbox.find((m) => m.type === 0x01 && JSON.parse(m.payload.toString()).t === 'paired');
    ok('收到 paired', !!paired);

    /* 控制端此时才加入，才收得到 agent-online（和 test-relay 同一套语义） */
    ctrl.sendText(JSON.stringify({ t: 'hello', room: ROOM }));
    await sleep(400);
    const welcome = ctrlInbox.map((m) => JSON.parse(m.payload.toString())).find((m) => m.t === 'welcome');
    ok('控制端收到 welcome', !!welcome);
    ok('welcome.mode 透传为 unattended', welcome && welcome.mode === 'unattended',
      welcome && String(welcome.mode));

    /* ---- 6. 加密链路下的双向数据 ---- */
    console.log('\n[6] 加密链路上的数据往返');
    ctrlInbox.length = 0;
    ctrl.sendText(JSON.stringify({ t: 'tap', x: 111, y: 222 }));
    await sleep(400);
    const tap = agent.inbox.find((m) => m.type === 0x01 && JSON.parse(m.payload.toString()).t === 'tap');
    ok('控制端指令到达被控端', !!tap);
    ok('指令内容完整', tap && JSON.parse(tap.payload.toString()).x === 111);

    agent.sendJson({ t: 'ack', op: 'tap', ok: true });
    await sleep(400);
    const ack = ctrlInbox.map((m) => JSON.parse(m.payload.toString())).find((m) => m.t === 'ack');
    ok('被控端 JSON 回到控制端', !!ack && ack.ok === true);

    // 二进制画面：TLS 下必须原样透传，一个字节都不能变
    const blob = crypto.randomBytes(4096);
    blob[0] = 0xFF; blob[1] = 0xD8;               // 伪装成 JPEG 头
    agent.sendBinary(blob);
    await sleep(500);
    const gotBin = ctrlInbox.find((m) => m.op === 0x02);
    ok('二进制画面到达控制端', !!gotBin);
    ok('二进制长度一致（4096）', gotBin && gotBin.payload.length === 4096,
      gotBin && String(gotBin.payload.length));
    ok('二进制内容逐字节一致', gotBin && Buffer.compare(gotBin.payload, blob) === 0);

    /* ---- 7. 明文连被控端 TLS 端口必须失败 ---- */
    console.log('\n[7] 明文连 TLS 被控端端口应失败');
    const plainAgent = await new Promise((resolve) => {
      const s = net.connect(TCP_PORT, '127.0.0.1');
      let got = Buffer.alloc(0);
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; try { s.destroy(); } catch (_) {} resolve(r); } };
      s.on('connect', () => { s.write(jsonFrame({ t: 'hello', room: ROOM, name: 'plaintext-attacker' })); });
      s.on('data', (c) => { got = Buffer.concat([got, c]); done({ ok: true, got: got.length }); });
      s.on('error', (e) => done({ ok: false, err: e.code || e.message }));
      s.on('close', () => done({ ok: false, err: 'closed' }));
      setTimeout(() => done({ ok: false, err: 'timeout' }), 2500);
    });
    ok('明文连接拿不到任何数据', plainAgent.ok === false,
      plainAgent.ok ? ('收到了 ' + plainAgent.got + ' 字节') : plainAgent.err);
    await sleep(200);
    ok('服务器记录了 TLS 握手失败', /TLS 握手失败/.test(srvOut));

    ctrl.close();
    agent.close();
  } catch (e) {
    fail++;
    console.log('\n  测试过程抛异常：' + (e && e.stack || e));
  } finally {
    try { srv.kill(); } catch (_) {}
  }

  console.log('\n' + (fail === 0 ? '通过 ' : '失败 ') + pass + '/' + (pass + fail)
    + (fail ? '  ✗ ' + fail + ' 个断言没过' : '  ✓ 全绿'));
  process.exit(fail === 0 ? 0 : 1);
})();
