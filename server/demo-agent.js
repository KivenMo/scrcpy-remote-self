'use strict';
/*
 * 假被控端 —— 用来在没有安卓手机的情况下验证整条链路。
 *
 *   node demo-agent.js [配对码] [服务器IP] [端口]
 *   node demo-agent.js DEMO1234
 *
 * 它会以 TCP 连上中继服务器，持续推送一张合成出来的“手机屏幕”
 * （PNG 帧，浏览器能直接解码），并且真的响应控制端发来的
 * tap / swipe / key 指令 —— 你点哪里，画面上就会在哪里留下印记。
 *
 * 用它可以验证：
 *   - 配对码握手是否正常
 *   - 画面能不能到浏览器
 *   - 触摸坐标换算对不对（点左上角，印记就该出现在左上角）
 */

const net = require('net');
const zlib = require('zlib');

const ROOM = (process.argv[2] || 'DEMO1234').toUpperCase();
const HOST = process.argv[3] || '127.0.0.1';
const PORT = parseInt(process.argv[4] || '8081', 10);

const W = 360, H = 780;

/* ---------------- 极简画布 ---------------- */
const px = new Uint8Array(W * H * 4);

function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
}
function fillRect(x, y, w, h, r, g, b) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPx(i, j, r, g, b);
}
function strokeRect(x, y, w, h, r, g, b, t) {
  t = t || 2;
  fillRect(x, y, w, t, r, g, b);
  fillRect(x, y + h - t, w, t, r, g, b);
  fillRect(x, y, t, h, r, g, b);
  fillRect(x + w - t, y, t, h, r, g, b);
}
function fillCircle(cx, cy, rad, r, g, b) {
  for (let j = cy - rad; j <= cy + rad; j++) {
    for (let i = cx - rad; i <= cx + rad; i++) {
      const dx = i - cx, dy = j - cy;
      if (dx * dx + dy * dy <= rad * rad) setPx(i, j, r, g, b);
    }
  }
}
function ring(cx, cy, rad, r, g, b, t) {
  t = t || 3;
  for (let a = 0; a < 360; a += 1.2) {
    const rad2 = a * Math.PI / 180;
    for (let k = 0; k < t; k++) {
      setPx(Math.round(cx + Math.cos(rad2) * (rad - k)),
            Math.round(cy + Math.sin(rad2) * (rad - k)), r, g, b);
    }
  }
}

/* ---------------- 合成一帧 ---------------- */
const APPS = [
  ['#E8F1FB', '#0A66C2'], ['#EAF3DE', '#3B6D11'], ['#FAEEDA', '#854F0B'],
  ['#FBEAF0', '#993556'], ['#E1F5EE', '#0F6E56'], ['#F1EFE8', '#5F5E5A'],
  ['#FCEBEB', '#A32D2D'], ['#EEEDFE', '#534AB7'],
];
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

let lastTap = null, lastSwipe = null, keyLabel = '—', tick = 0;

