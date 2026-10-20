// フォームのボット対策（NF-06）。本番は Cloudflare Turnstile で確かめる

export interface CaptchaVerifier {
  verify(token: string | undefined, ip: string | undefined): Promise<boolean>;
}

export class TurnstileVerifier implements CaptchaVerifier {
  constructor(private readonly secret: string) {}

  async verify(token: string | undefined, ip: string | undefined): Promise<boolean> {
    if (!token) return false;
    const form = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  }
}

/** 開発・テスト用 */
export class StaticCaptcha implements CaptchaVerifier {
  constructor(private readonly result: boolean) {}
  async verify(): Promise<boolean> {
    return this.result;
  }
}
