export class HubClient {
  private readonly hubUrl: string;
  private readonly email: string;
  private readonly password: string;
  private sessionCookie: string | null = null;

  constructor(hubUrl: string, email: string, password: string) {
    this.hubUrl = hubUrl;
    this.email = email;
    this.password = password;
  }

  async authenticate(): Promise<void> {
    const res = await fetch(this.buildUrl('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    if (!res.ok) {
      throw new Error(`Hub authentication failed: ${res.status}`);
    }

    const setCookie = res.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/(?:^|,\s*)(session=[^;]+)/);
    if (!match || !match[1]) {
      throw new Error('Hub authentication failed: no session cookie in response');
    }
    this.sessionCookie = match[1];
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(path, this.hubUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private cookieHeader(): Record<string, string> {
    return this.sessionCookie ? { Cookie: this.sessionCookie } : {};
  }

  async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const res = await fetch(this.buildUrl(path, query), {
      headers: { ...this.cookieHeader() },
    });

    if (res.status === 401) {
      await this.authenticate();
      const retry = await fetch(this.buildUrl(path, query), {
        headers: { ...this.cookieHeader() },
      });
      if (!retry.ok) {
        throw new Error(`Hub GET ${path} failed: ${retry.status}`);
      }
      return retry.json() as Promise<T>;
    }

    if (!res.ok) {
      throw new Error(`Hub GET ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private buildInit(method: string, headers: Record<string, string>, body?: unknown): RequestInit {
    if (body !== undefined) {
      return { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    }
    return { method, headers };
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const init = this.buildInit('POST', this.cookieHeader(), body);
    const res = await fetch(this.buildUrl(path), init);

    if (res.status === 401) {
      await this.authenticate();
      const retry = await fetch(this.buildUrl(path), this.buildInit('POST', this.cookieHeader(), body));
      if (!retry.ok) {
        throw new Error(`Hub POST ${path} failed: ${retry.status}`);
      }
      return retry.json() as Promise<T>;
    }

    if (!res.ok) {
      throw new Error(`Hub POST ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const init = this.buildInit('PATCH', this.cookieHeader(), body);
    const res = await fetch(this.buildUrl(path), init);

    if (res.status === 401) {
      await this.authenticate();
      const retry = await fetch(this.buildUrl(path), this.buildInit('PATCH', this.cookieHeader(), body));
      if (!retry.ok) {
        throw new Error(`Hub PATCH ${path} failed: ${retry.status}`);
      }
      return retry.json() as Promise<T>;
    }

    if (!res.ok) {
      throw new Error(`Hub PATCH ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }
}
