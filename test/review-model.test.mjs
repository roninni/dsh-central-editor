import assert from 'node:assert/strict'
import { hunkFromPatchLines, hunkFromText, countHunkLines, normalizeWorkspacePath } from '../dsh/review-model.js'

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

test('countHunkLines：连续替换只数中间段', () => {
  assert.deepEqual(countHunkLines('a\nb\nc\n', 'a\nx\ny\nc\n'), { added: 2, deleted: 1 })
})

test('countHunkLines：纯插入', () => {
  assert.deepEqual(countHunkLines('a\nc\n', 'a\nb\nc\n'), { added: 1, deleted: 0 })
})

test('countHunkLines：纯删除', () => {
  assert.deepEqual(countHunkLines('a\nb\nc\n', 'a\nc\n'), { added: 0, deleted: 1 })
})

test('countHunkLines：相同文本为零', () => {
  assert.deepEqual(countHunkLines('a\nb\n', 'a\nb\n'), { added: 0, deleted: 0 })
})

test('hunkFromText：保留纯插入标记与计数', () => {
  const hunk = hunkFromText({
    oldText: null,
    newText: 'a\nb\nc\n',
    index: 0,
    id: 't\u0000p\u00000',
    turn: 2,
    path: 'p',
  })
  assert.equal(hunk.pureInsertion, true)
  assert.deepEqual({ added: hunk.added, deleted: hunk.deleted }, { added: 3, deleted: 0 })
  assert.equal(hunk.id, 't\u0000p\u00000')
})

test('hunkFromPatchLines：从 unified lines 还原两侧文本', () => {
  const hunk = hunkFromPatchLines(
    {
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 5,
      lines: [' keep', '-old', '+new1', '+new2', ' tail'],
    },
    { index: 0, id: '1\u0000p\u00000', turn: 1, path: 'p' }
  )
  assert.equal(hunk.oldText, 'keep\nold\ntail')
  assert.equal(hunk.newText, 'keep\nnew1\nnew2\ntail')
  assert.deepEqual({ added: hunk.added, deleted: hunk.deleted }, { added: 2, deleted: 1 })
  assert.equal(hunk.header, '@@ -10,4 +10,5 @@')
})

test('normalizeWorkspacePath：工作区内绝对/相对都归一为斜杠', () => {
  const root = process.platform === 'win32' ? 'E:\\w' : '/w'
  const inside = process.platform === 'win32' ? 'E:\\w\\a\\b.ts' : '/w/a/b.ts'
  assert.equal(normalizeWorkspacePath(root, inside), 'a/b.ts')
  assert.equal(normalizeWorkspacePath(root, 'a/b.ts'), 'a/b.ts')
})

test('normalizeWorkspacePath：越界与空值返回 null', () => {
  const root = process.platform === 'win32' ? 'E:\\w' : '/w'
  const outside = process.platform === 'win32' ? 'E:\\wx\\a.ts' : '/wx/a.ts'
  assert.equal(normalizeWorkspacePath(root, outside), null)
  assert.equal(normalizeWorkspacePath(root, ''), null)
  assert.equal(normalizeWorkspacePath(root, null), null)
})

console.log(`\n${passed} 组审阅模型测试全绿`)
