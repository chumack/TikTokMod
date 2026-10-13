'use strict';

// Live chat capture and archiving.
//
// WHY THE CHAT COMES FROM THE PAGE'S OWN WEBSOCKET
// ------------------------------------------------
// TikTok's live chat is a protobuf stream over a WebSocket that the page opens
// to webcast.tiktok.com. Connecting to that socket from the main process is not
// an option: the URL is signed (Euler Stream / api.eulerstream.com in every
// open-source client — TikTokLive, TikTok-Live-Connector), the dynamic parts
// (push_server, cursor, routeParams, internalExt) only come from that signer,
// and the signed URL expires in ~30 s. There is no REST endpoint for live
// comments either: every `comment/list` route in public code is for VOD.
//
// But the embedded browser ALREADY has a signed, authenticated socket open,
// carrying exactly the messages the viewer sees, over the user's own cookies
// and proxy. So this module never talks to the network: it decodes frames the
// guest hands over (see src/preload/webview-preload.js) and writes them to disk.
//
// PROTOBUF FIELD NUMBERS
// ----------------------
// Protobuf's wire format is self-describing enough that hand-decoding three
// messages is cheaper and more durable than taking a compiler dependency for a
// schema TikTok can change at any time. Numbers are from the public schemas:
//   jwdeveloper/TikTokLiveJava  API/src/main/proto/webcast.proto, data.proto
//   steampoweredtaco/gotiktoklive proto/webcast.proto
//   TikTok-Live-Connector      src/lib/ws/lib/proto-utils.ts (gzip + framing)
// Any unknown field is skipped by wire type, so a TikTok-side addition cannot
// break the decoder — it just is not read.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CHAT_METHOD = 'WebcastChatMessage';

// ---------------------------------------------------------------- protobuf --

// int64 values are returned as BigInt on purpose. A TikTok roomId is 19 digits
// (~7.4e18), well past Number.MAX_SAFE_INTEGER (9.0e15): decoding it as a JS
// number silently rounds it, and the rounded value then fails to match the room
// id the recording was started with, so every message is dropped as "another
// room". Fields that are genuinely small (msgId, createTime, lengths) are
// converted to Number at the call site.
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const byte = buf[p];
    p += 1;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) return [result, p];
    // A malformed frame must terminate; 10 bytes is the protobuf maximum.
    if (shift > 70n) return [null, -1];
  }
  return [null, -1];
}

/**
 * Walks every field of an encoded message, yielding [fieldNo, wireType, value].
 * Length-delimited fields yield a subarray; varints a BigInt; fixed32/64 a
 * Number. Bails out cleanly on a truncated or malformed frame rather than
 * throwing — chat arrives on a busy socket and one bad frame must not kill the
 * stream.
 */
function* eachField(buf) {
  let p = 0;
  while (p < buf.length) {
    let key;
    let next;
    [key, next] = readVarint(buf, p);
    if (key === null) return;
    p = next;

    const tag = Number(key);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) return;

    if (wire === 0) {
      let v;
      [v, next] = readVarint(buf, p);
      if (v === null) return;
      p = next;
      yield [field, wire, v];
    } else if (wire === 2) {
      let len;
      [len, next] = readVarint(buf, p);
      if (len === null) return;
      // The payload starts AFTER the length varint, not at it.
      p = next;
      const end = p + Number(len);
      if (end > buf.length) return;
      yield [field, wire, buf.subarray(p, end)];
      p = end;
    } else if (wire === 5) {
      if (p + 4 > buf.length) return;
      yield [field, wire, buf.readUInt32LE(p)];
      p += 4;
    } else if (wire === 1) {
      if (p + 8 > buf.length) return;
      yield [field, wire, Number(buf.readBigUInt64LE(p))];
      p += 8;
    } else {
      // Wire types 3/4 are deprecated groups; the webcast schema uses none.
      return;
    }
  }
}

function str(buf) {
  return buf ? buf.toString('utf8') : '';
}

// -------------------------------------------------------------- the schema --

// WebcastPushFrame: PayloadEncoding=6, PayloadType=7, Payload=8.
function decodePushFrame(buf) {
  const out = { encoding: '', type: '', payload: null };
  for (const [field, wire, value] of eachField(buf)) {
    if (wire !== 2) continue;
    if (field === 6) out.encoding = str(value);
    else if (field === 7) out.type = str(value);
    else if (field === 8) out.payload = value;
  }
  return out;
}

// ProtoMessageFetchResult: messages=1 (repeated BaseProtoMessage).
// BaseProtoMessage: method=1 (string), payload=2 (bytes), msgId=3 (int64).
function decodeFetchResult(buf) {
  const messages = [];
  for (const [field, wire, value] of eachField(buf)) {
    if (field !== 1 || wire !== 2) continue;
    const msg = { method: '', payload: null, msgId: 0 };
    for (const [f2, w2, v2] of eachField(value)) {
      if (f2 === 1 && w2 === 2) msg.method = str(v2);
      else if (f2 === 2 && w2 === 2) msg.payload = v2;
      else if (f2 === 3 && w2 === 0) msg.msgId = v2;
    }
    if (msg.method && msg.payload) messages.push(msg);
  }
  return messages;
}

