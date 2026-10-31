import { z } from 'zod';

// 入力の誤りの文言を、画面にそのまま出せる日本語にする（UI-16）。
// よくある誤りは自然な文にし、それ以外は zod の日本語の文言を使う。項目ごとの文言を指定したものは、そちらが優先される
type Issue = { code?: string; input?: unknown; origin?: string; maximum?: unknown; minimum?: unknown; format?: string; expected?: string };

function message(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === null || issue.input === '' ? '入力してください' : '入力の形が正しくありません';
    case 'too_big':
      if (issue.origin === 'string') return `${String(issue.maximum)}文字以内で入力してください`;
      if (issue.origin === 'array') return `${String(issue.maximum)}件までにしてください`;
      return `${String(issue.maximum)}以下にしてください`;
    case 'too_small':
      if (issue.origin === 'string') return Number(issue.minimum) <= 1 ? '入力してください' : `${String(issue.minimum)}文字以上で入力してください`;
      if (issue.origin === 'array') return Number(issue.minimum) <= 1 ? '1つ以上選んでください' : `${String(issue.minimum)}件以上選んでください`;
      return `${String(issue.minimum)}以上にしてください`;
    case 'invalid_format':
      if (issue.format === 'email') return 'メールアドレスの形式が正しくありません';
      if (issue.format === 'regex') return '形式が正しくありません';
      return '形式が正しくありません';
    case 'invalid_value':
      return '選べる値から選んでください';
    case 'unrecognized_keys':
      return undefined;
    default:
      return undefined;
  }
}

z.config({ ...z.locales.ja(), customError: (issue) => message(issue as Issue) });
