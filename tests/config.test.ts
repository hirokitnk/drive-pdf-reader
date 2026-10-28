import { describe, expect, it } from 'vitest';
import { bookmarklet, fileIdFromLocation, parseFileId } from '../src/config';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123';

describe('parseFileId', () => {
  it('共有リンク・プレビューURL・open?id= から取り出す', () => {
    expect(parseFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`)).toBe(ID);
    expect(parseFileId(`https://drive.google.com/file/d/${ID}/preview`)).toBe(ID);
    expect(parseFileId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
    expect(parseFileId(`https://drive.google.com/uc?export=download&id=${ID}`)).toBe(ID);
  });
  it('IDそのままも受け付ける', () => {
    expect(parseFileId(` ${ID} `)).toBe(ID);
  });
  it('フォルダのURLや無関係な文字列は null', () => {
    expect(parseFileId(`https://drive.google.com/drive/folders/${ID}`)).toBeNull();
    expect(parseFileId('hello')).toBeNull();
    expect(parseFileId('')).toBeNull();
  });
});

describe('fileIdFromLocation', () => {
  it('?fileId= を読む', () => {
    expect(fileIdFromLocation(`?fileId=${ID}`)).toBe(ID);
    expect(fileIdFromLocation('?x=1')).toBeNull();
    expect(fileIdFromLocation('?fileId=a b')).toBeNull();
  });
});

describe('bookmarklet', () => {
  it('javascript: で始まり、アプリURLを含む', () => {
    const b = bookmarklet('https://example.github.io/drive-pdf-reader/');
    expect(b.startsWith('javascript:')).toBe(true);
    expect(decodeURIComponent(b)).toContain('https://example.github.io/drive-pdf-reader/');
  });
  it('Drive のURLでIDを取り出して開く（実際に実行して確認）', () => {
    const code = decodeURIComponent(bookmarklet('https://app.test/').slice('javascript:'.length));
    const opened: string[] = [];
    const fn = new Function('location', 'window', 'alert', code);
    fn({ href: `https://drive.google.com/file/d/${ID}/view` }, { open: (u: string) => opened.push(u) }, () => {});
    expect(opened).toEqual([`https://app.test/?fileId=${ID}`]);
  });
});
