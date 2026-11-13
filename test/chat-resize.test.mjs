import assert from 'node:assert/strict'
import { clampChatWidth, CHAT_MIN_WIDTH } from '../src/chat-resize.js'

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

test('面板够宽时按指针值走', () => {
  assert.equal(clampChatWidth(520, 1200), 520)
})

test('低于最小值就夹到 240', () => {
  assert.equal(clampChatWidth(80, 1200), CHAT_MIN_WIDTH)
  assert.equal(clampChatWidth(-30, 1200), CHAT_MIN_WIDTH)
})

test('拉满时给左侧留 40px', () => {
  assert.equal(clampChatWidth(1200, 1200), 1160)
  assert.equal(clampChatWidth(5000, 800), 760)
})

test('面板比最小值还窄时仍返回最小值', () => {
  assert.equal(clampChatWidth(180, 200), CHAT_MIN_WIDTH)
})

test('拿不到面板宽度时只夹最小值', () => {
  assert.equal(clampChatWidth(300, 0), 300)
  assert.equal(clampChatWidth(100, undefined), CHAT_MIN_WIDTH)
})

test('非数字指针值退回最小值', () => {
  assert.equal(clampChatWidth(Number.NaN, 1000), CHAT_MIN_WIDTH)
  assert.equal(clampChatWidth(undefined, 1000), CHAT_MIN_WIDTH)
})

test('结果取整，避免半像素抖动', () => {
  assert.equal(clampChatWidth(300.6, 1000), 301)
})

console.log(`\n${passed} passed`)
