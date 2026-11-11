import type { DownloadPayload } from '@infra/download';

const extensions: Readonly<Record<string, string>> = {
  markdown: 'md', md: 'md', python: 'py', py: 'py', javascript: 'js', js: 'js',
  jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', rust: 'rs', go: 'go',
  java: 'java', ruby: 'rb', rb: 'rb', php: 'php', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'cs', cs: 'cs', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yml', bash: 'sh', sh: 'sh', shell: 'sh',
  sql: 'sql', kotlin: 'kt', swift: 'swift', diff: 'diff', patch: 'patch',
};

export function codeBlockDownloadPayload(code: string, language?: string, filename?: string): DownloadPayload {
  const basename = filename?.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  const extension = language && Object.prototype.hasOwnProperty.call(extensions, language.toLowerCase()) ? extensions[language.toLowerCase()] : 'txt';
  return { content: code, filename: basename || `code.${extension}`, mimeType: 'text/plain;charset=utf-8' };
}
