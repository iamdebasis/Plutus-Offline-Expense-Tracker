// How long reading your files takes, from the server's own times: a run starts when its first file joined the queue
// and ends when its last finished (the local AI's step included). A re-read at startup counts from when it was queued,
// not from an upload days ago; a run with a file whose times weren't kept has no clock rather than a wrong one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clock, fileTime, runTime, spoken, took } from '../src/lib/readingTime'
import type { UploadRecord } from '../src/types'

const at = (hms: string) => `2026-10-16T${hms}+05:30`
const t = (hms: string) => Date.parse(at(hms))
function file(state: 'queued' | 'running' | 'done' | 'failed' | 'skipped', times: { queued?: string; started?: string; finished?: string; uploaded?: string } = {}): UploadRecord {
  return {
    id: `upl_${Math.random().toString(16).slice(2, 14)}`,
    uploadedAt: times.uploaded ?? at(times.queued ?? '10:00:00'),
    importStatus: {
      state, step: null, method: null, found: 0, added: 0, duplicates: 0, needsReview: 0, error: null,
      queuedAt: times.queued ? at(times.queued) : null,
      startedAt: times.started ? at(times.started) : null,
      finishedAt: times.finished ? at(times.finished) : null,
    },
  } as UploadRecord
}

test('the running clock: minutes and seconds, then hours', () => {
  assert.deepEqual([0, 7_000, 59_999, 252_000, 3_852_000, -5_000].map(clock), ['0:00', '0:07', '0:59', '4:12', '1:04:12', '0:00'])
})

test('a finished time in words, and as a screen reader says it', () => {
  assert.deepEqual([400, 7_000, 240_000, 252_000, 3_852_000, 7_200_000].map(took), ['under a second', '7s', '4m', '4m 12s', '1h 4m', '2h'])
  assert.deepEqual([0, 61_000, 252_000, 3_852_000].map(spoken), ['0 seconds', '1 minute 1 second', '4 minutes 12 seconds', '1 hour 4 minutes 12 seconds'])
})

test('a run counts from its first file joining the queue; while reading it has no end', () => {
  const run = runTime([file('done', { queued: '10:00:00', started: '10:00:01', finished: '10:01:00' }), file('running', { queued: '10:00:30', started: '10:01:00' })])
  assert.deepEqual(run, { start: t('10:00:00'), end: null })
})

test('finished: it ends when its last file did, the local AI step included, whatever order they finished in', () => {
  const run = runTime([file('done', { queued: '10:00:00', started: '10:00:01', finished: '10:04:12' }), file('failed', { queued: '10:00:00', started: '10:00:02', finished: '10:00:09' })])
  assert.deepEqual(run, { start: t('10:00:00'), end: t('10:04:12') })
})

test('a file added mid-run doesn’t restart the clock', () => {
  const run = runTime([file('done', { queued: '10:00:00', started: '10:00:01', finished: '10:02:00' }), file('done', { queued: '10:01:30', started: '10:02:00', finished: '10:03:00' })])
  assert.deepEqual(run, { start: t('10:00:00'), end: t('10:03:00') })
})

test('a file re-read at startup counts from when it was queued, not from when it was uploaded days ago', () => {
  const run = runTime([file('done', { uploaded: '2026-10-01T09:00:00+05:30', queued: '10:00:00', started: '10:00:01', finished: '10:00:20' })])
  assert.deepEqual(run, { start: t('10:00:00'), end: t('10:00:20') })
})

test('no clock rather than a wrong one: a file whose times weren’t kept, or nothing to read', () => {
  assert.equal(runTime([file('done', { queued: '10:00:00', started: '10:00:01', finished: '10:01:00' }), file('done', { finished: '09:00:00' })]), null)
  assert.equal(runTime([]), null)
})

test('each file’s own reading time: from its start to its finish', () => {
  assert.equal(fileTime(file('done', { queued: '10:00:00', started: '10:00:10', finished: '10:00:48' })), 38_000)
  assert.equal(fileTime(file('running', { queued: '10:00:00', started: '10:00:10' })), null)
  assert.equal(fileTime(file('done', { finished: '10:00:48' })), null)
})