function render() {
  tick++;
  fillRect(0, 0, W, H, 0xF2, 0xF2, 0xF5);          // 背景
  fillRect(0, 0, W, 54, 0xFF, 0xFF, 0xFF);          // 状态栏
  fillRect(0, 54, W, 1, 0xE3, 0xE3, 0xE8);

  // 时间
  const t = new Date();
  const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  drawText(hhmm, 16, 20, 3, 0x1C, 0x1C, 0x1E);

  // 标题
  fillRect(0, 55, W, 62, 0xFF, 0xFF, 0xFF);
  drawText('远程协助 · 演示被控端', 20, 82, 2, 0x1C, 0x1C, 0x1E);

  // 应用网格
  const cols = 4, size = 52, gapX = (W - 40 - cols * size) / (cols - 1);
  for (let i = 0; i < APPS.length; i++) {
    const cx = 20 + (i % cols) * (size + gapX);
    const cy = 150 + Math.floor(i / cols) * 84;
    const [bgc, fgc] = APPS[i];
    const [r1, g1, b1] = hex(bgc);
    const [r2, g2, b2] = hex(fgc);
    fillRect(cx, cy, size, size, r1, g1, b1);
    // 让图标有轻微呼吸感，方便肉眼确认画面是活的
    const pulse = 10 + Math.round(6 * Math.sin((tick + i * 6) / 9));
    fillCircle(cx + size / 2, cy + size / 2, pulse, r2, g2, b2);
  }

  // 指令回显
  fillRect(0, 400, W, 120, 0xFF, 0xFF, 0xFF);
  drawText('最近一次按键: ' + keyLabel, 20, 430, 2, 0x3C, 0x44, 0x50);
  if (lastTap) {
    drawText('最近点击: ' + Math.round(lastTap.x * 100) + '% , ' + Math.round(lastTap.y * 100) + '%',
      20, 460, 2, 0x0A, 0x66, 0xC2);
    ring(Math.round(lastTap.x * W), Math.round(lastTap.y * H), 26, 0x0A, 0x66, 0xC2, 4);
  } else {
    drawText('点一下屏幕试试', 20, 460, 2, 0x8A, 0x8A, 0x8E);
  }
  if (lastSwipe) {
    drawText('最近滑动: 已记录', 20, 490, 2, 0x1D, 0x9E, 0x75);
    const x1 = Math.round(lastSwipe.x1 * W), y1 = Math.round(lastSwipe.y1 * H);
    const x2 = Math.round(lastSwipe.x2 * W), y2 = Math.round(lastSwipe.y2 * H);
    const steps = 40;
    for (let s = 0; s <= steps; s++) {
      const xx = Math.round(x1 + (x2 - x1) * s / steps);
      const yy = Math.round(y1 + (y2 - y1) * s / steps);
      fillCircle(xx, yy, 2, 0x1D, 0x9E, 0x75);
    }
  }

  // 底部导航栏
  fillRect(0, H - 46, W, 46, 0xFF, 0xFF, 0xFF);
  fillRect(0, H - 46, W, 1, 0xE3, 0xE3, 0xE8);
  const navs = ['返回', '主页', '多任务'];
  for (let i = 0; i < 3; i++) {
    drawText(navs[i], 40 + i * 110, H - 30, 2, 0x5F, 0x5E, 0x5A);
  }
}

/* 极简 5x7 点阵字体，够画数字和常用汉字位置标记 */
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '%': ['11001', '11010', '00100', '01000', '10011', '00011', '00000'],
  ',': ['00000', '00000', '00000', '00000', '00100', '00100', '01000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
};

let glyphFallbackWarned = false;
function drawText(str, x, y, scale, r, g, b) {
  let cx = x;
  for (const ch of str) {
    const gl = GLYPHS[ch];
    if (gl) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (gl[row][col] === '1') {
            fillRect(cx + col * scale, y + row * scale, scale, scale, r, g, b);
          }
        }
      }
    } else {
      // 非 ASCII 字符（中文）画成一个小方块占位，避免整行错位
      fillRect(cx, y + 2 * scale, 5 * scale, 3 * scale, r, g, b);
      if (!glyphFallbackWarned) {
        glyphFallbackWarned = true;
        console.log('提示：点阵字体只画数字/字母，中文会显示成色块，不影响功能验证。');
      }
    }
    cx += 6 * scale;
  }
}

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng() {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 与服务器通信 ---------------- */
function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}

/*
 * 上行画面帧格式，必须和控制端 h264-decoder.js 的解析对上：
 *   [0] kind   0x01 = 整帧图片   0x02 = H.264
 *   [1] flags  bit0 = 关键帧
 *   [2..9] pts  大端 64 位微秒
 *   [10..] 负载
 * 这里合成出来的是 PNG（浏览器一样能解），kind 用 0x01。
 */
let ptsCounter = 0;
function wrapImage(png) {
  return wrap(0x01, png);
}

/** 套上 10 字节统一帧头。kind: 0x01 JPEG / 0x02 H.264 / 0x03 文件分片 */
function wrap(kind, payload) {
  const out = Buffer.alloc(10 + payload.length);
  out[0] = kind;
  out[1] = 0;
  const hi = Math.floor(ptsCounter / 4294967296);
  const lo = ptsCounter >>> 0;
  out.writeUInt32BE(hi, 2);
  out.writeUInt32BE(lo, 6);
  payload.copy(out, 10);
  ptsCounter += 125000;   // 8fps
  return out;
}

