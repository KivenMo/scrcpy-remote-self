'use strict';
/*
 * 猜配对码限流 + /health 令牌 自测
 *
 *   node test-ratelimit.js
 *
 * 脚本自己拉起 5 个 server.js 实例（不同端口 / 不同环境变量），分别验证：
 *
 *   A  限流基本行为：几个不同的错码会被封；封禁期间连对的码也进不去；解封后恢复
 *   B  关键的用户体验保证：拿**同一个**码反复重试永远不该被封
 *   C  HEALTH_TOKEN：不带令牌拿不到 rooms，带对了才给
 *   D  TRUST_PROXY=1 时按真实客户端 IP 分开计数（XFF 生效）
 *   E  被控端那条链路：顶掉在线被控端算一次失败，攒够也封
 *
 * 为什么 B 是重点：限流最容易写成「按次数封」。那种写法会把正常用户一起封掉
 * —— 用户最常见的动作恰恰是「用同一个码连不上、再连、再连」。正常用户和攻击者
 * 的区别不在次数，在**试了多少个不同的码**。所以闸门必须卡「不同码个数」。
 *
 * 为什么还要专门测「伪造 XFF 不能绕过」：如果默认就信 X-Forwarded-For，
 * 攻击者每猜一个码换一个假 IP，限流等于没做。这个反向断言和 TLS 那套里
 * 「换 CA 必须连不上」是同一个道理 —— 正向用例全绿不代表防护真的在生效。
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

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

/* ---------- 极简 WebSocket 客户端（明文） ---------- */
function wsConnect({ port, headers, onMessage }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const h = Object.assign({
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
    }, headers || {});
    const req = http.request({ port, host: '127.0.0.1', path: '/ws', headers: h }, (res) => {
      reject(new Error('未升级为 WebSocket，状态码 ' + res.statusCode));
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      let buf = Buffer.alloc(0);
      let closed = false;
      const inbox = [];
      socket.on('close', () => { closed = true; });
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b0 = buf[0], b1 = buf[1];
          const op = b0 & 0x0f;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);
          if (op === 0x09) { socket.write(wsFrame(0x0A, payload)); continue; }
          if (op === 0x01) { try { inbox.push(JSON.parse(payload.toString('utf8'))); } catch (_) {} }
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
        inbox,
        isClosed: () => closed,
        sendText(s) { socket.write(wsFrame(0x01, Buffer.from(s, 'utf8'))); },
        close() { try { socket.end(); } catch (_) {} },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 连上去、发 hello、等一会儿、把收到的东西还回来 */
async function join({ port, room, headers, waitMs = 400 }) {
  const c = await wsConnect({ port, headers });
  c.sendText(JSON.stringify({ t: 'hello', room }));
  await sleep(waitMs);
  return c;
}

/**
 * 依次用这些码去连，返回第一次被拒的下标（-1 表示全程放行）。
 *
 * 注意语义：记账发生在 join **成功之后**，所以「试到第 N 个不同的错码」那一次
 * 本身是被放进来的，从第 N+1 次请求开始才拒。也就是说 DISTINCT=N 的效果是
 * 「每个封禁窗口里最多能白拿 N 个码的答案」，而不是 N-1 个。
 */
async function firstRefusal(port, codes, headers) {
  const detail = [];
  let idx = -1, err = null, conn = null;
  for (let i = 0; i < codes.length; i++) {
    const c = await join({ port, room: codes[i], headers, waitMs: 200 });
    const e = c.inbox.find((m) => m.t === 'error');
    if (e) {
      detail.push(codes[i] + '=拒');
      if (idx < 0) { idx = i; err = e; conn = c; }
    } else {
      detail.push(codes[i] + '=放');
      c.close();
    }
  }
  return { idx, err, conn, detail: detail.join(' ') };
}

/** 被控端：明文 TCP */
function agentConnect({ port, room, waitMs = 350 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1' }, () => {
      sock.setNoDelay(true);
      let buf = Buffer.alloc(0);
      let closed = false;
      const inbox = [];
      sock.on('close', () => { closed = true; });
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 5 + len) break;
          const type = buf.readUInt8(4);
          const payload = Buffer.from(buf.subarray(5, 5 + len));
          buf = buf.subarray(5 + len);
          if (type === 0x01) { try { inbox.push(JSON.parse(payload.toString('utf8'))); } catch (_) {} }
        }
      });
      sock.write(jsonFrame({ t: 'hello', room, name: 'test', mode: 'unattended' }));
      setTimeout(() => resolve({
        sock, inbox,
        paired: inbox.some((m) => m.t === 'paired'),
        refused: inbox.some((m) => m.t === 'error'),
        isClosed: () => closed,
        close() { try { sock.end(); } catch (_) {} },
      }), waitMs);
    });
    sock.on('error', reject);
  });
}

