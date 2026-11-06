/** Plays the person's browser through the OAuth redirects, keeping cookies per host. */
export const browse = async (start: string) => {
  const jar = new Map<string, Map<string, string>>();
  let url = start;
  for (let hop = 0; hop < 10; hop++) {
    const host = new URL(url).host;
    const cookies = jar.get(host) ?? new Map<string, string>();
    const res = await fetch(url, {
      redirect: "manual",
      headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    jar.set(host, cookies);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) {
      return { url, status: res.status, body: await res.text() };
    }
    url = new URL(location, url).toString();
  }
  throw new Error("too many redirects");
};
