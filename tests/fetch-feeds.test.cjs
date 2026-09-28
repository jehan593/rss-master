const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');
const vm = require('node:vm');

const source = stripTypeScriptTypes(readFileSync(require.resolve('../supabase/functions/fetch-feeds/index.ts'), 'utf8')
  .replace(/^import .*;\r?\n/gm, ''));

async function fetchFeed({ status = 200, entries = [{ id: 'entry', link: 'https://example.com/entry' }],
  checked = null, parseError = false, networkError = false, rpcError = false } = {}) {
  const calls = [];
  let request;
  const client = {
    from(table) {
      const query = {
        select() { return this; }, eq() { return this; }, in() { return this; }, neq() { return this; },
        update(value) { calls.push({ table, value }); return this; },
        upsert(value) { calls.push({ table, value }); return this; },
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return { error: rpcError ? { message: 'offline' } : null };
    },
  };
  const context = vm.createContext({
    createClient: () => client,
    extractFromXml: async () => { if (parseError) throw Error('bad XML'); return { entries }; },
    Deno: { env: { get: () => 'test' }, serve() {} },
    fetch: async (url, options) => {
      request = options;
      if (networkError) throw Error('offline');
      return { status, ok: status === 200, text: async () => '<rss/>', headers: { get: () => 'validator' } };
    },
    console, URL, AbortSignal,
  });
  vm.runInContext(source, context);
  context.feed = { id: 'feed', url: 'https://example.com/rss', etag: 'old', last_modified: 'old',
    error_count: 0, presence_checked_at: checked };
  const result = await vm.runInContext('fetchOneFeed(feed)', context);
  return { result, calls, request, snapshots: calls.filter(c => c.name === 'record_feed_presence') };
}

test('tracks every source entry even beyond the 200 stored articles', async () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ id: `guid-${i}`, link: `https://example.com/${i}` }));
  const { snapshots, calls, request } = await fetchFeed({ entries });
  assert.equal(snapshots[0].args.identities.length, 250);
  assert.equal(calls.find(c => c.table === 'articles' && Array.isArray(c.value)).value.length, 200);
  assert.equal(request.headers['If-None-Match'], undefined);
});

test('recent snapshots allow conditional requests; 304 never implies absence', async () => {
  const { snapshots, request } = await fetchFeed({ status: 304, checked: new Date().toISOString() });
  assert.equal(request.headers['If-None-Match'], 'old');
  assert.equal(snapshots.length, 0);
});

test('a stale snapshot forces a full fetch', async () => {
  const { request } = await fetchFeed({ checked: new Date(Date.now() - 2 * 86400000).toISOString() });
  assert.equal(request.headers['If-None-Match'], undefined);
  assert.equal(request.headers['If-Modified-Since'], undefined);
});

for (const scenario of [{ status: 500 }, { parseError: true }, { networkError: true },
  { entries: [] }, { entries: [{ title: 'missing identity' }] },
  { entries: [{ id: 'valid' }, { title: 'missing identity' }] }]) {
  test(`does not record absence for ${JSON.stringify(scenario)}`, async () => {
    assert.equal((await fetchFeed(scenario)).snapshots.length, 0);
  });
}

test('failed presence recording does not commit conditional-fetch validators', async () => {
  const { result, calls } = await fetchFeed({ rpcError: true });
  assert.equal(result.ok, false);
  assert.equal(calls.some(c => c.table === 'feeds' && c.value.etag), false);
});
