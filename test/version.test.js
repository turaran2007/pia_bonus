import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVersion } from '../src/version.js';

test('バージョンの表示', () => {
  assert.equal(formatVersion('2.1.0', '821ac1c51bed14af2eaa93cdb2ee89505207183a'), 'v2.1.0 (821ac1c)');
  assert.equal(formatVersion('2.1.0', ''), 'v2.1.0');
  assert.equal(formatVersion('2.1.0', undefined), 'v2.1.0');
  assert.equal(formatVersion('2.1.0', 'not-a-sha'), 'v2.1.0');
});
