import assert from 'node:assert/strict';

describe('fast profile smoke', () => {
  it('runs at least one test in fast profile', () => {
    assert.equal(1 + 1, 2);
  });
});
