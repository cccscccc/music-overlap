/**
 * 基础 HTTP 与公共工具
 * 零第三方依赖，只用 Node 内置模块。
 *
 * 这里是三个平台适配器（platforms/*.mjs）共用的底座：
 *   - 可选的 HTTP 代理（--proxy= 或 MUSIC_PROXY），走 CONNECT 隧道
 *   - GET 文本（带超时 + 重试）、GET JSON
 *   - 音频流转发（透传 Range / 206，进度条才能拖）
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** 进程启动参数里的代理设置：--proxy=127.0.0.1:7890 或环境变量 MUSIC_PROXY */
export function resolveProxy(argv = process.argv.slice(2)) {
  return (
    argv.find((a) => a.startsWith('--proxy='))?.slice('--proxy='.length) ||
    process.env.MUSIC_PROXY ||
    ''
  );
}

/** 代理地址在 server.mjs 启动时写进来，各适配器通过 getProxy() 读 */
let PROXY = resolveProxy();
export function setProxy(v) {
  PROXY = String(v || '');
}
export function getProxy() {
  return PROXY;
}

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 带状态码的接口错误，server.mjs 直接拿 status 回给前端 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 通过 HTTP 代理建立到目标主机的 CONNECT 隧道 */
function proxyTunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(/^https?:\/\//.test(proxy) ? proxy : `http://${proxy}`);
    let settled = false;
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
    const no = (e) => { if (!settled) { settled = true; reject(e); } };
    const req = http.request({
      host: p.hostname,
      port: p.port || 8080,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, 'Proxy-Connection': 'keep-alive' },
    });
    req.setTimeout(timeout, () => req.destroy(new Error('代理连接超时')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        no(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      // 隧道建好之后这条 socket 就归调用方了，它上面必须一直挂着 error 处理器：
      // 否则远端 RST 或调用方 destroy 时会抛成未捕获异常，把整个服务带走。
      socket.on('error', no);
      ok(socket);
    });
    req.on('error', no);
    req.end();
  });
}

/**
 * 只认第一次结果。
 * 网络里「已经失败/已经结束」之后还会再来一发 error 或 end 是常态，
 * 不加这层就会出现「请求明明成功了，服务却因为后来的 ECONNRESET 整个退出」。
 */
function settleOnce(resolve, reject) {
  let done = false;
  return {
    ok(v) { if (!done) { done = true; resolve(v); } },
    no(e) { if (!done) { done = true; reject(e); } },
  };
}

/**
 * GET 一段文本，带超时和重试；没设代理时直连。
 * body 不为空时改用 POST。
 *
 * 重试的规矩（原来是「什么都重试两次、还不退避」）：
 *   - 网络错误、超时 → 重试（这类失败下一次很可能就好了）
 *   - 5xx、429       → 重试（暂时性的）
 *   - 其它 4xx       → **不重试**。404 就是没有，403 就是不让，再打两遍只是白费
 *                     请求、还更容易把对面惹毛（风控）
 *   - 3xx            → 明确报错，不再当成成功。以前不跟随重定向，又把它当 200，
 *                      于是下游收到一段空 body，报成「非 JSON，可能被风控」——
 *                      这句提示会把人往完全错误的方向带。
 * 重试之间退避 400ms、800ms，别连着捶。
 */
