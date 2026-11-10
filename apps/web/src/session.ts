const KEY = "project-os.token";

/**
 * The dashboard's session token, sent to the Coordinator as `Authorization: Bearer`. Kept in
 * localStorage, so a reload stays signed in.
 */
export const session = {
  token: (): string | null => globalThis.localStorage?.getItem(KEY) ?? null,
  save: (token: string): void => localStorage.setItem(KEY, token),
  clear: (): void => localStorage.removeItem(KEY),
};

export const LOGIN_PATH = "/login";

let leaving = false;

/**
 * The Coordinator refused the token: forget it and reload at the login page. The 3 s polling has
 * several queries in flight, so only the first 401 navigates.
 */
export const sessionExpired = (): void => {
  session.clear();
  if (leaving) return;
  leaving = true;
  window.location.assign(LOGIN_PATH);
};