// WebcastChatMessage: common=1, user=2, content=3.
// CommonMessageData: msgId=2, roomId=3, createTime=4 (ms epoch).
// User: id=1, nickname=3, username=38 (the web `uniqueId`, shown as @handle).
function decodeChatMessage(buf) {
  let content = '';
  let nickname = '';
  let displayId = '';
  let msgId = 0;
  let roomId = '';
  let createTime = 0;

  for (const [field, wire, value] of eachField(buf)) {
    if (field === 1 && wire === 2) {
      for (const [f2, w2, v2] of eachField(value)) {
        if (f2 === 2 && w2 === 0) msgId = Number(v2);
        // Kept as the exact decimal string — see readVarint.
        else if (f2 === 3 && w2 === 0) roomId = v2.toString();
        else if (f2 === 4 && w2 === 0) createTime = Number(v2);
      }
    } else if (field === 2 && wire === 2) {
      for (const [f2, w2, v2] of eachField(value)) {
        if (f2 === 3 && w2 === 2) nickname = str(v2);
        else if (f2 === 38 && w2 === 2) displayId = str(v2);
      }
    } else if (field === 3 && wire === 2) {
      content = str(value);
    }
  }

  if (!content) return null;
  return { content, nickname, displayId, msgId, roomId, createTime };
}

// ------------------------------------------------------------------ public --

/**
 * Turns one WebSocket binary frame into chat messages.
 *
 * Frame shape: WebcastPushFrame{payloadType, payloadEncoding, payload}. Only
 * `msg` carries events — `hb` (heartbeat), `ack` and `im_enter_room_resp` are
 * transport and are dropped. With `payloadEncoding === 'pb'` the payload is
 * gzip-compressed (gzip magic 1f 8b), which is what the web client negotiates.
 */
function decodeFrame(buf) {
  if (!buf || buf.length < 2) return [];
  let frame;
  try {
    frame = decodePushFrame(buf);
  } catch (_) {
    return [];
  }
  if (frame.type !== 'msg' || !frame.payload || !frame.payload.length) return [];

  let body = frame.payload;
  if (body[0] === 0x1f && body[1] === 0x8b && body[2] === 0x08) {
    try {
      body = zlib.gunzipSync(body);
    } catch (_) {
      return [];
    }
  }

  let messages;
  try {
    messages = decodeFetchResult(body);
  } catch (_) {
    return [];
  }

  const out = [];
  for (const m of messages) {
    if (m.method !== CHAT_METHOD) continue;
    let chat;
    try {
      chat = decodeChatMessage(m.payload);
    } catch (_) {
      continue;
    }
    if (!chat) continue;
    out.push({
      roomId: chat.roomId,
      msgId: chat.msgId,
      // createTime is ms; fall back to now so a message is never logged with 0.
      t: chat.createTime || Date.now(),
      displayId: chat.displayId,
      nickname: chat.nickname,
      content: chat.content,
    });
  }
  return out;
}

// --------------------------------------------------------------- recording --

