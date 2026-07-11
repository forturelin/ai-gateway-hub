import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldInstallDependencies } from '../bin/ctl.mjs';

test('dependency installation only accepts an explicit y response', () => {
    assert.equal(shouldInstallDependencies('y'), true);
    assert.equal(shouldInstallDependencies('Y'), true);
    assert.equal(shouldInstallDependencies('yes'), false);
    assert.equal(shouldInstallDependencies(''), false);
    assert.equal(shouldInstallDependencies('n'), false);
});