/* 演示用的「手机上的文件」：内容是确定性公式，控制端取回去可以逐字节校验 */
const DEMO_FILES = [
  { id: 'demo-1', name: 'IMG_0001.jpg', size: 240 * 1024 + 11, kind: 'image', mime: 'image/jpeg', date: '2026-09-20' },
  { id: 'demo-2', name: 'IMG_0002.jpg', size: 96 * 1024, kind: 'image', mime: 'image/jpeg', date: '2026-09-21' },
  { id: 'demo-3', name: 'VID_0003.mp4', size: 512 * 1024 + 7, kind: 'video', mime: 'video/mp4', date: '2026-09-22' },
];
const DEMO_FILE_BYTE = (i) => (i * 31 + 7) & 0xFF;

/** 把演示文件分片推给控制端（复用二进制通道，kind = 0x03） */
let sendingFile = false;
function sendDemoFile(f) {
  if (sendingFile) {
    sock.write(frame(0x01, Buffer.from(JSON.stringify({
      t: 'fdone', ok: false, msg: '正在传另一个文件',
    }), 'utf8')));
    return;
  }
  sendingFile = true;
  console.log(`开始推送文件 ${f.name}（${f.size} 字节）`);
  sock.write(frame(0x01, Buffer.from(JSON.stringify({
    t: 'fbegin', name: f.name, size: f.size, mime: f.mime,
  }), 'utf8')));

  const CHUNK = 64 * 1024;
  let off = 0;
  (function step() {
    if (off >= f.size) {
      sock.write(frame(0x01, Buffer.from(JSON.stringify({
        t: 'fdone', ok: true, name: f.name,
      }), 'utf8')));
      console.log(`文件推送完成 ${f.name}（${f.size} 字节）`);
      sendingFile = false;
      return;
    }
    const n = Math.min(CHUNK, f.size - off);
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = DEMO_FILE_BYTE(off + i);
    sock.write(frame(0x02, wrap(0x03, buf)));
    off += n;
    setTimeout(step, 4);      // 让出事件循环，别把画面饿死
  })();
}

const sock = net.connect(PORT, HOST, () => {
  console.log(`已连接 ${HOST}:${PORT}，配对码 ${ROOM}`);
  sock.setNoDelay(true);
  sock.write(frame(0x01, Buffer.from(JSON.stringify({
    t: 'hello', room: ROOM, name: '演示机 (demo-agent)',
  }), 'utf8')));
});

let buf = Buffer.alloc(0);
let fakeClipboard = '演示端的剪贴板内容 123456';
let fileRecv = null;
let lastTapLabel = '';