function srtTime(ms) {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

// A message's subtitle cannot end until the next one begins — several people
// often speak at once and zero-length subtitles are rejected by every player.
function srtLine(index, fromMs, toMs, name, text) {
  const who = name ? `${name}: ` : '';
  return `${index}\n${srtTime(fromMs)} --> ${srtTime(toMs)}\n${who}${text}\n\n`;
}

/**
 * Per-recording chat sink. Writes two files next to the video:
 *   <name>.chat.jsonl — full fidelity, one JSON object per message
 *   <name>.chat.srt   — a subtitle track a player can switch on, so the chat can
 *                       be watched over the recording without any extra tooling
 *
 * Writes are synchronous on purpose. The alternative, fs.createWriteStream,
 * buffers: `close()` returns before anything reaches the disk, so a caller that
 * immediately stats or reads the file races the flush — and the recording's own
 * "done" toast fires exactly there. Chat volume is tens of lines per second of
 * a few hundred bytes, which is nothing for fs.writeSync on a log file.
 */
class ChatSink {
  // `startedAt` is when the RECORDING began (ms epoch). It anchors the SRT
  // timeline; omit it and the timeline falls back to the first message.
  constructor({ dir, baseName, roomId, handle }, startedAt = 0) {
    this.roomId = String(roomId || '');
    this.handle = handle || '';
    this.startedAt = Number(startedAt) || 0;
    this.count = 0;
    this.closed = false;
    this.pending = null; // subtitle waiting for its end timestamp
    this.index = 0;
    this.firstAt = 0;
    this.lastAt = 0;

    this.jsonlPath = path.join(dir, `${baseName}.chat.jsonl`);
    this.srtPath = path.join(dir, `${baseName}.chat.srt`);
    // If the second openSync throws, the first descriptor leaks — there is no
    // owner to close it yet at this point in the constructor.
    this.jsonlFd = fs.openSync(this.jsonlPath, 'a');
    try {
      this.srtFd = fs.openSync(this.srtPath, 'a');
    } catch (err) {
      try { fs.closeSync(this.jsonlFd); } catch {}
      throw err;
    }
  }

  _closePending(atMs) {
    if (!this.pending) return;
    const end = Math.max(atMs, this.pending.from + 1200);
    fs.writeSync(
      this.srtFd,
      srtLine(this.pending.index, this.pending.from, end, this.pending.name, this.pending.text)
    );
    this.pending = null;
  }

  write(messages) {
    if (this.closed || !messages || !messages.length) return;
    for (const m of messages) {
      // The frame is shared by every open tab; only keep this room's. The
      // comparison has to be as tolerant as findSink()'s — a strict string
      // compare here silently rejected every message whenever the room id came
      // from a JSON number and was therefore rounded.
      if (m.roomId && this.roomId && !sameRoom(m.roomId, this.roomId)) continue;
      if (!m.content) continue;

      if (!this.firstAt) this.firstAt = m.t;
      this.lastAt = m.t;
      this.count += 1;

      fs.writeSync(
        this.jsonlFd,
        `${JSON.stringify({
          t: new Date(m.t).toISOString(),
          ts: m.t,
          msgId: m.msgId || 0,
          displayId: m.displayId || '',
          nickname: m.nickname || '',
          content: m.content,
        })}\n`
      );

      this._closePending(m.t);
      this.index += 1;
      this.pending = {
        index: this.index,
        // Subtitles are timed from when the RECORDING started, not from the
        // first message: the browser may have been sitting in the room for two
        // minutes before the user pressed «Записать», and timing from the first
        // message would shift every cue that far ahead of the video.
        from: Math.max(0, m.t - (this.startedAt || this.firstAt)),
        name: m.nickname || m.displayId || '',
        // Newlines break the SRT cue block; collapse them. Array.from() first:
        // a plain slice(0,500) cuts UTF-16 surrogate pairs in half and emits a
        // lone surrogate that players render as a replacement character.
        text: Array.from(m.content.replace(/\s*\n\s*/g, ' ')).slice(0, 500).join(''),
      };
    }
  }

  close() {
    if (this.closed) {
      return { count: this.count, jsonlPath: this.jsonlPath, srtPath: this.srtPath };
    }
    this.closed = true;
    const base = this.startedAt || this.firstAt || Date.now();
    const dur = Math.max(0, (this.lastAt || Date.now()) - base);
    this._closePending(base + dur);
    for (const fd of [this.jsonlFd, this.srtFd]) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    return { count: this.count, jsonlPath: this.jsonlPath, srtPath: this.srtPath };
  }
}

// One module-level registry: the main process routes decoded frames here.
const sinks = new Map();

/**
 * Room ids are 19-digit values, so how they were obtained decides whether they
 * round-trip exactly. A roomId parsed from JSON as a string is exact; one that
 * arrived as a JS number is already rounded, and the exact decimal from the wire
 * no longer matches it as a string. Comparing as Numbers bridges both: an exact
 * BigInt and an already-rounded double convert to the same double.
 */
function sameRoom(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

function findSink(roomId) {
  const direct = sinks.get(String(roomId));
  if (direct) return direct;
  for (const sink of sinks.values()) if (sameRoom(sink.roomId, String(roomId))) return sink;
  return null;
}

function open(room, startedAt = 0) {
  // Only a sink for the SAME room is replaced. closeAll() here used to mean a
  // second parallel recording with chat silently killed the first one's sink:
  // its tail was lost and its finishChat() then got null.
  const key = String(room.roomId || '');
  const previous = findSink(key);
  if (previous) close(previous.roomId);
  const sink = new ChatSink(room, startedAt);
  sinks.set(sink.roomId, sink);
  return sink;
}

function route(messages) {
  // Grouped per sink: writing one message at a time cost 2-3 sync writeSync
  // calls per line, which in a busy room is hundreds of syscalls a second on
  // the main thread.
  const buckets = new Map();
  for (const m of messages) {
    if (!m.roomId) continue;
    const sink = findSink(m.roomId);
    if (!sink) continue;
    const list = buckets.get(sink);
    if (list) list.push(m);
    else buckets.set(sink, [m]);
  }
  for (const [sink, list] of buckets) sink.write(list);
}

function close(roomId) {
  const sink = sinks.get(String(roomId));
  if (!sink) return null;
  sinks.delete(String(roomId));
  return sink.close();
}

function closeAll() {
  const out = [];
  for (const key of Array.from(sinks.keys())) {
    const res = close(key);
    if (res) out.push(res);
  }
  return out;
}

function status() {
  return Array.from(sinks.values()).map((s) => ({
    roomId: s.roomId,
    handle: s.handle,
    count: s.count,
    jsonlPath: s.jsonlPath,
    srtPath: s.srtPath,
  }));
}

module.exports = {
  CHAT_METHOD,
  decodeFrame,
  eachField,
  decodeChatMessage,
  sameRoom,
  srtTime,
  ChatSink,
  open,
  route,
  close,
  closeAll,
  status,
};