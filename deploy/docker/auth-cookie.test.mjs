import assert from 'node:assert/strict'
import test from 'node:test'
import { relaxAuthCookieSameSite } from './auth-cookie.mjs'

const authCookie = 'dsh-auth-example=value; Max-Age=86400; Path=/; Expires=Tue, 24 Nov 2026 01:00:00 GMT; HttpOnly; SameSite=Strict'

test('relaxes only the DSH authentication cookie SameSite policy', () => {
  const [cookie] = relaxAuthCookieSameSite([authCookie])
  assert.match(cookie, /; SameSite=Lax$/)
  assert.doesNotMatch(cookie, /SameSite=Strict/i)
  assert.match(cookie, /; HttpOnly;/)
  assert.match(cookie, /; Path=\//)
  assert.match(cookie, /; Expires=/)
})

test('preserves Secure when the cookie arrives through HTTPS', () => {
  const [cookie] = relaxAuthCookieSameSite([`${authCookie}; Secure`])
  assert.match(cookie, /; SameSite=Lax; Secure$/)
})

test('leaves every non-authentication cookie unchanged', () => {
  const other = 'session=value; Path=/; HttpOnly; SameSite=Strict'
  assert.deepEqual(relaxAuthCookieSameSite([other]), [other])
})

test('leaves already-relaxed and absent headers unchanged', () => {
  const relaxed = 'dsh-auth-example=value; Path=/; HttpOnly; SameSite=Lax'
  assert.deepEqual(relaxAuthCookieSameSite([relaxed]), [relaxed])
  assert.equal(relaxAuthCookieSameSite(undefined), undefined)
})
