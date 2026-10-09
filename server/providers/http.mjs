/**
 * 统一的出网口：配了代理就走代理，没配就直接 fetch。
 *
 * 提供方适配器、模型列表、连通性测试都从这里出网，所以"要不要走代理"
 * 只需要在一个地方设置。
 */

import { createProxyFetch } from './proxy.mjs';

let currentProxy = null;
let proxiedFetch = null;
let lastError = null;

/** 设置代理（传空字符串 = 关闭）。地址不合法时不抛错，只记下来，不影响主服务。 */
export function setProxy(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    currentProxy = null;
    proxiedFetch = null;
    lastError = null;
    return { enabled: false };
  }
  try {
    proxiedFetch = createProxyFetch(raw);
    currentProxy = raw;
    lastError = null;
    return { enabled: true, proxy: raw };
  } catch (err) {
    proxiedFetch = null;
    currentProxy = null;
    lastError = err?.message ?? String(err);
    return { enabled: false, error: lastError };
  }
}

export function getProxy() {
  return currentProxy;
}

export function proxyStatus() {
  return { enabled: Boolean(currentProxy), proxy: currentProxy, error: lastError };
}

/** 出网统一走这里。 */
export function httpFetch(url, init) {
  return proxiedFetch ? proxiedFetch(url, init) : fetch(url, init);
}
