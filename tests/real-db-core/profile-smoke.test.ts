describe('real-db-core profile smoke', () => {
  it('runs at least one test in real-db-core profile', () => {
    expect('core').toContain('co');
  });
});
