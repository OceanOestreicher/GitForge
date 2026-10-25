const { test, expect } = require('@playwright/test');
const { Message, addData } = require('../dist-electron/messages.cjs');

test('static messages are retrieved by key and dynamic messages fill numbered data points', () => {
  expect(Message['branch.name.required']).toBe('Enter a branch name.');
  expect(addData(Message['repository.create.failed'], 'Access denied', 'C:\\Repos\\demo'))
    .toBe('Repository creation failed: Access denied. Check C:\\Repos\\demo before trying again.');
  expect(addData(Message['github.verificationFailed'], 503))
    .toBe('GitHub could not verify this profile (HTTP 503). Check GitHub service status and try again.');
});

test('message data supports repeated and multi-digit placeholders and preserves missing data', () => {
  expect(addData('{0} / {0} / {10}', ...Array.from({ length: 11 }, (_, index) => index)))
    .toBe('0 / 0 / 10');
  expect(addData('{0}:{1}:{2}:{3}', '', 0, false)).toBe(':0:false:{3}');
  expect(addData(Message['branch.name.required'])).toBe('Enter a branch name.');
});

test('dynamic data is inserted literally without interpreting dollar signs or nested placeholders', () => {
  expect(addData('{0} and {1}', '$& {1}', 'final')).toBe('$& {1} and final');
});