sock.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 5 + len) break;
    const type = buf.readUInt8(4);
    const payload = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);

    if (type === 0x02) {                      // 控制端传来的文件分片
      if (fileRecv) {
        fileRecv.received += payload.length;
        const pct = Math.floor(fileRecv.received * 100 / fileRecv.size);
        if (pct >= fileRecv.lastPct + 20) {
          fileRecv.lastPct = pct;
          console.log(`  接收文件 ${fileRecv.name} ${pct}%`);
        }
      }
      continue;
    }

    let m;
    try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }

    if (m.t === 'tap') { lastTap = { x: m.x, y: m.y }; console.log('收到点击', m.x.toFixed(2), m.y.toFixed(2)); }
    else if (m.t === 'long') { lastTap = { x: m.x, y: m.y }; keyLabel = '长按'; console.log('收到长按'); }
    else if (m.t === 'swipe') { lastSwipe = m; console.log('收到滑动'); }
    else if (m.t === 'key') { keyLabel = m.k; console.log('收到按键', m.k); }
    else if (m.t === 'text') { console.log('收到文字', m.s); }
    else if (m.t === 'launch') { console.log('收到启动请求', m.pkg); }

    else if (m.t === 'clip') {
      fakeClipboard = m.v;
      console.log('收到剪贴板内容:', m.v, m.paste ? '（并要求粘贴）' : '');
      sock.write(frame(0x01, Buffer.from(JSON.stringify({ t: 'status', msg: '演示端已写入剪贴板' }), 'utf8')));
    }
    else if (m.t === 'clipget') {
      console.log('控制端要读剪贴板');
      sock.write(frame(0x01, Buffer.from(JSON.stringify({
        t: 'clip', src: 'clipboard', v: fakeClipboard,
      }), 'utf8')));
    }

    else if (m.t === 'fstart') {
      fileRecv = { name: m.name, size: m.size, received: 0, lastPct: 0 };
      console.log(`开始接收文件 ${m.name}（${m.size} 字节）`);
    }
    else if (m.t === 'fend') {
      const ok = fileRecv && fileRecv.received === fileRecv.size;
      console.log(`文件接收结束 ${fileRecv ? fileRecv.name : '?'}：收到 ${fileRecv ? fileRecv.received : 0} / ${fileRecv ? fileRecv.size : 0} 字节 ${ok ? '✓ 完整' : '✗ 不完整'}`);
      sock.write(frame(0x01, Buffer.from(JSON.stringify({
        t: 'status',
        msg: ok ? `演示端已收到 ${fileRecv.name}` : '文件不完整',
      }), 'utf8')));
      fileRecv = null;
    }
    else if (m.t === 'fcancel') {
      console.log('取消接收文件');
      fileRecv = null;
    }

    else if (m.t === 'flist') {
      console.log('控制端要文件列表');
      sock.write(frame(0x01, Buffer.from(JSON.stringify({
        t: 'flist',
        items: DEMO_FILES,
      }), 'utf8')));
    }
    else if (m.t === 'fget') {
      const f = DEMO_FILES.find((x) => x.id === m.id);
      if (!f) {
        sock.write(frame(0x01, Buffer.from(JSON.stringify({
          t: 'fdone', ok: false, msg: '演示端没有这个文件',
        }), 'utf8')));
      } else {
        sendDemoFile(f);
      }
    }

    else if (m.t === 'apps') {
      const list = [
        { n: 'Demo Messages', p: 'demo.messages' },
        { n: 'Demo Camera', p: 'demo.camera' },
        { n: 'Demo Maps', p: 'demo.maps' },
        { n: 'Demo Settings', p: 'demo.settings' },
      ];
      sock.write(frame(0x01, Buffer.from(JSON.stringify({ t: 'apps', list }), 'utf8')));
    }
    else if (m.t === 'codec') {
      // 演示端只合成 PNG，没有 H.264 编码器。明确回绝，让控制端立刻切回 JPEG，
      // 而不是干等 3 秒的回退超时。
      if (m.v === 'h264') {
        console.log('控制端请求 H.264，演示端只支持 JPEG，已回绝');
        sock.write(frame(0x01, Buffer.from(JSON.stringify({ t: 'codec', v: 'jpeg' }), 'utf8')));
      }
    }
    else if (m.t === 'quality') { console.log('收到画质切换', m.w + 'p / ' + m.fps + 'fps'); }
  }
});

sock.on('error', (e) => console.error('连接出错:', e.message));
sock.on('close', () => console.log('与服务器断开'));

/* 握手后先把画面尺寸报给控制端 */
setTimeout(() => {
  sock.write(frame(0x01, Buffer.from(JSON.stringify({
    t: 'meta', w: W, h: H, sw: W, sh: H, name: '演示机 (demo-agent)',
  }), 'utf8')));
}, 400);

let fps = 8, sending = false;
let bytesSent = 0;
setInterval(() => {
  if (sending) return;
  sending = true;
  try {
    render();
    const png = encodePng();
    const f = wrapImage(png);
    sock.write(frame(0x02, f));
    bytesSent += f.length;
  } catch (e) {
    console.error('渲染失败:', e.message);
  }
  sending = false;
}, Math.round(1000 / fps));

/* 定期把「实测带宽 + 档位」报给控制端，好让右上角的徽标能被看到。
 * 真被控端是 RateController 根据编码器写入耗时算的；演示端没有编码器，
 * 就按实际推出去的字节数折算，至少数字是真实的。 */
const NET_INTERVAL_MS = 2000;
let lastBytes = 0;
setInterval(() => {
  const delta = bytesSent - lastBytes;
  lastBytes = bytesSent;
  const kbps = Math.round((delta * 8) / (NET_INTERVAL_MS / 1000) / 1000);
  // 演示端永远走局域网，所以只分「良好 / 一般」两档，不会报「较差」
  const level = kbps >= 300 ? 2 : 1;
  try {
    sock.write(frame(0x01, Buffer.from(JSON.stringify({
      t: 'net', kbps, level, codec: 'jpeg',
    }), 'utf8')));
  } catch (e) {}
}, NET_INTERVAL_MS);

console.log(`开始推送 ${W}x${H} 画面，8fps。用控制端输入配对码 ${ROOM} 即可看到。`);
