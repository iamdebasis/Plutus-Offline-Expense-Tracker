// Which of your card pictures (data/card-art/) goes on which card. Made-up banks and cards only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artFor } from '../src/lib/cardArt'

const pictures = ['fake-bank--rewards.jpg', 'Fake-Bank--Rewards-Plus.PNG', 'fake-bank.webp', 'other-bank--rewards.jpg']

test("a card gets its own picture, the bank's when only the bank is named, and never another card's", () => {
  assert.equal(artFor({ issuer: 'Fake Bank', product: 'Rewards' }, pictures), 'fake-bank--rewards.jpg')
  assert.equal(artFor({ issuer: 'Fake Bank', product: 'Rewards Plus Card' }, pictures), 'Fake-Bank--Rewards-Plus.PNG')
  assert.equal(artFor({ issuer: 'Fake Bank', product: 'RewardsPlus' }, pictures), 'Fake-Bank--Rewards-Plus.PNG')
  assert.equal(artFor({ issuer: 'Fake Bank', product: null }, pictures), 'fake-bank.webp')
  assert.equal(artFor({ issuer: 'Fake Bank', product: 'Platinum' }, pictures), null)
  assert.equal(artFor({ issuer: 'Third Bank', product: null }, pictures), null)
  assert.equal(artFor({ issuer: null, product: 'Rewards' }, pictures), null)
  assert.equal(artFor({ issuer: 'Fake Bank', product: null }, []), null)
})
