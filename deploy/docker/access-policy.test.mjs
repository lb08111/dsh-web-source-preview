import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedBrowserRequest } from './access-policy.mjs'

const publicUrl = new URL('http://10.191.6.47:8088')
const request = (headers = {}, method = 'GET') => ({
  method,
  headers: { host: publicUrl.host, ...headers },
})

test('allows direct browser entry', () => {
  assert.equal(isAllowedBrowserRequest(request({ 'sec-fetch-site': 'none' }), publicUrl, '/'), true)
})

test('allows a cross-site top-level browser navigation to the DSH entry', () => {
  assert.equal(isAllowedBrowserRequest(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  }), publicUrl, '/'), true)
})

test('keeps rejecting cross-site iframes', () => {
  assert.equal(isAllowedBrowserRequest(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'iframe',
  }), publicUrl, '/'), false)
})

test('keeps rejecting cross-site API calls and unsafe methods', () => {
  assert.equal(isAllowedBrowserRequest(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }), publicUrl, '/api/state'), false)
  assert.equal(isAllowedBrowserRequest(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  }, 'POST'), publicUrl, '/'), false)
})

test('keeps rejecting foreign hosts and origins', () => {
  assert.equal(isAllowedBrowserRequest({ method: 'GET', headers: { host: 'evil.example' } }, publicUrl, '/'), false)
  assert.equal(isAllowedBrowserRequest(request({ origin: 'https://evil.example' }), publicUrl, '/'), false)
})