export function getText(url, extraHeaders = {}, { timeout = 25000, retries = 2, body = null } = {}) {
  const isRetryable = (err) => {
    const s = Number(err?.status) || 0;
    if (!s) return true; // 网络错误 / 超时：没有 status
    return s === 429 || s >= 500;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const attempt = (left) =>
    new Promise((resolve, reject) => {
      const { ok, no } = settleOnce(resolve, reject);
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const port = Number(u.port) || (isHttps ? 443 : 80);
      const mod = isHttps ? https : http;
      const options = {
        method: body == null ? 'GET' : 'POST',
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Host: u.hostname,
          ...(body == null ? {} : { 'Content-Length': Buffer.byteLength(body) }),
          ...extraHeaders,
        },
      };

      const fire = (socket) => {
        if (socket) {
          options.agent = false;
          options.createConnection = () => socket;
        }
        const req = mod.request(options, (res) => {
          const chunks = [];
          // 同样必须挂：连接中途被 RST 时，错误是从 res 上发出来的
          res.on('error', no);
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode >= 300 && res.statusCode < 400) {
              const err = new Error(
                `对方要求跳转到别处（HTTP ${res.statusCode} → ${res.headers?.location || '未给地址'}）` +
                  `，这个接口不该这样，多半是接口改了或被拦了`
              );
              err.status = res.statusCode;
              no(err);
              return;
            }
            if (res.statusCode >= 400) {
              const err = new Error(`HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              no(err);
              return;
            }
            ok(Buffer.concat(chunks).toString('utf8'));
          });
        });
        req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
        req.on('error', no);
        req.end(body || undefined);
      };

      if (!PROXY) {
        fire(null);
        return;
      }
      proxyTunnel(PROXY, u.hostname, port, timeout)
        .then((socket) => {
          socket.on('error', no);
          if (!isHttps) {
            fire(socket);
            return;
          }
          // CONNECT 隧道之上再套一层 TLS
          const secure = tls.connect({ socket, servername: u.hostname }, () => fire(secure));
          secure.on('error', no);
        })
        .catch(no);
    }).catch(async (err) => {
      if (left > 0 && isRetryable(err)) {
        await sleep(400 * (retries - left + 1)); // 400ms、800ms…别连着捶
        return attempt(left - 1);
      }
      throw err;
    });

  return attempt(retries);
}

/**
 * 下载二进制 —— 目前只有「更新包」用得上。
 *
 * 跟 getText 的差别只有两点，但两点都省不掉：
 *   1) 不拼字符串，直接攒成 Buffer（35MB 的 zip 转成 utf8 会烂掉）
 *   2) **跟着 30x 跳转走**：GitHub 的 release 附件地址（browser_download_url）
 *      是先 302 到 objects.githubusercontent.com 才给真东西，不跟就只能拿到空壳
 * 代理仍走同一套 PROXY。
 */
export function getBuffer(url, extraHeaders = {}, { timeout = 180000, retries = 1, redirects = 4 } = {}) {
  const attempt = (left, target, hops) =>
    new Promise((resolve, reject) => {
      const { ok, no } = settleOnce(resolve, reject);
      const u = new URL(target);
      const isHttps = u.protocol === 'https:';
      const port = Number(u.port) || (isHttps ? 443 : 80);
      const mod = isHttps ? https : http;
      const options = {
        method: 'GET',
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        headers: { 'User-Agent': UA, Accept: '*/*', Host: u.hostname, ...extraHeaders },
      };

      const fire = (socket) => {
        if (socket) {
          options.agent = false;
          options.createConnection = () => socket;
        }
        const req = mod.request(options, (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers?.location) {
            res.resume();
            if (hops <= 0) {
              no(new Error('跳转太多次了，可能是被中间人拦了'));
              return;
            }
            ok(attempt(left, new URL(res.headers.location, target).toString(), hops - 1));
            return;
          }
          if (code !== 200) {
            res.resume();
            const err = new Error(`下载失败（HTTP ${code}）`);
            err.status = code;
            no(err);
            return;
          }
          const chunks = [];
          res.on('error', no);
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => ok(Buffer.concat(chunks)));
        });
        req.setTimeout(timeout, () => req.destroy(new Error('下载超时')));
        req.on('error', no);
        req.end();
      };

      if (!PROXY) {
        fire(null);
        return;
      }
      proxyTunnel(PROXY, u.hostname, port, timeout)
        .then((socket) => {
          socket.on('error', no);
          if (!isHttps) {
            fire(socket);
            return;
          }
          const secure = tls.connect({ socket, servername: u.hostname }, () => fire(secure));
          secure.on('error', no);
        })
        .catch(no);
    }).catch(async (err) => {
      const s = Number(err?.status) || 0;
      if (left > 0 && (!s || s === 429 || s >= 500)) {
        await new Promise((r) => setTimeout(r, 500 * (retries - left + 1)));
        return attempt(left - 1, url, redirects);
      }
      throw err;
    });

  return attempt(retries, url, redirects);
}

export async function getJson(url, headers, opts) {
  const text = await getText(url, headers, opts);
  return parseJson(text);
}

/** 有些接口（老版）返回的 content-type 是 js，这里统一兜一层 */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/^[^({]*\((.*)\)[;\s]*$/s);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* 落到下面 */
      }
    }
    throw new Error('对方返回了非 JSON 内容（可能被风控拦截，请稍后重试）');
  }
}

/** 把一批任务按并发上限跑完（保持原有顺序） */
export async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return out;
}

/**
 * 音频流转发：代浏览器去取音频再原样转发。
 * 透传 Range / 206，前端的进度条才能拖动。
 */
export function streamAudio(req, res, targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const { ok, no } = settleOnce(resolve, reject);
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const headers = {
      'User-Agent': UA,
      Accept: '*/*',
      Host: u.hostname,
      ...extraHeaders,
    };
    if (req.headers.range) headers.Range = req.headers.range;

    let upReq = null;
    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
      if (upReq) upReq.destroy();
    });

    const fire = (socket) => {
      const options = { method: 'GET', host: u.hostname, port, path: u.pathname + u.search, headers };
      if (socket) {
        options.agent = false;
        options.createConnection = () => socket;
      }
      upReq = mod.request(options, (upRes) => {
        if (clientGone) {
          upRes.destroy();
          ok();
          return;
        }
        // 逐跳头与长度相关头不能透传，否则浏览器会以为流断了
        const out = { ...upRes.headers };
        delete out['transfer-encoding'];
        delete out.connection;
        delete out['content-encoding'];
        delete out['content-length'];
        res.writeHead(upRes.statusCode || 200, out);
        // 用户拖进度条 / 关页面时我们会 destroy 上游请求，上游随之发出 ECONNRESET。
        // 这条错误必须有人接住——不接就是「服务端进程直接退出」。
        // 音频是流式的，已经写出去的就发出去了，改不了什么，所以这里吞掉，
        // 但不中断其它请求：客户端断开本来就会走到这里。
        upRes.on('error', no);
        res.on('error', no);
        upRes.pipe(res);
        upRes.on('end', ok);
      });
      upReq.setTimeout(30000, () => upReq.destroy(new Error('音频读取超时')));
      upReq.on('error', no);
      upReq.end();
    };

    if (!PROXY) {
      fire(null);
      return;
    }
    proxyTunnel(PROXY, u.hostname, port, 20000)
      .then((socket) => {
        socket.on('error', no);
        if (!isHttps) {
          fire(socket);
          return;
        }
        const secure = tls.connect({ socket, servername: u.hostname }, () => fire(secure));
        secure.on('error', no);
      })
      .catch(no);
  });
}
