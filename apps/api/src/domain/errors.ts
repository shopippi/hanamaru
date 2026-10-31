// 入力の誤りの文言を日本語にする（すべての入力の検証より先に読み込まれる）
import '../lib/zod-ja.js';
/** 画面にそのまま出せる日本語の理由を持つ業務エラー */
export class DomainError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'rule' | 'conflict' | 'validation' | 'unauthorized',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const forbidden = (message = 'この操作はできません') => new DomainError('forbidden', message);
export const notFound = (message = '見つかりませんでした') => new DomainError('not_found', message);
export const ruleViolation = (message: string, details?: unknown) => new DomainError('rule', message, details);
export const conflict = (message: string, details?: unknown) => new DomainError('conflict', message, details);
export const invalid = (message: string, details?: unknown) => new DomainError('validation', message, details);
