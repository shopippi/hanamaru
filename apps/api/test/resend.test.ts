import { describe, expect, test } from 'vitest';
import { ResendEmailTransport } from '../src/integrations/resend.js';

// メール送信（Resend）。本物の API は呼ばず、送る内容と失敗の扱いを確かめる（NT-03、OP-06）

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { f, calls };
}

const mail = { to: 'parent@example.test', subject: '【予約確定】10月22日（木）15:00', text: '山田 はな太郎 様\nご予約を承りました。' };

describe('NT-03 Resend でメールを送る', () => {
  test('NT-03 送信元・宛先・件名・本文・返信先を、Resend の API の形で送る', async () => {
    const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }));
    const t = new ResendEmailTransport({ apiKey: 're_test_key', from: 'はなまる音楽教室 <no-reply@send.example.test>', replyTo: 'info@example.test', fetch: f });
    await t.send(mail);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: 'はなまる音楽教室 <no-reply@send.example.test>',
      to: ['parent@example.test'],
      subject: mail.subject,
      text: mail.text,
      reply_to: 'info@example.test',
    });
  });

  test('OP-06 Resend が断ったときは、理由を日本語で残して失敗にする（API キーは文言に出さない）', async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ message: 'The domain is not verified.' }), { status: 403 }));
    const t = new ResendEmailTransport({ apiKey: 're_secret_value', from: 'no-reply@send.example.test', fetch: f });
    const err = await t.send(mail).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('メール送信サービスが受け付けませんでした（403: The domain is not verified.）');
    expect((err as Error).message).not.toContain('re_secret_value');
  });

  test('OP-06 つながらない・時間切れのときも失敗にする（あとで自動で送り直す）', async () => {
    const { f } = fakeFetch(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const t = new ResendEmailTransport({ apiKey: 're_test_key', from: 'no-reply@send.example.test', fetch: f });
    await expect(t.send(mail)).rejects.toThrow('メール送信サービスにつながりませんでした（TimeoutError）');
  });

  test('NT-03 返信先がなければ reply_to を送らない', async () => {
    const { f, calls } = fakeFetch(() => new Response('{}', { status: 200 }));
    await new ResendEmailTransport({ apiKey: 'k', from: 'no-reply@send.example.test', fetch: f }).send(mail);
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty('reply_to');
  });
});
