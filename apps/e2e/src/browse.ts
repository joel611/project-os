const store = (cookies: Map<string, string>, setCookies: ReadonlyArray<string>) => {
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
};

/**
 * Plays the person's browser through the OAuth redirects, keeping cookies per host. `seed` is
 * cookies a page on another origin already set, as when a flow starts with a POST.
 */
export const browse = async (
  start: string,
  seed?: { url: string; setCookies: ReadonlyArray<string> },
) => {
  const jar = new Map<string, Map<string, string>>();
  if (seed) {
    const cookies = new Map<string, string>();
    store(cookies, seed.setCookies);
    jar.set(new URL(seed.url).host, cookies);
  }
  let url = start;
  for (let hop = 0; hop < 10; hop++) {
    const host = new URL(url).host;
    const cookies = jar.get(host) ?? new Map<string, string>();
    const res = await fetch(url, {
      redirect: "manual",
      headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    store(cookies, res.headers.getSetCookie());
    jar.set(host, cookies);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) {
      return { url, status: res.status, body: await res.text() };
    }
    url = new URL(location, url).toString();
  }
  throw new Error("too many redirects");
};
