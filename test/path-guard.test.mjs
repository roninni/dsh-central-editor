import test from 'node:test'
import assert from 'node:assert/strict'
import { rejectPathShape, isInside, pickRoot } from '../dsh/path-guard.js'

test('拒绝越界、绝对路径与各类 Windows 花招', () => {
  const bad = [
    '',
    '   ',
    '../a.ts',
    'a/../../b.ts',
    'src/../../etc/passwd',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    '\\\\server\\share\\a.ts',
    '\\\\?\\C:\\a.ts',
    'CON',
    'con.txt',
    'COM1',
    'lpt9.log',
    'a:b',
    'file.txt:stream',
    'x.',
    'x ',
    'dir./a.ts',
    'a\u0000b.ts',
    'file:///c:/a.ts',
    'https://example.com/a.ts',
  ]
  for (const path of bad) {
    assert.ok(rejectPathShape(path), `应当拒绝：${JSON.stringify(path)}`)
  }
})

test('接受普通工作区相对路径', () => {
  const good = ['a.ts', 'src/a.ts', 'src//a.ts', './a.ts', 'a/./b.ts', '中文/目录/文件.ts', 'a b/c.d.ts']
  for (const path of good) {
    assert.equal(rejectPathShape(path), undefined, `应当接受：${JSON.stringify(path)}`)
  }
})

test('isInside：同根、子路径、跨根与前缀陷阱', () => {
  assert.equal(isInside('E:\\w', 'E:\\w'), true)
  assert.equal(isInside('E:\\w', 'E:\\w\\a.ts'), true)
  assert.equal(isInside('E:\\w', 'E:\\w\\src\\a.ts'), true)
  assert.equal(isInside('E:\\w', 'E:\\wx\\a.ts'), false)
  assert.equal(isInside('E:\\w', 'E:\\'), false)
  assert.equal(isInside('E:\\w', 'D:\\w\\a.ts'), false)
})

test('pickRoot：按优先级取第一个非空字符串', () => {
  assert.deepEqual(pickRoot({ folder: 'E:\\a' }, 'session.header'), { root: 'E:\\a', via: 'session.header.folder' })
  assert.deepEqual(pickRoot({ cwd: '', root: 'E:\\b' }, 'x'), { root: 'E:\\b', via: 'x.root' })
  assert.equal(pickRoot({}, 'x'), undefined)
  assert.equal(pickRoot(null, 'x'), undefined)
})
