import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const api = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'bsd-seller-fields.js'));

const GERESH = "מאפיית ג׳וזף";
const GERSHAYIM = "ג'ירפה בע״מ";

test('a legal name with geresh or gershayim is accepted as typed', () => {
  for (const name of [GERESH, GERSHAYIM, "בעמ ג'ו"]) {
    const errors = api.sellerFieldErrors({
      legalName: name,
      idNumber: '514172036',
      idKind: 'company',
      address: 'הרצל 1',
    });
    assert.deepEqual(errors, {});
    assert.equal(name.includes('׳') || name.includes("'") || name.includes('״'), true);
  }
});

test('invalid company numbers are rejected', () => {
  for (const id of ['', '12345678', '1234567890', '12-345', 'abcdefgh', '1234 5678']) {
    const errors = api.sellerFieldErrors({
      legalName: GERESH,
      idNumber: id,
      idKind: 'osek',
      address: 'רחוב 1',
    });
    assert.equal(errors.idNumber, 'יש להזין 9 ספרות', id);
  }
});

test('separators are fine when nine digits remain, and address and kind are required', () => {
  assert.equal(api.israeliRegistrationNumber('51-417-2036'), '514172036');
  assert.equal(api.entityKindLabel('osek'), 'עוסק מורשה');
  const missing = api.sellerFieldErrors({ legalName: '  ', idNumber: '514172036', idKind: '', address: '' });
  assert.ok(missing.legalName);
  assert.ok(missing.idKind);
  assert.ok(missing.address);
  assert.equal(missing.idNumber, undefined);
});
