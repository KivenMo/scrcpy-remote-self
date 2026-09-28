'use strict';
/*
 * verify-unattended.js —— 真机验证「文字模式」（无人值守）。
 *
 * 这一套的意义在于：被控端完全不申请录屏授权，所以启动时没有任何弹窗，
 * 手机放在公司也能一直待命。代价是控制端看不到画面，只能读界面文字。
 *
 * 这个脚本以控制端身份接入中继，逐条验证：
 *   1. 中继把 mode=unattended 传过来了（否则控制端会一直傻等视频）
 *   2. dump 能读回界面文字，且至少有一个可点元素
 *   3. taptext 找不到文字时如实回 ok:false（不误报成功）
 *   4. 发过去的指令真的到了手机（用一条无副作用的指令验，不碰用户界面）
 *   5. apps 能列出应用、ping 有回应、codec 明确回绝视频
 *
 * 用法：
 *   node server/verify-unattended.js JC484UQK [ws地址]
 *   node server/verify-unattended.js JC484UQK ws://127.0.0.1:8080/
 *
 * 需要中继在跑，且手机已经进入文字模式待命。
 */

const room = (process.argv[2] || '').toUpperCase().trim();
const url = process.argv[3] || 'ws://127.0.0.1:8080/';

if (!room) {
  console.error('用法: node server/verify-unattended.js <配对码> [ws地址]');
  process.exit(2);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 收到的消息按类型排队，等消息时从这里取 */
const inbox = [];
const waiters = [];
let welcomeMsg = null;

function onJson(m) {
  inbox.push(m);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(m)) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(m);
    }
  }
}

/** 等一条满足条件的消息；超时返回 null（不抛，让断言去报失败） */
function waitFor(match, ms) {
  const hit = inbox.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const w = { match, resolve };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, ms || 8000);
    waiters.push(w);
  });
}

/**
 * 发下一条指令前清空收件箱。
 *
 * 不清的话，`waitFor` 会命中**上一步**留下的那条同类型消息 —— 这个坑真踩过：
 * [2.6] 明明发了「远程协助 · 被控端」，拿到的回执却是 [2.5] 那条
 * 「开启文字模式 · 待命」的，于是测试报失败，看起来像被控端不滚动，
 * 其实是测试自己在读旧消息。
 */
function clearInbox() {
  inbox.length = 0;
}


const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';   // 必须在收消息之前设，否则拿到的是 Blob

let binaryFrames = 0;

ws.onopen = () => {
  console.log(`已连上中继 ${url}，以控制端身份加入房间 ${room}…`);
  ws.send(JSON.stringify({ t: 'hello', room }));
};

ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'welcome') welcomeMsg = m;
    onJson(m);
  } else {
    // 文字模式不该有任何二进制帧。收到就是有问题，记下来。
    binaryFrames++;
  }
};

ws.onerror = (e) => console.error('连接出错:', e.message || e);

function send(o) { ws.send(JSON.stringify(o)); }

