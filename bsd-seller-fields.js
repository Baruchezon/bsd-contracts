/* Seller agreement field rules. Classic script so the signing page and node tests share it. */
(function (root) {
  'use strict';

  function israeliRegistrationNumber(value) {
    var digits = String(value == null ? '' : value).replace(/\D/g, '');
    return /^\d{9}$/.test(digits) ? digits : '';
  }

  function entityKindLabel(kind) {
    if (kind === 'company' || kind === 'ח.פ.' || kind === 'ח.פ') return 'ח.פ.';
    if (kind === 'osek' || kind === 'עוסק מורשה') return 'עוסק מורשה';
    return '';
  }

  function sellerFieldErrors(fields) {
    var errors = {};
    if (!String((fields && fields.legalName) || '').trim()) {
      errors.legalName = 'יש להקליד את השם המשפטי של העסק';
    }
    if (!israeliRegistrationNumber(fields && fields.idNumber)) {
      errors.idNumber = 'יש להזין 9 ספרות';
    }
    if (!entityKindLabel(fields && fields.idKind)) {
      errors.idKind = 'יש לבחור ח.פ. או עוסק מורשה';
    }
    if (!String((fields && fields.address) || '').trim()) {
      errors.address = 'יש להזין כתובת';
    }
    return errors;
  }

  var api = {
    israeliRegistrationNumber: israeliRegistrationNumber,
    entityKindLabel: entityKindLabel,
    sellerFieldErrors: sellerFieldErrors
  };
  root.BsdSellerFields = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
