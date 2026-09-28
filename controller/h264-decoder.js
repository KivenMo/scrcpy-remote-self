/*
 * H.264 解码器（基于 WebCodecs）+ 二进制帧格式解析
 *
 * 被 controller/index.html 和 controller/test-h264.html 共用。
 *
 * ── 二进制帧格式（服务器只透传，不解析）────────────────────
 *   [0]      kind      0x01 = JPEG 整帧
 *                      0x02 = H.264 分片
 *                      0x03 = 文件分片（被控端 -> 控制端）
 *   [1]      flags     bit0 = 关键帧（I 帧，仅 H.264 有意义）
 *   [2..9]   pts       无符号 64 位大端，微秒（文件分片里没用，填 0）
 *   [10..]   payload   JPEG 字节 / AVCC 长度前缀的 NAL 单元 / 文件原始字节
 * ────────────────────────────────────────────────────────
 *
 * 文件分片复用同一条通道、同一套 10 字节头，所以服务器完全不用改，
 * 控制端只要在 parseFrame 之后按 kind 分流即可。
 *
 * 为什么用 AVCC 而不是 Annex-B：WebCodecs 在给了 description(avcC)
 * 的情况下要求数据是 4 字节长度前缀的 NAL。安卓端 MediaCodec 吐出来的
 * 是 Annex-B（00 00 00 01 起始码），所以那边会先转好再发。
 */
(function (global) {
  'use strict';

  var KIND_JPEG = 0x01;
  var KIND_H264 = 0x02;
  var KIND_FILE = 0x03;
  var HEADER = 10;

  /* ---------------- 工具 ---------------- */

  function b64ToBytes(b64) {
    var bin = global.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 把 ArrayBuffer 拆成 { kind, key, pts, data } */
  function parseFrame(buffer) {
    var u8 = new Uint8Array(buffer);
    if (u8.length < HEADER) return null;
    var dv = new DataView(buffer);
    var hi = dv.getUint32(2, false);
    var lo = dv.getUint32(6, false);
    return {
      kind: u8[0],
      key: (u8[1] & 1) === 1,
      pts: hi * 4294967296 + lo,
      data: u8.subarray(HEADER),
    };
  }

  /** 给一帧加头（自测页里模拟安卓端用） */
  function buildFrame(kind, isKey, pts, payload) {
    var out = new Uint8Array(HEADER + payload.length);
    out[0] = kind;
    out[1] = isKey ? 1 : 0;
    var dv = new DataView(out.buffer);
    dv.setUint32(2, Math.floor(pts / 4294967296), false);
    dv.setUint32(6, pts >>> 0, false);
    out.set(payload, HEADER);
    return out;
  }

  /* ---------------- 解码器 ---------------- */

  function H264Decoder(opts) {
    opts = opts || {};
    this.canvas = opts.canvas;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.onSize = opts.onSize || function () {};
    this.onError = opts.onError || function () {};
    this.onFrame = opts.onFrame || function () {};

    this.decoder = null;
    this.configured = false;
    this.codec = '';
    this.width = 0;
    this.height = 0;
    this.decoded = 0;
    this.dropped = 0;
    this.waitingKey = true;
  }

  /** 浏览器是否支持 WebCodecs 解码 */
  H264Decoder.supported = function () {
    return typeof global.VideoDecoder === 'function'
        && typeof global.EncodedVideoChunk === 'function';
  };

  /**
   * 用服务端下发的 avcC description 配置解码器。
   * 返回 Promise<boolean>，不支持就 resolve(false)，调用方据此回退到 JPEG。
   */
  H264Decoder.prototype.configure = function (codec, descB64, w, h) {
    var self = this;
    this.close();

    if (!H264Decoder.supported()) return Promise.resolve(false);

    var config = { codec: codec, optimizeForLatency: true };
    if (descB64) config.description = b64ToBytes(descB64);
    if (w) config.codedWidth = w;
    if (h) config.codedHeight = h;

    return global.VideoDecoder.isConfigSupported(config).then(function (res) {
      if (!res || !res.supported) return false;
      var dec = new global.VideoDecoder({
        output: function (frame) { self._onOutput(frame); },
        error: function (e) {
          self.onError(e);
          self.close();
        },
      });
      dec.configure(res.config);
      self.decoder = dec;
      self.configured = true;
      self.codec = codec;
      self.waitingKey = true;
      return true;
    }).catch(function (e) {
      self.onError(e);
      return false;
    });
  };

  H264Decoder.prototype._onOutput = function (frame) {
    try {
      if (!this.width) {
        this.width = frame.displayWidth;
        this.height = frame.displayHeight;
        if (this.canvas) {
          this.canvas.width = this.width;
          this.canvas.height = this.height;
        }
        this.onSize(this.width, this.height);
      }
      if (this.ctx && this.canvas) {
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      }
      this.decoded++;
      this.onFrame(this.decoded);
    } catch (e) {
      this.onError(e);
    } finally {
      try { frame.close(); } catch (e) {}
    }
  };

  /** 喂一帧 AVCC 数据。关键帧到达前丢掉 delta，否则解码器会报错。 */
  H264Decoder.prototype.push = function (data, isKey, pts) {
    if (!this.configured || !this.decoder) return false;
    if (this.decoder.state !== 'configured') return false;

    if (this.waitingKey) {
      if (!isKey) { this.dropped++; return false; }
      this.waitingKey = false;
    }

    try {
      this.decoder.decode(new global.EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: pts,
        data: data,
      }));
      return true;
    } catch (e) {
      // 解码器状态坏了，等下一个关键帧重来
      this.waitingKey = true;
      this.onError(e);
      return false;
    }
  };

  /** 等待队列里所有帧都解完。自测和“切换编码前收尾”都用它。 */
  H264Decoder.prototype.flush = function () {
    if (!this.decoder || this.decoder.state !== 'configured') return Promise.resolve();
    try {
      return this.decoder.flush();
    } catch (e) {
      return Promise.resolve();
    }
  };

  H264Decoder.prototype.close = function () {
    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') this.decoder.close();
      } catch (e) {}
    }
    this.decoder = null;
    this.configured = false;
    this.waitingKey = true;
  };

  global.RAFrame = {
    KIND_JPEG: KIND_JPEG,
    KIND_H264: KIND_H264,
    KIND_FILE: KIND_FILE,
    HEADER: HEADER,
    parseFrame: parseFrame,
    buildFrame: buildFrame,
  };
  global.H264Decoder = H264Decoder;
})(window);