(async () => {
  await sleep(900);

  console.log('\n[1] 模式协商');
  ok('控制端收到 welcome', !!welcomeMsg);
  if (!welcomeMsg) {
    console.log('\n被控端没上线或中继没在跑，后面的测不了。');
    process.exit(1);
  }
  ok('welcome 里报告被控端在线', welcomeMsg.agent === true);
  ok('mode = unattended（控制端因此不会去等视频）',
    welcomeMsg.mode === 'unattended', welcomeMsg.mode);
  console.log(`    设备名: ${welcomeMsg.device}`);

  console.log('\n[2] 读屏（dump）');
  clearInbox();
  send({ t: 'dump' });
  const ui = await waitFor((m) => m.t === 'ui', 10000);
  ok('收到 ui 消息', !!ui);
  let items = [];
  if (ui) {
    items = ui.items || [];
    ok('读到界面文字', items.length > 0, items.length + ' 项');
    ok('带回当前应用包名', typeof ui.pkg === 'string' && ui.pkg.length > 0, ui.pkg);
    ok('带回屏幕是否点亮', typeof ui.screenOn === 'boolean', ui.screenOn);
    const clickable = items.filter((it) => it.c);
    ok('至少有一个可点元素', clickable.length > 0, clickable.length + ' 个');
    console.log(`    当前应用: ${ui.pkg}  屏幕点亮: ${ui.screenOn}  共 ${items.length} 项，其中可点 ${clickable.length} 项`);
    console.log('    前 12 项：');
    items.slice(0, 12).forEach((it, i) => {
      const label = it.t || it.d || '';
      console.log(`      ${String(i + 1).padStart(2)}. ${it.c ? '👆' : '  '} ${label}`
        + `   @${it.x},${it.y}`);
    });
    // 每一项都必须带坐标，否则控制端点了也没用
    const badCoord = items.filter((it) => typeof it.x !== 'number' || typeof it.y !== 'number');
    ok('每一项都带坐标', badCoord.length === 0, badCoord.length + ' 项缺坐标');
    // 每一项都要标明在不在屏幕里。滚动过的列表里，屏幕外的节点坐标是负的，
    // 照那个坐标点下去会落到屏幕边缘 —— 必须能区分出来。
    const badVis = items.filter((it) => typeof it.v !== 'boolean');
    ok('每一项都标了在不在屏幕里', badVis.length === 0, badVis.length + ' 项缺 v');
    ok('带回屏幕尺寸', typeof ui.sw === 'number' && typeof ui.sh === 'number',
      ui.sw + 'x' + ui.sh);
    const offScreen = items.filter((it) => it.v === false);
    console.log(`    屏幕内 ${items.length - offScreen.length} 项 / 屏幕外 ${offScreen.length} 项`
      + `  屏幕 ${ui.sw}x${ui.sh}`);
    if (offScreen.length) {
      console.log(`    屏幕外示例: 「${(offScreen[0].t || offScreen[0].d || '').slice(0, 30)}」`
        + ` @${offScreen[0].x},${offScreen[0].y}`);
    }
  }

  console.log('\n[2.5] 屏幕外的元素不能瞎点');
  // 找一个「可点但在屏幕外」的元素，不带 scroll 去点它：
  // 被控端必须拒绝并说明原因，而不是照着负坐标点下去（那样会点到屏幕边缘的随机东西）。
  const offClickable = items.filter((it) => it.c && it.v === false)[0];
  if (!offClickable) {
    console.log('    （当前界面没有屏幕外的可点元素，跳过）');
  } else {
    const label = offClickable.t || offClickable.d;
    clearInbox();
    send({ t: 'taptext', q: label, scroll: false });
    const ackOff = await waitFor((m) => m.t === 'ack' && m.op === 'taptext', 8000);
    ok('屏幕外元素被拒绝点击', !!ackOff && ackOff.ok === false,
      ackOff ? JSON.stringify(ackOff) : 'no ack');
    ok('拒绝理由说明了「在屏幕外」',
      !!ackOff && /屏幕外/.test(ackOff.msg || ''), ackOff && ackOff.msg);
    console.log(`    ${ackOff && ackOff.msg}`);
  }

  console.log('\n[2.6] 带 scroll 时能自己滚过去点到（上下两个方向都要试）');
  /*
   * 靶子挑「屏幕外的、没有点击行为的 TextView」——滚过去点中它没有任何副作用。
   * 别拿按钮当靶子：那会真的改变手机上的设置。
   *
   * 必须两个方向都试。只朝下翻的话，「目标在当前视口上方」永远找不到 ——
   * 这个 bug 真实存在过：手机上滑到底之后，标题跑到了 y=-1347，
   * 于是 6 次滚动全在往下翻，越翻越远，最后报「找不到」。
   *
   * 每个方向都要**重新 dump 一次**再挑靶子。
   * 一开始是「从最上面那次 dump 里一次挑好两个靶子」，结果测「上方」时用的
   * 是滚动之前的位置 —— 而「下方」那一轮已经把页面滚走了，原来记下的坐标早就不作数。
   * 现象是「目标在上方」这条随机红/绿，取决于页面初始滚到哪里。
   */
  async function dumpUi() {
    clearInbox();
    send({ t: 'dump' });
    const m = await waitFor((x) => x.t === 'ui', 10000);
    return m || { items: [], sw: 1080, sh: 2340 };
  }

  async function tryScroll(q, where) {
    console.log(`    [${where}] 靶子：「${q}」`);
    clearInbox();
    send({ t: 'taptext', q, scroll: true });
    const ack = await waitFor((m) => m.t === 'ack' && m.op === 'taptext', 25000);
    ok(`目标在${where}时，滚动查找能点到`, !!ack && ack.ok === true,
      ack ? JSON.stringify(ack) : 'no ack');
    console.log(`        ${ack && ack.msg}`);
  }

  /** 从当前界面里挑一个指定方向的屏幕外纯文本元素 */
  function pickOffscreen(fresh, dir) {
    const plain = (fresh.items || []).filter((it) => !it.c && it.v === false && (it.t || it.d));
    return dir === 'below'
      ? plain.filter((it) => it.y > (fresh.sh || 2340))[0]
      : plain.filter((it) => it.y < 0)[0];
  }

  const ui1 = await dumpUi();
  const below = pickOffscreen(ui1, 'below');
  if (below) {
    await tryScroll((below.t || below.d).slice(0, 12), '下方');
  } else {
    console.log('    [下方] 当前界面没有屏幕下方的纯文本元素，跳过');
  }

  // 上面那一轮已经把页面滚下去了，所以这里重新 dump 才会看到「在上方」的内容。
  // 顺序反过来的话，测「上方」时页面还停在顶部，压根没有 y<0 的东西。
  const ui2 = await dumpUi();
  const above = pickOffscreen(ui2, 'above');
  if (above) {
    await tryScroll((above.t || above.d).slice(0, 12), '上方');
  } else {
    console.log('    [上方] 当前界面没有屏幕上方的纯文本元素，跳过');
  }

  console.log('\n[3] 按文字点：找不到时要如实说「找不到」');
  const bogus = '__这个文字肯定不在屏幕上__' + Date.now();
  clearInbox();
  send({ t: 'taptext', q: bogus });
  const ackNo = await waitFor((m) => m.t === 'ack' && m.op === 'taptext', 8000);
  ok('收到 taptext 的回执', !!ackNo);
  if (ackNo) {
    ok('ok = false（没瞎报成功）', ackNo.ok === false, JSON.stringify(ackNo));
    ok('回执里说明了原因', typeof ackNo.msg === 'string' && ackNo.msg.length > 0, ackNo.msg);
    console.log(`    ${ackNo.msg}`);
  }

  console.log('\n[4] 指令确实到达了手机（用无副作用的 ping 验通路）');
  clearInbox();
  send({ t: 'ping' });
  const pong = await waitFor((m) => m.t === 'pong', 8000);
  ok('收到 pong', !!pong);
  ok('pong 里带 mode=unattended', !!pong && pong.mode === 'unattended', pong && pong.mode);

  console.log('\n[5] 应用列表');
  clearInbox();
  send({ t: 'apps' });
  const apps = await waitFor((m) => m.t === 'apps', 10000);
  ok('收到 apps', !!apps);
  if (apps) {
    const list = apps.list || [];
    ok('应用列表非空', list.length > 0, list.length + ' 个');
    console.log(`    共 ${list.length} 个可启动应用，例如：`
      + list.slice(0, 6).map((a) => a.n || a.p).join('、'));
  }

  console.log('\n[6] 控制端要视频时，明确回绝');
  clearInbox();
  send({ t: 'codec', v: 'h264' });
  const codecReply = await waitFor((m) => m.t === 'codec', 8000);
  ok('收到 codec 回复', !!codecReply);
  if (codecReply) {
    ok('v = none（没有画面）', codecReply.v === 'none', codecReply.v);
    ok('说明里讲清了原因', typeof codecReply.msg === 'string' && codecReply.msg.length > 0,
      codecReply.msg);
    console.log(`    ${codecReply.msg}`);
  }

  console.log('\n[7] 文字模式不该有任何视频流');
  ok('没有收到二进制帧', binaryFrames === 0, binaryFrames + ' 帧');

  console.log('\n────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  try { ws.close(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n验证异常：', e);
  process.exit(1);
});
