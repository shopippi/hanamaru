import { eq } from 'drizzle-orm';
import { notifications } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { getSettings, type NotificationType } from './settings.js';

/** 止めるとログインできなくなる通知。設定で「送らない」にしていても送る（NT-02 の例外） */
export const ALWAYS_SENT: readonly NotificationType[] = ['invite', 'password_reset'];

/**
 * 送信記録（notifications）とバックアップに、招待・再設定のリンクを残さない。
 * リンクを知っている人は、そのアカウントのパスワードを設定できてしまうため
 */
export const redactSecrets = (text: string) => text.replace(/([?&]token=)[^\s&]+/g, '$1（記録しません）');

// 通知（3.6）。送信手段（Channel）を差し替えられる作りにする（NT-03）。
// 新しい手段（LINE、ホーム画面アプリのプッシュ通知など）は Channel を1つ実装して channels に足すだけで送れる。

export interface Recipient {
  email: string | null;
  lineUserId?: string | null;
}

export interface Message {
  subject: string;
  body: string;
}

export interface Channel {
  readonly name: string;
  /** この手段での宛先。届け先がなければ null（その手段では送らない） */
  address(recipient: Recipient): string | null;
  deliver(address: string, message: Message): Promise<void>;
}

export interface Notifier {
  send(type: NotificationType, recipient: Recipient, message: Message): Promise<void>;
}

export class NotificationService implements Notifier {
  constructor(
    private readonly db: Db,
    private readonly channels: Channel[],
  ) {}

  async send(type: NotificationType, recipient: Recipient, message: Message): Promise<void> {
    const settings = await getSettings(this.db);
    const enabled = ALWAYS_SENT.includes(type) || settings.notifications[type] !== false; // NT-02
    for (const channel of this.channels) {
      const address = channel.address(recipient);
      if (!address) continue;
      const [row] = await this.db
        .insert(notifications)
        .values({
          channel: channel.name,
          type,
          recipient: address,
          subject: message.subject,
          body: redactSecrets(message.body),
          status: enabled ? 'pending' : 'skipped',
        })
        .returning({ id: notifications.id });
      if (!enabled || !row) continue;
      try {
        await channel.deliver(address, message);
        await this.db.update(notifications).set({ status: 'sent', sentAt: new Date() }).where(eqId(row.id));
      } catch (e) {
        // 通知の失敗で予約や決済の処理を止めない。記録だけ残す
        await this.db
          .update(notifications)
          .set({ status: 'failed', error: e instanceof Error ? e.message : String(e) })
          .where(eqId(row.id));
      }
    }
  }
}

const eqId = (id: string) => eq(notifications.id, id);

// --- メール -----------------------------------------------------------------

export interface EmailTransport {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

export class EmailChannel implements Channel {
  readonly name = 'email';
  constructor(private readonly transport: EmailTransport) {}
  address(recipient: Recipient): string | null {
    return recipient.email;
  }
  async deliver(address: string, message: Message): Promise<void> {
    await this.transport.send({ to: address, subject: message.subject, text: message.body });
  }
}

/** 開発・検証用: 送らずに標準出力へ書く。本番のメール送信サービスは未選定（8.2） */
export class ConsoleEmailTransport implements EmailTransport {
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    console.log(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
  }
}

/** テスト用: 送ったメールを配列に貯める */
export class MemoryEmailTransport implements EmailTransport {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(mail: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(mail);
  }
}
