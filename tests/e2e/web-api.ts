import assert from 'node:assert/strict';

export async function webAPI(pairURL: string) {
  const url = new URL(pairURL);
  const origin = url.origin;
  const ticket = new URLSearchParams(url.hash.slice(1)).get('pair');
  const response = await fetch(`${origin}/api/pair`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const { csrf } = await response.json();
  return {
    origin,
    get: (path: string, signal?: AbortSignal) => fetch(origin + path, { headers: { cookie, 'x-oep-csrf': csrf }, signal }),
    post: (path: string, data: object, signal?: AbortSignal) => fetch(origin + path, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-oep-csrf': csrf },
      body: JSON.stringify(data), signal,
    }),
    upload: (path: string, name: string, data: string) => fetch(origin + path, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'text/plain', 'x-oep-csrf': csrf,
        'x-oep-filename': encodeURIComponent(name) }, body: data,
    }),
  };
}
