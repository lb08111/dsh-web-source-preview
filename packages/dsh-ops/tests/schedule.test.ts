/**
 * Cron contract: the parser rejects malformed expressions, the next-run
 * resolver works in an explicit zone, and Vixie day semantics combine
 * day-of-month with weekday by OR when both are restricted.
 */

import { describe, expect, it } from 'vitest'
import { isValidCron, nextRunAtMs, parseCron } from '../src/schedule.ts'

describe('cron schedule', () => {
  it('operator parsing a valid expression sees the expected match sets', () => {
    // Given a stepped hour range and a weekday range
    const parsed = parseCron('*/15 9-18 * * 1-5')

    // When parsing it
    // Then minutes step by 15, hours cover 9..18 and weekdays 1..5
    expect(parsed).toEqual(expect.objectContaining({
      minutes: new Set([0, 15, 30, 45]),
      hours: new Set([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
      weekdays: new Set([1, 2, 3, 4, 5]),
    }))
  })

  it('operator typing a malformed expression is told it is invalid', () => {
    // Given malformed expressions
    // When checking them
    // Then they are rejected instead of silently matching everything
    expect(isValidCron('* * *')).toBe(false)
    expect(isValidCron('61 * * * *')).toBe(false)
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
  })

  it('operator with an every-minute schedule sees the next minute boundary in UTC', () => {
    // Given a fixed instant at 10:30:15 UTC
    const from = Date.UTC(2026, 0, 1, 10, 30, 15)

    // When resolving the next run in UTC
    const next = nextRunAtMs('* * * * *', from, 'UTC')

    // Then it is 10:31:00 UTC
    expect(next).toBe(Date.UTC(2026, 0, 1, 10, 31, 0))
  })

  it('operator scheduling 09:00 in Asia/Shanghai sees the UTC instant for that wall clock', () => {
    // Given midnight UTC on 2026-01-01 (08:00 in Shanghai)
    const from = Date.UTC(2026, 0, 1, 0, 0, 0)

    // When resolving a 09:00 daily schedule in Shanghai
    const next = nextRunAtMs('0 9 * * *', from, 'Asia/Shanghai')

    // Then it is 01:00 UTC (09:00 CST)
    expect(next).toBe(Date.UTC(2026, 0, 1, 1, 0, 0))
  })

  it('operator restricting both day fields sees Vixie OR semantics', () => {
    // Given Friday 2026-01-02 UTC and the expression "1st of month OR Monday"
    const from = Date.UTC(2026, 0, 2, 0, 0, 0)

    // When resolving the next run
    const next = nextRunAtMs('0 0 1 * 1', from, 'UTC')

    // Then the earlier of the two matches wins: Monday 2026-01-05
    expect(next).toBe(Date.UTC(2026, 0, 5, 0, 0, 0))
  })
})
