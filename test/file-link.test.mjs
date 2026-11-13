import assert from 'node:assert/strict'
import { parseFileLink, parseFileLinkLoose } from '../src/file-link.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`✔ ${name}`)
    passed += 1
  } catch (error) {
    console.error(`✘ ${name}`)
    throw error
  }
}

test('a.ts:10 → 路径 + 第 10 行', () => {
  assert.deepEqual(parseFileLink('a.ts:10'), { path: 'a.ts', line: 10, column: 1 })
})

test('a.ts:10:4 → 路径 + 行 + 列', () => {
  assert.deepEqual(parseFileLink('a.ts:10:4'), { path: 'a.ts', line: 10, column: 4 })
})

test('./a.ts#L10 → 去掉 ./，第 10 行', () => {
  assert.deepEqual(parseFileLink('./a.ts#L10'), { path: 'a.ts', line: 10, column: 1 })
})

test('a.ts#L10-L20 → 行区间', () => {
  assert.deepEqual(parseFileLink('a.ts#L10-L20'), { path: 'a.ts', line: 10, column: 1, endLine: 20 })
})

test('嵌套路径与反斜杠', () => {
  assert.deepEqual(parseFileLink('docs/research/x.md:3'), { path: 'docs/research/x.md', line: 3, column: 1 })
  assert.deepEqual(parseFileLink('docs\\research\\x.md:3'), { path: 'docs/research/x.md', line: 3, column: 1 })
})

test('纯路径默认第 1 行', () => {
  assert.deepEqual(parseFileLink('packages/a/README.md'), { path: 'packages/a/README.md', line: 1, column: 1 })
})

test('URL、绝对路径、越界路径不接', () => {
  assert.equal(parseFileLink('https://example.com/a.ts:10'), null)
  assert.equal(parseFileLink('E:/w/a.ts:10'), null)
  assert.equal(parseFileLink('../outside.ts:1'), null)
  assert.equal(parseFileLink('/etc/passwd:1'), null)
})

test('链接文字两侧的标点会被清掉', () => {
  assert.deepEqual(parseFileLink('（a.ts:7）'), { path: 'a.ts', line: 7, column: 1 })
  assert.deepEqual(parseFileLink('"docs/a.md#L2"'), { path: 'docs/a.md', line: 2, column: 1 })
})

test('parseFileLinkLoose：卡片文字带图标/附件前缀也能认出文件名', () => {
  assert.deepEqual(parseFileLinkLoose('📎 DSH-Desktop-启动故障检查报告-2026-11-07.md'), {
    path: 'DSH-Desktop-启动故障检查报告-2026-11-07.md',
    line: 1,
    column: 1,
  })
  assert.deepEqual(parseFileLinkLoose('附件：docs/research/x.md:3'), {
    path: 'docs/research/x.md',
    line: 3,
    column: 1,
  })
})

test('parseFileLinkLoose：URL 与普通文字不误伤', () => {
  assert.equal(parseFileLinkLoose('https://example.com/a.ts'), null)
  assert.equal(parseFileLinkLoose('这里没有文件'), null)
  assert.equal(parseFileLinkLoose('版本 2026-11-07'), null)
})

console.log(`\n${passed} 组文件链接测试全绿`)
