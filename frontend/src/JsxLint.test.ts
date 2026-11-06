import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();
const ruleId = 'project/one-jsx-tag-per-line';

async function tagFindings(jsx: string) {
  const [result] = await eslint.lintText(`export default ${jsx};`, { filePath: 'src/JsxLintFixture.tsx' });
  expect(result.fatalErrorCount).toBe(0);
  return result.messages.filter(message => message.ruleId === ruleId);
}

describe('one JSX tag per line', () => {
  it.each([
    '<div><span>Label</span></div>',
    '<><Title /><Status /></>',
    '<div>{ready && <Status />}</div>',
    '<div>\n  {ready ? <Title /> : <Status />}\n</div>',
    '<Card icon={<Icon />} />',
    '<div>\n  <span />\n  <p>Text</p></div>',
  ])('reports shared lines in %s', async jsx => {
    expect(await tagFindings(jsx)).toContainEqual(expect.objectContaining({ severity: 2 }));
  });

  it.each([
    '<span>Label</span>',
    '<span>{t(MSG.CLOSE)}</span>',
    '<div>\n  {ready && <Status />}\n</div>',
    '<Card\n  icon={<Icon />}\n/>',
  ])('allows %s', async jsx => {
    expect(await tagFindings(jsx)).toEqual([]);
  });
});
