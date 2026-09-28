'use strict';
/*
 * probe.js —— 以「控制端」身份接入中继，报告被控端实际发了什么。
 *
 * 用来确认真机是否真的在推画面（而不是只看 /health 里 agent:true）。
 * 不依赖浏览器，不需要 WebCodecs，只统计字节流。
 *
 *   node server/probe.js JC484UQK [秒数] [ws地址]
 *   node server/probe.js JC484UQK 8 ws://127.0.0.1:8080/
 */

const room = (process.argv[2] || '').toUpperCase().trim();
const seconds = parseInt(process.argv[3] || '8', 10);
const url = process.argv[4] || 'ws://127.0.0.1:8080/';

if (!room) {
  console.error('用法: node server/probe.js <配对码> [秒数] [ws地址]');
  process.exit(2);
}

const KIND = { 0x01: 'JPEG', 0x02: 'H264', 0x03: 'FILE' };

const stats = {
  json: {},          // t -> 次数
  kinds: {},         // 帧类型 -> 次数
  frames: 0,
  bytes: 0,
  firstAt: 0,
  lastAt: 0,
  meta: null,
  sampleSizes: [],
};

const ws = new WebSocket(url);

// 必须在收到消息之前设置。Node 内置 WebSocket（undici）默认给 Blob，
// 在 onmessage 里再设就晚了 —— 会拿到 Blob 然后 Buffer.from 炸掉。
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  console.log(`已连上中继 ${url}，用配对码 ${room} 加入房间…`);
  ws.send(JSON.stringify({ t: 'hello', room }));
};

ws.onmessage = async (ev) => {
  const now = Date.now();
  if (typeof ev.data === 'string') {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    stats.json[m.t] = (stats.json[m.t] || 0) + 1;
    if (m.t === 'welcome') {
      console.log(`  welcome: agent=${m.agent} device=${m.device}`);
    } else if (m.t === 'meta') {
      stats.meta = m;
      console.log(`  meta: 采集 ${m.w}x${m.h}  设备屏 ${m.sw}x${m.sh}  编码 ${m.codec}`);
    } else if (m.t === 'net') {
      console.log(`  net: ${m.kbps}kbps level=${m.level} codec=${m.codec}`);
    } else if (m.t === 'agent-offline' || m.t === 'agent-online') {
      console.log(`  ${m.t}: ${m.device || ''}`);
    }
    return;
  }

  // 二进制：10 字节头 + 负载
  let raw = ev.data;
  if (raw && typeof raw.arrayBuffer === 'function') raw = await raw.arrayBuffer();  // Blob 兜底
  const buf = Buffer.from(raw);
  if (buf.length < 10) return;
  const kind = buf[0];
  const payloadLen = buf.length - 10;
  stats.frames++;
  stats.bytes += payloadLen;
  stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;
  if (!stats.firstAt) stats.firstAt = now;
  stats.lastAt = now;
  if (stats.sampleSizes.length < 8) stats.sampleSizes.push(payloadLen);
};

ws.onerror = (e) => {
  console.error('连接出错:', e.message || e);
};

ws.onclose = () => {
  console.log('连接已关闭');
};

setTimeout(() => {
  const span = stats.firstAt ? (stats.lastAt - stats.firstAt) / 1000 : 0;
  // 只有 1 帧时没有时间跨度，算不出码率/帧率 —— 这种情况通常是「屏幕静止、
  // 被控端补发了一个关键帧」，直接说明白，别显示成 0.0 fps 让人以为卡住了。
  const single = stats.frames === 1;
  const kbps = span > 0 ? (stats.bytes * 8 / span / 1000) : 0;
  const fps = span > 0 ? (stats.frames / span) : 0;

  console.log('\n===== 探测结果 =====');
  console.log(`配对码      ${room}`);
  console.log(`收到帧数    ${stats.frames}${single ? '  （静止画面下的关键帧补发）' : ''}`);
  console.log(`画面字节    ${stats.bytes}  (${(stats.bytes / 1024).toFixed(1)} KB)`);
  console.log(`平均帧大小  ${stats.frames ? Math.round(stats.bytes / stats.frames) : 0} B`);
  console.log(`前几帧大小  [${stats.sampleSizes.join(', ')}]`);
  console.log(`码率        ${single ? '—（样本不足）' : kbps.toFixed(0) + ' kbps'}`);
  console.log(`帧率        ${single ? '—（样本不足）' : fps.toFixed(1) + ' fps'}`);
  console.log(`帧类型      ${Object.entries(stats.kinds).map(([k, v]) => `${KIND[k] || ('0x' + (+k).toString(16))}x${v}`).join(' ') || '(无)'}`);
  console.log(`JSON 消息   ${Object.entries(stats.json).map(([k, v]) => `${k}x${v}`).join(' ') || '(无)'}`);

  const ok = stats.frames > 0;
  console.log(`\n结论: ${ok ? '真机正在推画面 ✓' : '没收到任何画面帧 ✗'}`);
  try { ws.close(); } catch (_) {}
  process.exit(ok ? 0 : 1);
}, seconds * 1000);