/* ---------- /health ---------- */
function health({ port, token, bearer }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    http.get({ port, host: '127.0.0.1', path: '/health' + (token ? '?token=' + token : ''), headers },
      (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => resolve(JSON.parse(s))); }
    ).on('error', reject);
  });
}

/* ---------- 服务器 ---------- */
function startServer(port, tcpPort, env) {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      HTTP_PORT: String(port), TCP_PORT: String(tcpPort),
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d.toString(); });
  srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  return { srv, getOut: () => out };
}

const servers = [];
function launch(port, tcpPort, env) {
  const s = startServer(port, tcpPort, env);
  servers.push(s.srv);
  return s;
}

(async function main() {
  console.log('启动 5 个临时中继（各用不同端口/参数）…');
  const A = launch(18510, 18511, { RATE_LIMIT_DISTINCT: '3', RATE_LIMIT_BLOCK_MS: '3000', RATE_LIMIT_WINDOW_MS: '60000' });
  const B = launch(18520, 18521, { RATE_LIMIT_DISTINCT: '3', RATE_LIMIT_BLOCK_MS: '3000', RATE_LIMIT_WINDOW_MS: '60000' });
  const C = launch(18530, 18531, { HEALTH_TOKEN: 's3cr3t-token' });
  const D = launch(18540, 18541, { TRUST_PROXY: '1', RATE_LIMIT_DISTINCT: '2', RATE_LIMIT_BLOCK_MS: '5000' });
  const E = launch(18550, 18551, { RATE_LIMIT_DISTINCT: '2', RATE_LIMIT_BLOCK_MS: '2000' });
  await sleep(1600);

  const cleanup = () => { for (const s of servers) { try { s.kill(); } catch (_) {} } };

  try {
    /* ================= A ================= */
    console.log('\n[A] 限流基本行为（DISTINCT=3 触发，封 3 秒）');

    const hA = await health({ port: 18510 });
    ok('/health 报出限流参数', hA.rateLimit && hA.rateLimit.enabled === true
      && hA.rateLimit.distinct === 3 && hA.rateLimit.blockMs === 3000, JSON.stringify(hA.rateLimit));
    ok('/health 报出正在跟踪的 IP 数', typeof hA.rateLimit.tracked === 'number', String(hA.rateLimit.tracked));

    // 正常路径：被控端先上线，控制端连进去 —— 不该有任何失败记账
    const agentA = await agentConnect({ port: 18511, room: 'REALROOM' });
    ok('被控端上线拿到 paired', agentA.paired, JSON.stringify(agentA.inbox));

    const good1 = await join({ port: 18510, room: 'REALROOM' });
    ok('控制端连对的码拿到 welcome', good1.inbox.some((m) => m.t === 'welcome'));
    ok('welcome 里 agent=true', (good1.inbox.find((m) => m.t === 'welcome') || {}).agent === true);
    ok('正常连接不会被回 error', !good1.inbox.some((m) => m.t === 'error'));
    good1.close();

    // 四个不同的错码：前三个放行（第三个同时触发封禁），第四个被拒
    const r = await firstRefusal(18510, ['WRONGAA1', 'WRONGAA2', 'WRONGAA3', 'WRONGAA4']);
    ok('试满 3 个不同的错码后，第 4 次开始被拒', r.idx === 3, r.detail);
    ok('被拒时带上 retryAfterMs（控制端靠它压住重连）',
      !!r.err && r.err.retryAfterMs > 0 && r.err.retryAfterMs <= 3000, r.err && String(r.err.retryAfterMs));
    ok('被拒时给出人能看懂的原因', !!r.err && /尝试次数过多/.test(r.err.msg || ''), r.err && r.err.msg);
    await sleep(150);
    ok('被拒后连接被服务器关掉', r.conn.isClosed());
    r.conn.close();

    // 封禁是按 IP 的，不是按码的 —— 对的码此刻也进不去
    const goodBlocked = await join({ port: 18510, room: 'REALROOM' });
    ok('封禁期间连对的码也进不去（说明封的是 IP 不是码）',
      goodBlocked.inbox.some((m) => m.t === 'error'), JSON.stringify(goodBlocked.inbox));
    goodBlocked.close();

    // 反向断言：默认配置下伪造 X-Forwarded-For 不能换一个身份
    const forged = await join({ port: 18510, room: 'REALROOM', headers: { 'X-Forwarded-For': '203.0.113.99' } });
    ok('没开 TRUST_PROXY 时伪造 XFF 也绕不过限流',
      forged.inbox.some((m) => m.t === 'error'), JSON.stringify(forged.inbox));
    forged.close();

    // 解封
    await sleep(3100);
    const goodAfter = await join({ port: 18510, room: 'REALROOM' });
    ok('封禁到期后连对的码恢复正常', goodAfter.inbox.some((m) => m.t === 'welcome'),
      JSON.stringify(goodAfter.inbox));
    goodAfter.close();

    const hA2 = await health({ port: 18510 });
    ok('成功之后这个 IP 的记账被清掉', hA2.rateLimit.tracked === 0, String(hA2.rateLimit.tracked));
    agentA.close();

    /* ================= B ================= */
    console.log('\n[B] 同一个码反复重试不该被封（正常用户最常见的行为）');
    let sameOk = true, sawError = null;
    for (let i = 0; i < 12; i++) {
      const c = await join({ port: 18520, room: 'RETRYME1', waitMs: 90 });
      if (!c.inbox.some((m) => m.t === 'welcome') || c.inbox.some((m) => m.t === 'error')) {
        sameOk = false;
        sawError = JSON.stringify(c.inbox);
        c.close();
        break;
      }
      c.close();
    }
    ok('同一个码连 12 次，每次都被放行', sameOk, sawError);
    // 再补几个**不同**的码就该封了，说明它确实在计数，只是不计同一个码
    const rB = await firstRefusal(18520, ['RETRYME2', 'RETRYME3', 'RETRYME4']);
    ok('但换成不同的码，第 4 个就被拒（说明不同码确实在计数）', rB.idx === 2, rB.detail);
    if (rB.conn) rB.conn.close();

    /* ================= C ================= */
    console.log('\n[C] /health 令牌');
    const cNo = await health({ port: 18530 });
    ok('不带令牌：拿不到 rooms', Array.isArray(cNo.rooms) && cNo.rooms.length === 0
      && cNo.roomsHidden === true, JSON.stringify(cNo));
    ok('不带令牌：其它字段照常返回（nginx 健康检查还能用）', cNo.ok === true && !!cNo.tls);
    const cBad = await health({ port: 18530, token: 'wrong' });
    ok('令牌不对：同样拿不到 rooms', cBad.roomsHidden === true && cBad.rooms.length === 0);
    // 先造一个真房间，才能验证「带对了令牌能看到码」
    const cAgent = await agentConnect({ port: 18531, room: 'SECRETRM' });
    const cGood = await health({ port: 18530, token: 's3cr3t-token' });
    ok('令牌对了：能看到 rooms 和配对码',
      cGood.roomsHidden === undefined && cGood.rooms.some((rr) => rr.code === 'SECRETRM'),
      JSON.stringify(cGood.rooms));
    const cBearer = await health({ port: 18530, bearer: 's3cr3t-token' });
    ok('也支持 Authorization: Bearer', cBearer.rooms.some((rr) => rr.code === 'SECRETRM'));
    cAgent.close();

    /* ================= D ================= */
    console.log('\n[D] TRUST_PROXY=1：按真实客户端 IP 分开计数（DISTINCT=2）');
    const rD = await firstRefusal(18540, ['XFFROOM1', 'XFFROOM2', 'XFFROOM3'],
      { 'X-Forwarded-For': '198.51.100.7' });
    ok('客户端 A 试满 2 个错码后被拒', rD.idx === 2, rD.detail);
    if (rD.conn) rD.conn.close();
    const rD2 = await firstRefusal(18540, ['XFFROOM4', 'XFFROOM5'],
      { 'X-Forwarded-For': '198.51.100.8' });
    ok('另一个 IP 完全不受影响（说明是按 IP 分开记账的）', rD2.idx === -1, rD2.detail);

    /* ================= E ================= */
    console.log('\n[E] 被控端链路：顶掉在线被控端算一次失败（DISTINCT=2，封 2 秒）');
    const eAgents = [];
    for (const room of ['EAGENT01', 'EAGENT02', 'EAGENT03']) {
      const a = await agentConnect({ port: 18551, room });
      eAgents.push(a);
      ok(`被控端 ${room} 上线`, a.paired, JSON.stringify(a.inbox));
    }
    // 第 1 次顶掉：记 1 笔，还没到 2，放行
    const kick1 = await agentConnect({ port: 18551, room: 'EAGENT01' });
    ok('第 1 次顶掉在线被控端：仍放行（只记了一笔账）', kick1.paired, JSON.stringify(kick1.inbox));
    kick1.close();
    // 第 2 次顶掉：到 2，触发封禁（这一次本身也放进来了）
    const kick2 = await agentConnect({ port: 18551, room: 'EAGENT02' });
    ok('第 2 次顶掉：仍放行，但这一次触发了封禁', kick2.paired, JSON.stringify(kick2.inbox));
    kick2.close();
    // 关键：封禁期间，猜码的人**顶不掉**在线被控端了
    const kick3 = await agentConnect({ port: 18551, room: 'EAGENT03' });
    ok('封禁期间再顶 EAGENT03：被拒，顶不掉', !kick3.paired && kick3.refused, JSON.stringify(kick3.inbox));
    await sleep(150);
    ok('被拒的被控端连接被服务器断开', kick3.isClosed());
    kick3.close();
    // 封禁期间连全新的码也进不来（被控端口子和控制端口子共用同一个 IP 额度）
    const fresh = await agentConnect({ port: 18551, room: 'EAGENT09' });
    ok('封禁期间新码也被拒（被控端与控制端共用同一个 IP 额度）',
      !fresh.paired && fresh.refused, JSON.stringify(fresh.inbox));
    fresh.close();
    // 解封后：EAGENT03 原来那个被控端还活着 —— 说明上面的「顶不掉」是真的顶不掉
    await sleep(2100);
    const check = await join({ port: 18550, room: 'EAGENT03', waitMs: 300 });
    const cw = check.inbox.find((m) => m.t === 'welcome') || {};
    ok('解封后 EAGENT03 的在线被控端还在（上面确实没顶掉）', cw.agent === true, JSON.stringify(check.inbox));
    check.close();
    for (const a of eAgents) a.close();

    /* ---- 服务器日志里应该留下可查的痕迹 ---- */
    console.log('\n[F] 日志');
    const outA = A.getOut();
    ok('日志里记了「疑似在猜配对码」', /疑似在猜配对码/.test(outA));
    ok('日志里记了封禁时长和 IP', /封禁 \d+ 秒：/.test(outA));
    ok('日志里记了「拒绝配对请求」', /拒绝配对请求/.test(outA));
    const outE = E.getOut();
    ok('日志里记了「来了第二个被控端」', /来了第二个被控端/.test(outE));
  } catch (e) {
    fail++;
    console.log('\n测试过程中抛异常：' + (e && e.stack || e));
  }

  cleanup();
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + `：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
