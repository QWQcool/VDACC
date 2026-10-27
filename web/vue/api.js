/* 只做「发请求 + 解析 JSON」，不掺业务和 i18n；失败语义留给 app.js 决定。 */
window.VDACC_API = {
  async request(token, path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'X-VDL-Token': token }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: { message: `HTTP ${res.status}` } };
    }
    return { status: res.status, data };
  },
};
