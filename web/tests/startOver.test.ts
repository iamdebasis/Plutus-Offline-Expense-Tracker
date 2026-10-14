// Start over leaves nothing of yours in the browser: the page forgets what it kept there (how its panels were left,
// which includes your cards' ids), and every other open tab of Plutus hears of it and loads again, empty, while the
// tab you started over in keeps its "done" dialog.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forgetThisBrowser, tellOtherTabs, whenStartedOverElsewhere } from '../src/lib/startOver'

/** A browser's storage, as far as the page uses it. */
function storage(entries: Record<string, string>) {
  const items = new Map(Object.entries(entries))
  return {
    get length() {
      return items.size
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    removeItem: (k: string) => void items.delete(k),
    keys: () => [...items.keys()],
  }
}

test('the page forgets everything it kept in this browser, and nothing of anyone else', () => {
  const kept = storage({ 'plutus.review.collapsed': '1', 'plutus.cardTrends.ticked': '["card-fake-bank-1111"]', 'plutus.trends.ticked': '[]', 'another-app.theme': 'dark' })
  assert.equal(forgetThisBrowser(kept), 3)
  assert.deepEqual(kept.keys(), ['another-app.theme'])
  assert.equal(forgetThisBrowser(null), 0) // a browser that keeps nothing for the page
})

test('every other open tab hears of it; the tab that started over does not', async () => {
  const here: string[] = []
  const stop = whenStartedOverElsewhere(() => here.push('heard'))
  const elsewhere = new BroadcastChannel('plutus') // another tab of Plutus
  try {
    const told = new Promise((resolve) => (elsewhere.onmessage = (e) => resolve(e.data)))
    tellOtherTabs()
    assert.equal((await told as { kind: string }).kind, 'started over', 'the other tab is told')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(here, [], 'this tab ignores its own news: its dialog stays')
    elsewhere.postMessage({ kind: 'started over', from: 'another tab' })
    elsewhere.postMessage({ kind: 'something else', from: 'another tab' })
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(here, ['heard'], 'and hears another tab starting over, and only that')
  } finally {
    stop() // an open channel would keep the tests running
    elsewhere.close()
  }
})
