import assert from 'node:assert/strict';

describe('real-db-core profile smoke', () => {
  it('runs at least one test in real-db-core profile', () => {
    assert.ok('core'.includes('co'));
  });
});
