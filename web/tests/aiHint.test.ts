// The one-time hint about the local AI: only after an import leaves something waiting, only while there's no local AI
// to handle it, and never again once answered.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hintText, shouldHint } from '../src/lib/aiHint'
import type { LlmStatus } from '../src/types'

const status = (over: Partial<LlmStatus> = {}): LlmStatus => ({
  state: 'unavailable',
  model: null,
  installed: false,
  modelInstalled: false,
  loaded: false,
  server: null,
  sleepsIn: null,
  idleSeconds: 90,
  hintSeen: false,
  ...over,
})
const waiting = { reading: false, toReview: 14, onHold: 0 }

test('shows once an import has left payees or a statement waiting and nothing can handle them', () => {
  assert.equal(shouldHint(waiting, status()), true)
  assert.equal(shouldHint({ reading: false, toReview: 0, onHold: 1 }, status()), true)
  // Ollama there, but the model Plutus would use isn't downloaded
  assert.equal(shouldHint(waiting, status({ state: 'asleep', model: 'fake-model:1b', installed: true, modelInstalled: false })), true)
})

test("never while reading, with nothing waiting, with a local AI set up, or once you've answered it", () => {
  assert.equal(shouldHint({ ...waiting, reading: true }, status()), false)
  assert.equal(shouldHint({ reading: false, toReview: 0, onHold: 0 }, status()), false)
  assert.equal(shouldHint(waiting, status({ state: 'asleep', model: 'fake-model:1b', installed: true, modelInstalled: true })), false)
  assert.equal(shouldHint(waiting, status({ hintSeen: true })), false)
  assert.equal(shouldHint(null, status()), false)
  assert.equal(shouldHint(waiting, null), false)
})

test('says what is waiting', () => {
  assert.equal(hintText(waiting), '14 payees need your eyes. A local AI on this Mac could handle them for you.')
  assert.equal(hintText({ reading: false, toReview: 1, onHold: 1 }),
    '1 payee needs your eyes and 1 statement is on hold. A local AI on this Mac could handle them for you.')
  assert.equal(hintText({ reading: false, toReview: 0, onHold: 1 }), '1 statement is on hold. A local AI on this Mac could handle it for you.')
})
